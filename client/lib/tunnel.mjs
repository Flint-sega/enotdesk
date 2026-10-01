// Каркас TCP-туннеля в machine-сеансе (ADR 0028; v0.6 = модуль + ADR + тесты,
// БЕЗ UI и без подключения в диспетчер каналов). Прецедент — терминал
// (client/lib/term.mjs, ADR 0021): DC-канал поверх утверждённого сеанса, лимиты
// и честные отказы вместо фейкового успеха. Протокол по образцу file-transfer:
// control — JSON-строки, данные — бинарные чанки тем же каналом.
//
// Агентская сторона (host): по ch.onopen канал ждёт control
// {type:'open', target:'host:port'}; target строго по allowlist (дефолт —
// loopback RDP/SSH; список машины — env ENOT_TUNNEL_ALLOWLIST, парсит
// диспетчер следующего цикла, сюда приходит уже разобранный массив). Успех →
// netFactory(host, port) (прод — net.connect, тесты — инъекция, шов как
// фейк-PTY у term) → насос binary DC ↔ socket. Socket close/error → честный
// кадр и ch.close(); DC close → socket.destroy(). Лимиты: 1 туннель на канал
// (tunnel_busy) и maxTunnels на host-сторону.
//
// Операторская сторона сознательно отложена (ADR 0028): браузер не умеет
// слушать TCP-порты; desktop-оператор с machine-сеансами ещё не существует,
// серверный TCP-релей ломает ADR 0014 («релей не расширяется»). Открытый
// вопрос — фиксируется в ADR до включения UI.
//
// Backpressure socket→DC в каркасе нет: клапан — очередь моста агента (≤1 МБ).
// Для TCP-потока переполнение означает повреждение потока, поэтому настоящий
// backpressure — обязательный пункт операторского цикла (ADR 0028).

import net from 'node:net';

// Цели по умолчанию: только loopback. Расширение списка — осознанное действие
// администратора машины через ENOT_TUNNEL_ALLOWLIST, не умолчание.
export const DEFAULT_TUNNEL_TARGETS = ['127.0.0.1:3389', '127.0.0.1:22'];
// Крупнее этого DC-чанк не ходит: не «потерять байт молча», а честно разорвать
// туннель кадром ошибки (для TCP-стрима тихая потеря = порча потока).
export const TUNNEL_MAX_CHUNK = 256 * 1024;

// Хост цели: IPv4/hostname. Слэши, пробелы и прочее — отказ парсера.
const HOST_RE = /^[A-Za-z0-9._-]+$/;

// Цель 'host:port'. IPv6 (несколько ':') не поддержан в v0.6 — честный null,
// не угадывание; расширение не ломает протокол (ADR 0028).
export function parseTunnelTarget(raw) {
  if (typeof raw !== 'string') return null;
  const sep = raw.lastIndexOf(':');
  if (sep <= 0 || sep !== raw.indexOf(':')) return null; // нет порта или IPv6-вид
  const host = raw.slice(0, sep);
  const portStr = raw.slice(sep + 1);
  if (!HOST_RE.test(host) || !/^\d{1,5}$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

// Элемент allowlist: 'host:port' фиксирует порт, 'host' — любой валидный порт.
function parseAllowEntry(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw.includes(':')) return HOST_RE.test(raw) ? { host: raw, port: null } : null;
  return parseTunnelTarget(raw);
}

// Строгая проверка цели: host обязан совпасть с элементом allowlist (сравнение
// без учёта регистра — hostname, не путь); элемент с портом фиксирует порт.
export function targetAllowed(target, allowedTargets) {
  const t = parseTunnelTarget(target);
  if (!t) return false;
  const host = t.host.toLowerCase();
  const list = Array.isArray(allowedTargets) ? allowedTargets : [];
  return list.some((entry) => {
    const e = parseAllowEntry(entry);
    return !!e && e.host.toLowerCase() === host && (e.port == null || e.port === t.port);
  });
}

// Прод-соединение; в тестах заменяется инъекцией (фейковые сокеты).
function defaultNetFactory(host, port) {
  return net.connect({ host, port });
}

// Host-сторона DC-канала `tunnel`. Контракт сокета (net.Socket покрывает):
// write(data), on('data'|'error'|'close', cb), destroy().
//
// Протокол канала:
//   оператор → host: {type:'open', target:'host:port'} | {type:'close'} |
//              бинарные чанки (данные туннеля)
//   host → оператор: {type:'opened', target} | {type:'error', code} |
//          {type:'close'} | бинарные чанки (данные туннеля)
// Коды ошибок: target_not_allowed (мимо allowlist), tunnel_busy (слот занят),
// connect_failed (netFactory бросил/вернул не сокет), ECONNREFUSED и пр. —
// честный err.code сокета, chunk_too_large, socket_error (код неизвестен).
export function createTunnelHost({
  allowedTargets = DEFAULT_TUNNEL_TARGETS,
  netFactory = defaultNetFactory,
  maxTunnels = 1,
} = {}) {
  const live = new Set(); // активные туннели всех каналов {sock, target, ch}

  function handleChannel(ch) {
    // Лимит host-стороны: новый канал при полном наборе отклоняется целиком
    // (по образцу term: error + close, handleChannel → false).
    if (live.size >= maxTunnels) {
      try { ch.send(JSON.stringify({ type: 'error', code: 'tunnel_busy' })); } catch { /* не уйдёт — закрываем */ }
      try { ch.close(); } catch { /* уже закрыт */ }
      return false;
    }
    let tunnel = null;

    const sendCtl = (obj) => {
      try { ch.send(JSON.stringify(obj)); } catch { /* канал умирает — teardown догонит */ }
    };

    // Разовый снос: освободить слот, убить сокет; sendClose — послать ли кадр
    // {type:'close'} (не посылаем при обрыве самого канала — кадр не нужен
    // мёртвому получателю).
    function teardown(sendClose) {
      if (!tunnel) return;
      const t = tunnel;
      tunnel = null;
      live.delete(t);
      try { t.sock.destroy(); } catch { /* уже мёртв */ }
      if (ch.readyState !== 'open') return;
      if (sendClose) sendCtl({ type: 'close' });
      try { ch.close(); } catch { /* уже закрыт */ }
    }

    function doOpen(msg) {
      // Канал однотуннельный: второй open — честный отказ, канал живёт.
      if (tunnel) { sendCtl({ type: 'error', code: 'tunnel_busy' }); return; }
      // Слот мог занять параллельный канал между handleChannel и open.
      if (live.size >= maxTunnels) { sendCtl({ type: 'error', code: 'tunnel_busy' }); return; }
      if (!targetAllowed(msg.target, allowedTargets)) {
        sendCtl({ type: 'error', code: 'target_not_allowed' });
        return; // канал открыт — оператор может исправить target без ренеготиации
      }
      const { host, port } = parseTunnelTarget(msg.target);
      let sock = null;
      try { sock = netFactory(host, port); } catch { sendCtl({ type: 'error', code: 'connect_failed' }); return; }
      if (!sock || typeof sock.write !== 'function' || typeof sock.on !== 'function'
          || typeof sock.destroy !== 'function') {
        sendCtl({ type: 'error', code: 'connect_failed' });
        return;
      }
      tunnel = { sock, target: msg.target, ch };
      live.add(tunnel);
      // 'opened' = туннель открыт, TCP-соединение устанавливается; ошибка
      // соединения придёт отдельным кадром error (честный err.code).
      sendCtl({ type: 'opened', target: msg.target });

      sock.on('data', (chunk) => {
        if (!tunnel || tunnel.sock !== sock) return;
        if (ch.readyState !== 'open') { teardown(false); return; }
        if (chunk && chunk.byteLength > TUNNEL_MAX_CHUNK) {
          sendCtl({ type: 'error', code: 'chunk_too_large' });
          teardown(false);
          return;
        }
        try { ch.send(chunk); } catch { teardown(false); }
      });
      sock.on('error', (err) => {
        if (!tunnel || tunnel.sock !== sock) return;
        const code = err && typeof err.code === 'string' && err.code ? err.code : 'socket_error';
        sendCtl({ type: 'error', code });
        teardown(false); // кадр close после error не шлём — причина уже названа
      });
      sock.on('close', () => {
        if (!tunnel || tunnel.sock !== sock) return;
        teardown(true);
      });
    }

    ch.onmessage = (m) => {
      if (typeof m?.data === 'string') {
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; } // не-JSON игнорируется (allowlist)
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'open') doOpen(msg);
        else if (msg.type === 'close') teardown(true);
        // прочие типы не проходят allowlist
        return;
      }
      const bytes = m?.data instanceof ArrayBuffer ? new Uint8Array(m.data) : m?.data;
      // бинарные чанки — только данные туннеля; до open / без туннеля — тишина
      if (tunnel && bytes) {
        try { tunnel.sock.write(bytes); } catch { teardown(false); }
      }
    };
    ch.onclose = () => teardown(false);
    return true;
  }

  return {
    handleChannel,
    get activeCount() { return live.size; },
    // Завершение сеанса/остановка агента рвёт живые туннели (шов как у term):
    // сокеты уничтожаются, их обработчики close сами сносят каналы с кадром.
    close() {
      for (const t of [...live]) {
        try { t.sock.destroy(); } catch { /* уже мёртв */ }
      }
    },
  };
}

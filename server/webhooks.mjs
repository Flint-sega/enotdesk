import crypto from 'node:crypto';
import { encryptSecret, decryptSecret, secretKeyBytes } from './totp.mjs';

// Webhooks (D1): доставка событий сеансов на внешний URL self-hostера.
// Тело POST — {event, payload, ts}; подпись X-Enot-Signature: hex(HMAC-SHA256(secret, body)).
// Доставка асинхронная: emit возвращает промис, который вызывающий код сеансов
// не ждёт, — сбой доставки никогда не блокирует сеанс. Ретраи 3× (1с/10с/60с),
// потом событие бросается.
// Секрет шифруется AES-256-GCM от ENOT_SECRET_KEY (хелперы totp.mjs, формат
// 'v1:base64(iv|tag|ct)'); старые plaintext-значения читаются как есть. Секрет
// не покидает модуль: наружное состояние маскирует его, в логи он не пишется.
// Без ключа настройка честно отказывает (bad_key) — подписывать нечем хранить.

// события, на которые можно подписаться (единый allowlist)
export const WEBHOOK_EVENTS = ['session.started', 'session.ended', 'machine.claim.denied'];

const RETRY_DELAYS_MS = [1000, 10_000, 60_000];
const URL_MAX = 2048;
const SECRET_MAX = 256;
const MASK = '********';
const KEY_HINT = 'Задайте ENOT_SECRET_KEY (например, в .env сервера) — им шифруется секрет webhooks';

export function createWebhooks(db, {
  fetchImpl = (...args) => globalThis.fetch(...args),
  nowMs = Date.now,
  retryDelays = RETRY_DELAYS_MS,
  log = (message) => console.error(message),
  secretKey = '',
} = {}) {
  const keyBytes = secretKeyBytes(secretKey); // null — ключ не задан

  const row = () => db.prepare('SELECT url, secret, events FROM webhook_settings WHERE id = 1').get() || null;

  function eventsOf(raw) {
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  // Секрет из БД: v1-шифтекст расшифровывается ключом, legacy-plaintext читается
  // как есть. null — расшифровать нечем (чужой/отсутствующий ключ, порча).
  const storedSecret = (stored) => decryptSecret(keyBytes, stored);

  function sign(body, secret) {
    return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  }

  // unref: зависшие ретраи не держат процесс при завершении сервера
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

  async function attempt(url, secret, body) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enot-Signature': sign(body, secret) },
        body,
      });
      return !!res?.ok; // не-2xx — тоже сбой доставки
    } catch { return false; } // сетевой сбой — ретрай, наружу не бросается
  }

  async function deliver(url, secret, body, event) {
    for (let i = 0; i <= retryDelays.length; i++) {
      if (i > 0) await sleep(retryDelays[i - 1]);
      if (await attempt(url, secret, body)) return true;
    }
    // в журнал идут только имя события и счёт попыток — ни URL, ни секрета, ни тела
    log(`webhook: событие «${event}» не доставлено после ${retryDelays.length + 1} попыток`);
    return false;
  }

  // Доставить событие. Возвращает промис (true — доставлено), который вызывающий
  // код вправе не ждать: сеансы от результата доставки не зависят.
  function emit(event, payload) {
    const r = row();
    if (!r || !r.url || !r.secret) return Promise.resolve(false);
    const secret = storedSecret(r.secret);
    if (secret == null) {
      // чужой или отсутствующий ключ: подписать нечем — честный отказ без POST
      log(`webhook: событие «${event}» не отправлено — секрет не расшифрован, проверьте ENOT_SECRET_KEY`);
      return Promise.resolve(false);
    }
    const events = eventsOf(r.events);
    if (events.length > 0 && !events.includes(event)) return Promise.resolve(false);
    const body = JSON.stringify({ event, payload, ts: new Date(nowMs()).toISOString() });
    return deliver(r.url, secret, body, event);
  }

  // Настроить доставку: url === '' — выключить. events — список WEBHOOK_EVENTS
  // или null/[] (все события). Ошибки возвращаются кодом, не исключением.
  function configure(url, secret, events = null) {
    const u = String(url ?? '').trim();
    const s = String(secret ?? '');
    if (u === '') {
      db.prepare('DELETE FROM webhook_settings WHERE id = 1').run();
      return { ok: true, configured: false, url: '', events: [] };
    }
    if (u.length > URL_MAX) return { ok: false, error: 'url_too_long' };
    let parsed;
    try { parsed = new URL(u); } catch { return { ok: false, error: 'bad_url' }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, error: 'bad_url' };
    if (!keyBytes) {
      log(`webhook: настройка отклонена — ${KEY_HINT}`);
      return { ok: false, error: 'bad_key', hint: KEY_HINT };
    }
    if (!s) return { ok: false, error: 'secret_required' };
    if (s.length > SECRET_MAX) return { ok: false, error: 'secret_too_long' };
    const list = Array.isArray(events)
      ? [...new Set(events.filter((e) => WEBHOOK_EVENTS.includes(e)))]
      : [];
    // в БД — только шифротекст; plaintext живёт секунду в памяти вызова
    db.prepare(`
      INSERT INTO webhook_settings (id, url, secret, events) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET url = excluded.url, secret = excluded.secret, events = excluded.events
    `).run(u, encryptSecret(keyBytes, s), JSON.stringify(list));
    return { ok: true, configured: true, url: u, events: list };
  }

  // Наружное состояние: секрет маскируется, настоящие данные не покидают модуль.
  function get() {
    const r = row();
    if (!r || !r.url) return { configured: false, url: '', events: [], secret: '' };
    return { configured: true, url: r.url, events: eventsOf(r.events), secret: r.secret ? MASK : '' };
  }

  return { emit, configure, get };
}

// Цикл unattended-агента (headless-режим того же клиента): onboarding-код →
// POST /agent/register → токен машины (память процесса + store из policy;
// в main store — файл в userData) → WS host-роль → heartbeat. Обрыв —
// экспоненциальный backoff с потолком и бесконечными повторами той же парой
// sessionId+токен (грейс ADR 0013); отзыв токена — честный статус 'revoked'
// без повторов. Политику сеанса (причина, PIN) проверяет сервер до claim —
// агент только подтверждает allow. Electron-независимый шов §2 (interfaces.md):
// api/signal/native вводятся снаружи, поэтому цикл тестируется на фейках.

import nodeDgram from 'node:dgram';
import { createInputGate } from './protocol.mjs';
import { createInputArbiter, participantsMessage, parseControlMessage } from './input-arbiter.mjs';
import { createWakeSender } from './wol.mjs';
import { parseChatMessage, chatMessage } from './chat.mjs';

// HTTP-клиент агента: /agent/* плюс host-решение по сеансу. Токен машины
// передаётся в каждый вызов и нигде не кэшируется здесь — им владеет цикл.
export function createAgentApi({ baseUrl, fetchImpl = fetch } = {}) {
  const base = String(baseUrl ?? '').replace(/\/$/, '') + '/api/v1';
  async function call(path, { method = 'GET', token, body } = {}) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`Сервер недоступен: ${e?.cause?.code ?? e.message}`, { cause: e });
    }
    let json = null;
    try { json = await res.json(); } catch { /* не-JSON — тело null */ }
    return { status: res.status, body: json };
  }
  return {
    register: ({ code, name, os, version }) => call('/agent/register', { method: 'POST', body: { code, name, os, version } }),
    session: (token) => call('/agent/session', { token }),
    heartbeat: (token, inventory, toastResult, wakeResult) => call('/agent/heartbeat', {
      method: 'POST',
      token,
      // без инвентаря и результатов — тело не отправляется вовсе (старые серверы не заметят)
      ...((inventory !== undefined || toastResult !== undefined || wakeResult !== undefined) ? {
        body: {
          ...(inventory !== undefined ? { inventory } : {}),
          ...(toastResult !== undefined ? { toastResult } : {}),
          ...(wakeResult !== undefined ? { wakeResult } : {}),
        },
      } : {}),
    }),
    rtcConfig: (token) => call('/rtc-config', { token }),
    decision: ({ sessionId, token, claimId, allow }) => call(`/sessions/${encodeURIComponent(String(sessionId))}/decision`, { method: 'POST', token, body: { claimId, allow } }),
  };
}

function memoryTokenStore() {
  let t = null;
  return { load: () => t, save: (v) => { t = v; }, clear: () => { t = null; } };
}

// Runtime-подключение TURN для терминала моста (R09): хук для createBridgeRelay
// достаёт iceServers через GET /rtc-config с машинным (host-)токеном — сервер
// принимает его при живом сеансе, а терминал открывается только в approved.
// Нет токена / не-200 / неверное тело — честный throw: релей сам деградирует
// в iceServers:[] с причиной, пустой список проходит (TURN не настроен).
export function createIceServersFetcher({ api, tokenLoad, timeoutMs = 5000 }) {
  if (!api || typeof api.rtcConfig !== 'function' || typeof tokenLoad !== 'function') {
    throw new Error('createIceServersFetcher: нужны api (rtcConfig) и tokenLoad');
  }
  const ms = Math.max(1, Number(timeoutMs) || 5000);
  return async function fetchIceServers() {
    const token = tokenLoad();
    if (!token) throw new Error('токена машины ещё нет');
    // Дедлайн (craft-ревью R09): зависший fetch навсегда держит
    // setRemoteDescription моста — offer не уйдёт и FAIL не придёт. Не успели —
    // честный пустой список с причиной, терминал открывается по LAN.
    return Promise.race([
      (async () => {
        const r = await api.rtcConfig(token);
        if (r.status !== 200 || !Array.isArray(r.body?.iceServers)) {
          throw new Error(`rtc-config: ${r.status === 200 ? 'неверный ответ' : `HTTP ${r.status}`}`);
        }
        return { iceServers: r.body.iceServers };
      })(),
      new Promise((resolve) => { setTimeout(() => resolve({ iceServers: [], reason: 'ice-config-timeout' }), ms); }),
    ]);
  };
}

export function createAgent({ api, signal, native, policy, termHost, rtc, notify, services, video, inputSink }) {
  const missing = !api || typeof api.register !== 'function' || typeof api.session !== 'function'
    || typeof api.heartbeat !== 'function' || typeof api.decision !== 'function' ? 'api (register/session/heartbeat/decision)'
    : typeof signal !== 'function' ? 'signal (фабрика сигнальных клиентов)'
    : !native || typeof native.load !== 'function' || typeof native.end !== 'function' || typeof native.status !== 'function' ? 'native (load/end/status)'
    : null;
  if (missing) throw new Error(`createAgent: не хватает зависимости ${missing}`);

  const p = policy ?? {};
  const name = String(p.name ?? '');
  const os = String(p.os ?? '');
  const version = String(p.version ?? '');
  const heartbeatMs = Math.max(10, Number(p.heartbeatMs ?? 5000));
  const backoffBaseMs = Math.max(1, Number(p.backoffBaseMs ?? 1000));
  const backoffMaxMs = Math.max(backoffBaseMs, Number(p.backoffMaxMs ?? 30000));
  const tokenStore = p.tokenStore ?? memoryTokenStore();
  const log = p.log ?? { info() {}, warn() {}, error() {} };
  // Инвентарь (R06): сборщик может отсутствовать; может быть асинхронным
  // (statfs); может упасть — heartbeat тогда уходит без инвентаря.
  const getInventory = typeof p.getInventory === 'function' ? p.getInventory : null;
  const onBackoff = typeof p.onBackoff === 'function' ? p.onBackoff : null;
  // Терминал (R09): host-сторона DC-канала `term`; агент только оповещает
  // heartbeat'ом о факте жизни терминала (аудит переходов — на сервере) и
  // закрывает его вместе с сеансом. Открытие канала — только approved-сеанс.
  const term = termHost && typeof termHost.isActive === 'function' ? termHost : null;
  // RTC-фабрика терминала (R09): возвращает pc-подобный объект или null, если
  // в окружении нет RTCPeerConnection — тогда терминал честно недоступен.
  const rtcFactory = typeof rtc === 'function' ? rtc : null;
  // Toast (R08): показчик сообщений с машины (notify.mjs) может отсутствовать —
  // тогда запрос честно отвечает 'notify-unavailable', оператор не ждёт впустую.
  const showToast = typeof notify === 'function' ? notify : null;

  let running = false;
  let state = 'idle'; // idle|registering|waiting|connecting|online|backoff|revoked|error|stopped
  let error = null;
  let token = null;
  let machineId = null;
  let session = null;
  let attempt = 0;
  let backoffMs = 0;
  const gate = createInputGate();
  let currentSignal = null;
  let machineBeat = null;
  let wake = null;
  let resolveSessionDone = null;

  // Очередь результатов toast (R08): уходит по одному за heartbeat, повторяется
  // только при сетевом сбое; потолок очереди — старшие теряются (не копим).
  const toastResults = [];
  const wakeResults = [];

  // WoL (v0.6): курьерская задача от сервера — magic packet на все MAC цели.
  // Отправка не блокирует heartbeat; результат уезжает следующим beat-ом
  // (шаблон deliverToast). dgram передаётся МОДУЛЕМ — контракт wol.mjs
  // (v0.6 fix ревью GLM-5.3: раньше ушла функция-фабрика и ни один пакет
  // не отправлялся).
  const wakeSender = createWakeSender({ dgramFactory: nodeDgram });
  function deliverWake(wake) {
    const settle = (res) => {
      const entry = {
        id: wake.id,
        ok: res?.ok === true,
        ...(res && typeof res.reason === 'string' && res.reason ? { reason: res.reason.slice(0, 60) } : {}),
      };
      if (wakeResults.length >= 16) wakeResults.shift();
      wakeResults.push(entry);
    };
    const macs = Array.isArray(wake.macs) ? wake.macs : [];
    if (!macs.length) {
      settle({ ok: false, reason: 'no-macs' });
      return;
    }
    void Promise.all(macs.map((mac) => wakeSender.sendMagicPacket(mac)))
      .then((results) => {
        // форма sendMagicPacket: {broadcasts, packets, failed:[адреса]}
        const ok = results.every((r) => r.packets > 0 && r.failed.length === 0);
        settle(ok ? { ok: true } : { ok: false, reason: 'send-failed' });
      })
      .catch(() => settle({ ok: false, reason: 'send-failed' }));
  }

  // Показ toast не блокирует heartbeat (WTSSendMessageW с timeout 0 может
  // ждать нажатия минуты): результат встаёт в очередь и уедет следующим beat-ом.
  function deliverToast(toast) {
    const settle = (res) => {
      const entry = {
        id: toast.id,
        ok: res?.ok === true,
        ...(res && typeof res.reason === 'string' && res.reason ? { reason: res.reason.slice(0, 60) } : {}),
      };
      if (toastResults.length >= 16) toastResults.shift();
      toastResults.push(entry);
    };
    try {
      return Promise.resolve(showToast ? showToast(toast.text) : { ok: false, reason: 'notify-unavailable' })
        .then(settle)
        .catch(() => settle({ ok: false, reason: 'notify-unavailable' }));
    } catch {
      settle({ ok: false, reason: 'notify-unavailable' });
      return Promise.resolve();
    }
  }

  // Прерываемый сон: stop()/revoke() будят цикл немедленно.
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });

  function nextBackoff(message) {
    backoffMs = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt);
    attempt += 1;
    state = 'backoff';
    error = message ?? null;
    onBackoff?.(backoffMs, attempt);
    log.warn(`Агент: ${message ?? 'временная ошибка'} — повтор через ${backoffMs} мс (попытка ${attempt})`);
  }

  // Разрыв/остановка не оставляют зажатых клавиш: ворота закрываются,
  // всё нажатое отпускается через native.end().
  function releaseInput() {
    gate.close();
    if (gate.needInputReset()) native.end();
  }

  function revoke(message) {
    if (!running) return;
    token = null;
    try { tokenStore.clear(); } catch { /* хранилище могло отвалиться — статус всё равно честный */ }
    error = message;
    state = 'revoked';
    running = false;
    log.error(`Агент: ${message}`);
    wake?.();
    resolveSessionDone?.();
  }

  // Одна сессия: подключение host-ролью, авто-allow по claim, WS-heartbeat.
  // Возвращает 'over' (ended — сеанс закрыт), 'dropped' (обрыв — reconnect
  // по грейсу), 'failed' (не подключились) или 'stopped'.
  async function runSession(body) {
    state = 'connecting';
    native.load();
    const client = signal();
    currentSignal = client;
    let finish = null;
    const done = new Promise((resolve) => { finish = resolve; });
    resolveSessionDone = () => finish('stopped');
// Мультиоператор (W-C2): у машины персональный pc КАЖДОМУ оператору — все pc
    // живут в одном скрытом мосту (Map<op, …> в релее, R09/ADR 0027 не меняются).
    // op = claimId из from-тегов сервера; сигналы без from (старые серверы/шимы) —
    // 'primary'. Медиа pc не нужна: данным-каналам хватает DataChannel, видео
    // идёт видеотрансивером моста. Каналы каждого pc адресуются своим op.
    const slots = new Map(); // op → {pc, ice: [], answered}
    // Арбитраж ввода (W-C4): активный вводчик один, состояние — на host-стороне.
    // Гранты уходят по input-каналам всех операторов; события не-активного
    // отбрасываются ДО хелпера/нативного пайплайна (оба пути за одним арбитром).
    const opInputs = new Map(); // op → input-канал оператора (адаптер моста)
    // ADR 0035: вместе с грантом каждый оператор получает список участников
    // (кто в сеансе, у кого управление, кто только смотрит); имена ставит хост.
    const sendParticipants = (op, ch, parts) => {
      try { ch.send(JSON.stringify(participantsMessage(parts, op, opName))); } catch { /* канал закрывается */ }
    };
    const sendInputGrants = (activeOp, _ops, parts) => {
      for (const [op, ch] of opInputs) {
        if (ch.readyState !== 'open') continue;
        try { ch.send(JSON.stringify({ type: 'input-grant', granted: op === activeOp })); } catch { /* канал закрывается */ }
        if (parts) sendParticipants(op, ch, parts);
      }
    };
    const broadcastParticipants = () => sendInputGrants(arbiter.active(), null, arbiter.participants());
    const arbiter = createInputArbiter({ onChange: sendInputGrants });
    // Служебные claim/release перехватываются до валидации событий; события
    // не-активного оператора не доходят до инъекции (обёртка над каналом).
    const gateOperatorInput = (op, m) => {
      if (typeof m?.data === 'string') {
        const svc = parseControlMessage(m.data);
        if (svc) {
          if (svc.type === 'claim-input') arbiter.claim(op);
          else if (svc.type === 'release-input') arbiter.release(op);
          else if (svc.type === 'pass-input') arbiter.pass(op, svc.to);
          else if (svc.type === 'view-only') arbiter.setViewOnly(op, svc.on);
          return false; // служебное (и битое служебное) в инъекцию не идёт
        }
      }
      return arbiter.isAllowed(op);
    };
    const gatedInputChannel = (ch, op) => ({
      label: ch.label,
      get onmessage() { return ch.onmessage; },
      set onmessage(cb) {
        ch.onmessage = (m) => {
          if (!gateOperatorInput(op, m)) return;
          cb(m);
        };
      },
    });
    const pendingIce = new Map(); // op → [candidate] — ранние кандидаты до offer (чужой op не трогает pc)
    const ICE_QUEUE_CAP = 64; // потолок раннего буфера: мусорный op не копит память (сигнал-лимит сервера — 150/окно)
    let rtcObj = null; // {getPcLike(op,{claim}), closeOp(op), ops()} — мост волны C или легаси-обёртка одного pcLike
    // G2 (мультиоператор machine-сеанса): чат-каналы операторов для релея их
    // сообщений друг другу + отображаемые имена (из claim/operator-joined).
    const opChats = new Map(); // op → chat-канал оператора
    const opNames = new Map(); // op → имя оператора (подпись автора в релее)
    const opName = (op) => {
      const nm = opNames.get(op);
      return typeof nm === 'string' && nm ? nm : '';
    };
    // Релей сообщения оператора остальным (G2): метку автора ставит хост —
    // оператор не может подписаться чужим именем или «хостом» сам; старые
    // получатели (≤0.6.20) лишние поля from/name игнорируют и видят текст.
    const relayOperatorChat = (op, m) => {
      const msg = parseChatMessage(typeof m?.data === 'string' ? m.data : '');
      if (!msg) return;
      const name = opName(op);
      const wire = chatMessage(msg.text, { from: 'operator', ...(name ? { name } : {}) });
      if (!wire) return;
      for (const [other, ch] of opChats) {
        if (other === op) continue; // отправителю не эхаем
        if (ch.readyState !== 'open') continue;
        try { ch.send(wire); } catch { /* канал закрывается */ }
      }
    };
    // Ответ/ICE адресуются владельцу (to=op): fan-out'ом answer уходил бы ВСЕМ
    // операторам и чужие pc пытались бы применить его (W-C1).
    const signalTo = (op) => (op !== 'primary' ? { to: op } : {});
    const closeTermRtc = () => {
      for (const slot of slots.values()) {
        try { slot.pc.close(); } catch { /* уже закрыт */ } // pcLike.close() = closeOp(op) в релее
      }
      slots.clear();
      pendingIce.clear();
      // Ревью 16.10 P1-1: destroy() релея гасит окно моста и ipc-слушателей
      // (семантика ≤0.6.19). Без него каждый сеанс течёт скрытым окном, а
      // gdm-захват Linux (ADR 0031) продолжался бы в осиротевшем окне.
      try { rtcObj?.destroy?.(); } catch { /* мост уже умер */ }
      rtcObj = null;
    };
    const wireBridgeChannel = (ch, op) => {
      if (!ch) return;
      if (ch.label === 'term') {
        // открытие — только approved-сеанс: мы уже в нём; второй term-канал
        // получает честный term-busy от termHost (W-C3)
        term.handleChannel(ch);
        return;
      }
      // v0.6.4: ввод machine-сеанса — Windows: хелпер (SendInput в консольном
      // сеансе), Linux: нативный пайплайн (inputSink, XTest). Гейт — approved:
      // мы уже в нём. Арбитраж W-C4: каналу оператора — фильтр по op до обоих
      // путей; grant-рассылке нужен живой канал.
      if (ch.label === 'input') {
        opInputs.set(op, ch);
        arbiter.attach(op); // страховка: operator-joined мог не дойти (старый сервер)
        // Начальный input-grant (P3-1 ревью Рината, приёмка C+D): attach молчит,
        // если оператор уже учтён (operator-joined пришёл раньше канала) —
        // сливаем текущее состояние арбитража новому каналу явно.
        try { ch.send(JSON.stringify({ type: 'input-grant', granted: arbiter.active() === op })); } catch { /* канал закрывается */ }
        broadcastParticipants(); // новый канал узнаёт состав, остальные — о новичке
        const gated = gatedInputChannel(ch, op);
        if (inputSink) { inputSink.handleChannel(gated); return; }
        video?.handleInputChannel?.(gated);
        return;
      }
      // W-U6 (v0.5) + G2: чат machine-сеанса — релей сообщения оператора
      // остальным с меткой автора + тост консольному пользователю сервисом
      // (v0.5), если сервис есть; файлы — сервисом, как раньше. Нет services —
      // chat-канал всё равно живёт релеем, неизвестные каналы закрываются.
      if (ch.label === 'chat') {
        opChats.set(op, ch);
        const svcHandled = services?.handleChannel?.('chat', ch) === true;
        if (svcHandled) {
          // сервисный обработчик (тост) уже на канале — составляем релей поверх
          const svcOnMessage = ch.onmessage;
          ch.onmessage = (m) => {
            if (typeof svcOnMessage === 'function') svcOnMessage(m);
            relayOperatorChat(op, m);
          };
        } else {
          ch.onmessage = (m) => relayOperatorChat(op, m);
        }
        return;
      }
      if (services?.handleChannel?.(ch.label, ch)) return;
      try { ch.close(); } catch { /* уже закрыт */ }
    };
    const answerOffer = async (op, sdp) => {
      let slot = slots.get(op);
      if (!slot) {
        const pc = rtcObj ? rtcObj.getPcLike(op, { claim: true }) : null;
        if (!pc) {
          // W-C1: мост одиночный (легаси-контракт) и pc уже занят другим
          // оператором — чужой offer не трогает живой pc владельца.
          log.warn(`Агент: offer от оператора ${op} игнорирован — pc оператора недоступен/занят`);
          return;
        }
        slot = { pc, ice: pendingIce.get(op) ?? [], answered: false };
        pendingIce.delete(op);
        slots.set(op, slot);
        pc.onicecandidate = (e) => {
          if (!e?.candidate) return;
          try {
            client.sendSignal({ type: 'signal', ...signalTo(op), data: { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate } });
          } catch (err) {
            // Различаем причины: молчащий catch маскировал отказ валидации формы
            // (дефект №12); предупреждение в лог делает регрессию видимой.
            log.warn(`Агент: ICE-кандидат не отправлен (${err.message})`);
          }
        };
        pc.ondatachannel = (e) => wireBridgeChannel(e?.channel, op);
      }
      try {
        await slot.pc.setRemoteDescription({ type: 'offer', sdp });
        for (const c of slot.ice.splice(0)) slot.pc.addIceCandidate(c).catch(() => { /* устаревший */ });
        const answer = await slot.pc.createAnswer();
        await slot.pc.setLocalDescription(answer);
        // Исходящие сигналы обязаны идти в конверте {type:'signal', data:…} —
        // validateOutgoingSignal отбрасывает всё остальное (живой сеанс 28.09:
        // без обёртки answer терминала не доходил до оператора, W-U6/W-U11 были мертвы).
        client.sendSignal({ type: 'signal', ...signalTo(op), data: { description: { type: 'answer', sdp: slot.pc.localDescription.sdp } } });
        // Только после выставленного remote description прямые ICE-кандидаты
        // оператора применяются сразу (тригкл после answer); раньше — в буфер.
        slot.answered = true;
      } catch (e) {
        log.warn(`Агент: ответ оператору ${op} не удался (${e.message})`);
      }
    };
    const openRtc = () => {
      if (rtcObj || !term || !rtcFactory) return;
      let made;
      try { made = rtcFactory(); } catch { made = null; }
      if (made && typeof made.getPcLike === 'function' && typeof made.closeOp === 'function') {
        rtcObj = made; // мост волны C (W-C2): N pc в одном окне
      } else {
        const pcLike = made?.pcLike ?? made; // v0.6: фабрика могла вернуть {pcLike, …}
        if (!pcLike) {
          log.warn('Агент: терминал недоступен — в этом окружении нет RTCPeerConnection');
          return;
        }
        // Легаси-контракт (один pcLike, W-C1-граница): pc один на сеанс — первый
        // offer (любой op) назначает владельца, чужие offer/ICE игнорируются.
        let owner = null;
        rtcObj = {
          getPcLike: (op, { claim } = {}) => {
            if (owner == null && claim) owner = op;
            return owner === op ? pcLike : null;
          },
          closeOp: () => { owner = null; try { pcLike.close(); } catch { /* уже закрыт */ } },
          ops: () => (owner ? [owner] : []),
        };
      }
      // v0.6 (ADR 0027): кадры видео-хелпера уходят в мост текущего сеанса.
      video?.bind?.();
    };
const unsubscribe = client.onMessage((msg) => {
      gate.onSignal(msg);
      if (gate.needInputReset()) native.end();
      if (msg.type === 'claim' && msg.claimId) {
        // G2: имя автора claim'а — для подписи его сообщений чата в релее
        if (typeof msg.operator?.name === 'string' && msg.operator.name) opNames.set(msg.claimId, msg.operator.name);
        // причина/PIN уже проверены сервером до claim — агент соглашается
        api.decision({ sessionId: body.sessionId, token, claimId: msg.claimId, allow: true })
          .then((r) => {
            if (r.status !== 200) log.warn(`Агент: решение по claim отклонено сервером (${r.status})`);
          })
          .catch(() => { /* транзиентно: replay approved придёт при переподключении */ });
      }
      if (msg.type === 'approved') {
        openRtc();
        // v0.6 (ADR 0027): хелпер видео/ввода живёт в сеансе — спавн в
        // консольном сеансе + pipe; статусы релеются операторам.
        video?.onStatus?.((s) => { try { client.sendMachineVideo(s); } catch { /* WS мёртв */ } });
        video?.start?.();
      }
      if (msg.type === 'operator-joined' && msg.claimId) {
        // W-C2: pc поднимется по offer самого оператора (офферит оператор);
        // участник фиксируется для арбитража ввода (W-C4) и аудита.
        // G2: отображаемое имя присоединившегося — для подписи его чата и
        // списка участников (ADR 0035): имя ставится ДО attach, чтобы первая
        // рассылка списка уже шла с именем
        const joinedName = msg.operator?.name ?? msg.operator?.login;
        if (typeof joinedName === 'string' && joinedName) opNames.set(msg.claimId, joinedName);
        arbiter.attach(msg.claimId);
        log.info(`Агент: оператор ${msg.operator?.name ?? msg.operator?.login ?? msg.claimId} присоединился (${msg.claimId})`);
      }
      if (msg.type === 'operator-left' && msg.claimId) {
        // pc ушедшего не копится до конца сеанса: релей закрывает его pc в
        // мосту и каналы (closeOp), остальные операторы не затрагиваются (W-C2);
        // ввод ушедшего освобождается без автопередачи (W-C4)
        arbiter.drop(msg.claimId);
        opInputs.delete(msg.claimId);
        opChats.delete(msg.claimId); // G2: чат-канал ушедшего не участвует в релее
        opNames.delete(msg.claimId); // ревью G P3-1: имя ушедшего не копится в карте
        const slot = slots.get(msg.claimId);
        // Ревью 16.10 P3-2: буфер ранних кандидатов чистится и без слота —
        // цикл claim/ICE/left без offer больше не копит Map вечно.
        pendingIce.delete(msg.claimId);
        if (slot) {
          slots.delete(msg.claimId);
          try { slot.pc.close(); } catch { /* уже закрыт */ }
        }
      }
      if (msg.type === 'signal' && rtcObj) {
        const d = msg.data;
        // Сервер тегирует op→host сигналы from=claimId (W-C1/W-C2): маршрутизация
        // в персональный pc оператора; чужой/неизвестный op — честный игнор.
        const op = typeof msg.from === 'string' && msg.from ? msg.from : 'primary';
        if (d?.description?.type === 'offer' && typeof d.description.sdp === 'string') {
          void answerOffer(op, d.description.sdp);
        } else if (d?.candidate) {
          const slot = slots.get(op);
          if (slot) {
            // pcLike моста не экспонирует remoteDescription — полагаемся на флаг
            // answered (ставится после answer'а): поздние тригкл-кандидаты
            // применяются сразу, ранние — из буфера (ревью 28.09).
            if (slot.answered) slot.pc.addIceCandidate(d.candidate).catch(() => { /* устаревший */ });
            else slot.ice.push(d.candidate);
          } else {
            // до offer слота нет — буфер per-op (применится в answer-фазе);
            // чужой мусорный op ограничен капом и никогда не применяется
            const q = pendingIce.get(op) ?? [];
            if (q.length < ICE_QUEUE_CAP) { q.push(d.candidate); pendingIce.set(op, q); }
          }
        }
      }
      if (msg.type === 'ended') finish('over');
      if (msg.type === 'socket-closed') finish('dropped');
    });
    const wsBeat = setInterval(() => {
      try {
        client.heartbeat({ termActive: term ? !!term.isActive() : false });
      } catch { /* сокет уже мёртв — разрыв обработается выше */ }
    }, heartbeatMs);
    try {
      await client.open({ role: 'host', sessionId: body.sessionId, token });
      attempt = 0;
      backoffMs = 0;
      state = 'online';
      error = null;
      log.info(`Агент: сеанс ${body.sessionId} подключён (${body.state})`);
      return await done;
    } catch (e) {
      log.warn(`Агент: подключение не удалось (${e.message})`);
      return 'failed';
    } finally {
      clearInterval(wsBeat);
      unsubscribe();
      releaseInput();
      closeTermRtc();
      if (term) { try { term.close(); } catch { /* терминал мог уже умереть */ } }
      video?.stop?.(); // хелпер умирает с сеансом; wake дисплея — внутри stop
      try { client.close(); } catch { /* уже закрыт */ }
      currentSignal = null;
      resolveSessionDone = null;
    }
  }

  async function runLoop(code) {
    try {
      const stored = tokenStore.load();
      token = typeof stored === 'string' && stored ? stored : null;
      while (running && !token) {
        if (!code) {
          state = 'error';
          error = 'Токена машины нет: для первой регистрации нужен onboarding-код';
          running = false;
          log.error(`Агент: ${error}`);
          return;
        }
        state = 'registering';
        let r;
        try {
          r = await api.register({ code, name, os, version });
        } catch (e) {
          nextBackoff(`регистрация не удалась (${e.message})`);
          await sleep(backoffMs);
          continue;
        }
        if (r.status === 201 && r.body?.token) {
          token = r.body.token;
          machineId = r.body.machineId ?? null;
          try { tokenStore.save(token); } catch (e) { log.warn(`Агент: токен не сохранён в хранилище (${e.message})`); }
          attempt = 0;
          backoffMs = 0;
          error = null;
          log.info(`Агент: машина зарегистрирована (id ${machineId ?? '?'})`);
          break;
        }
        if (r.status === 400) {
          state = 'error';
          // код из конверта {error:{code,message}}: печать всего объекта давала
          // «Регистрация отклонена ([object Object])» и маскировала bad_code vs bad_request
          error = `Регистрация отклонена (${r.body?.error?.code ?? 'bad_code'}): код недействителен или уже использован`;
          running = false;
          log.error(`Агент: ${error}`);
          return; // бессмысленно долбить: код одноразовый, лимит сервера честно вернёт 429
        }
        nextBackoff(`регистрация отложена (HTTP ${r.status})`);
        await sleep(backoffMs);
      }
      if (!running || !token) return;

      // Машинный heartbeat (online-статус в списке машин) — на всём времени жизни.
      machineBeat = setInterval(() => {
        // Сбор инвентаря (R06) до отправки: упал или нет — heartbeat всё равно идёт.
        Promise.resolve()
          .then(() => (getInventory ? getInventory() : undefined))
          .catch(() => undefined)
          .then((inventory) => {
            // Toast (R08): результат прошлого показа уезжает одним полем; не ушёл
            // из-за сети — повторится следующим beat-ом (остаётся в очереди).
            const toastResult = toastResults.length ? toastResults[0] : undefined;
            const wakeResult = wakeResults.length ? wakeResults[0] : undefined;
            return api.heartbeat(token, inventory, toastResult, wakeResult).then((r) => {
              if (r.status === 200) {
                if (toastResult) toastResults.shift(); // сервер принял — не повторяем
                if (wakeResult) wakeResults.shift();
                const toast = r.body?.toast;
                if (toast && typeof toast.id === 'string' && typeof toast.text === 'string') {
                  void deliverToast(toast);
                }
                // WoL (v0.6): курьерская задача — magic packet соседу
                const wake = r.body?.wake;
                if (wake && typeof wake.id === 'string' && Array.isArray(wake.macs)) {
                  void deliverWake(wake);
                }
              }
              if (r.status === 401) revoke('Токен машины отозван (heartbeat 401)');
            });
          })
          .catch(() => { /* сеть — видеть будет следующий цикл опроса */ });
      }, heartbeatMs);

      while (running) {
        let ss;
        try {
          ss = await api.session(token);
        } catch (e) {
          nextBackoff(`опрос сеанса не удался (${e.message})`);
          await sleep(backoffMs);
          continue;
        }
        if (ss.status === 401) return revoke('Токен машины отозван (session 401)');
        if (ss.status === 200 && ss.body?.sessionId) {
          session = ss.body;
          const outcome = await runSession(ss.body);
          session = null;
          if (!running) return;
          if (outcome === 'over') {
            attempt = 0;
            backoffMs = 0;
            state = 'waiting';
            error = null;
            log.info('Агент: сеанс завершён, жду следующий');
            continue;
          }
          // dropped/failed: сеанс сервер не рвал — переподключение тем же токеном
          nextBackoff(outcome === 'dropped' ? 'связь прервана, переподключение' : 'сеанс не подключился');
          await sleep(backoffMs);
          continue;
        }
        state = 'waiting';
        error = null;
        await sleep(heartbeatMs); // нет сеанса — бесконечный вежливый опрос
      }
    } finally {
      if (machineBeat) { clearInterval(machineBeat); machineBeat = null; }
      if (currentSignal) { try { currentSignal.close(); } catch { /* уже закрыт */ } currentSignal = null; }
      releaseInput();
    }
  }

  return {
    start(opts = {}) {
      if (running) return { ok: false, error: 'Агент уже запущен' };
      const code = typeof opts.code === 'string' && opts.code ? opts.code : null;
      running = true;
      error = null;
      attempt = 0;
      backoffMs = 0;
      state = token || code ? 'registering' : 'idle';
      runLoop(code).catch((e) => {
        running = false;
        state = 'error';
        error = `Цикл агента упал: ${e.message}`;
        log.error(`Агент: ${error}`);
      });
      return { ok: true, state };
    },

    stop() {
      if (!running) return { ok: false, error: `Агент не запущен (состояние: ${state})` };
      running = false;
      state = 'stopped';
      error = null;
      log.info('Агент: остановлен');
      wake?.();
      resolveSessionDone?.();
      return { ok: true };
    },

    status() {
      return {
        running,
        state,
        error,
        machineId,
        hasToken: !!token,
        name,
        os,
        version,
        session: session ? { sessionId: session.sessionId, state: session.state, operator: session.operator ?? null } : null,
        attempt,
        backoffMs,
        native: native.status(),
      };
    },
  };
}

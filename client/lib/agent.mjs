// Цикл unattended-агента (headless-режим того же клиента): onboarding-код →
// POST /agent/register → токен машины (память процесса + store из policy;
// в main store — файл в userData) → WS host-роль → heartbeat. Обрыв —
// экспоненциальный backoff с потолком и бесконечными повторами той же парой
// sessionId+токен (грейс ADR 0013); отзыв токена — честный статус 'revoked'
// без повторов. Политику сеанса (причина, PIN) проверяет сервер до claim —
// агент только подтверждает allow. Electron-независимый шов §2 (interfaces.md):
// api/signal/native вводятся снаружи, поэтому цикл тестируется на фейках.

import { createInputGate } from './protocol.mjs';

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
    heartbeat: (token, inventory, toastResult) => call('/agent/heartbeat', {
      method: 'POST',
      token,
      // без инвентаря и результата — тело не отправляется вовсе (старые серверы не заметят)
      ...((inventory !== undefined || toastResult !== undefined) ? {
        body: {
          ...(inventory !== undefined ? { inventory } : {}),
          ...(toastResult !== undefined ? { toastResult } : {}),
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

export function createAgent({ api, signal, native, policy, termHost, rtc, notify }) {
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
    // Терминал (R09): pc без медиа-треков — данных-каналам медиа не нужно.
    // Оператор офферит, агент отвечает answer'ом; канал 'term' уходит в termHost.
    let termPc = null;
    let termIce = [];
    const closeTermRtc = () => {
      if (termPc) { try { termPc.close(); } catch { /* уже закрыт */ } termPc = null; }
      termIce = [];
    };
    const answerTermOffer = async (sdp) => {
      const pc = termPc;
      if (!pc) return;
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        for (const c of termIce.splice(0)) pc.addIceCandidate(c).catch(() => { /* устаревший */ });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        client.sendSignal({ description: { type: 'answer', sdp: pc.localDescription.sdp } });
      } catch (e) {
        log.warn(`Агент: ответ терминала не удался (${e.message})`);
      }
    };
    const openTermRtc = () => {
      if (termPc || !term || !rtcFactory) return;
      let pc;
      try { pc = rtcFactory(); } catch { pc = null; }
      if (!pc) {
        log.warn('Агент: терминал недоступен — в этом окружении нет RTCPeerConnection');
        return;
      }
      termPc = pc;
      pc.onicecandidate = (e) => {
        if (!e?.candidate) return;
        try { client.sendSignal({ candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); } catch { /* сигнал уже закрыт */ }
      };
      pc.ondatachannel = (e) => {
        const ch = e?.channel;
        if (ch && ch.label === 'term') term.handleChannel(ch); // открытие — только approved-сеанс: мы уже в нём
        else if (ch) { try { ch.close(); } catch { /* уже закрыт */ } }
      };
    };
    const unsubscribe = client.onMessage((msg) => {
      gate.onSignal(msg);
      if (gate.needInputReset()) native.end();
      if (msg.type === 'claim' && msg.claimId) {
        // причина/PIN уже проверены сервером до claim — агент соглашается
        api.decision({ sessionId: body.sessionId, token, claimId: msg.claimId, allow: true })
          .then((r) => {
            if (r.status !== 200) log.warn(`Агент: решение по claim отклонено сервером (${r.status})`);
          })
          .catch(() => { /* транзиентно: replay approved придёт при переподключении */ });
      }
      if (msg.type === 'approved') openTermRtc();
      if (msg.type === 'signal' && termPc) {
        const d = msg.data;
        if (d?.description?.type === 'offer' && typeof d.description.sdp === 'string') {
          void answerTermOffer(d.description.sdp);
        } else if (d?.candidate) {
          if (termPc.remoteDescription) termPc.addIceCandidate(d.candidate).catch(() => { /* устаревший */ });
          else termIce.push(d.candidate);
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
          error = `Регистрация отклонена (${r.body?.error ?? 'bad_code'}): код недействителен или уже использован`;
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
            return api.heartbeat(token, inventory, toastResult).then((r) => {
              if (r.status === 200) {
                if (toastResult) toastResults.shift(); // сервер принял — не повторяем
                const toast = r.body?.toast;
                if (toast && typeof toast.id === 'string' && typeof toast.text === 'string') {
                  void deliverToast(toast);
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

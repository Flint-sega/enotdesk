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
    heartbeat: (token) => call('/agent/heartbeat', { method: 'POST', token }),
    decision: ({ sessionId, token, claimId, allow }) => call(`/sessions/${encodeURIComponent(String(sessionId))}/decision`, { method: 'POST', token, body: { claimId, allow } }),
  };
}

function memoryTokenStore() {
  let t = null;
  return { load: () => t, save: (v) => { t = v; }, clear: () => { t = null; } };
}

export function createAgent({ api, signal, native, policy }) {
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
  const onBackoff = typeof p.onBackoff === 'function' ? p.onBackoff : null;

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
      if (msg.type === 'ended') finish('over');
      if (msg.type === 'socket-closed') finish('dropped');
    });
    const wsBeat = setInterval(() => {
      try { client.heartbeat(); } catch { /* сокет уже мёртв — разрыв обработается выше */ }
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
        api.heartbeat(token)
          .then((r) => { if (r.status === 401) revoke('Токен машины отозван (heartbeat 401)'); })
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

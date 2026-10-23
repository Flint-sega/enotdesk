// Нагрузочный прогон S-8 (docs/ACCEPTANCE-1.0.md): 300 агентов + 30 сеансов,
// критерий — p95 каждого класса API ≤200 мс, без ошибок, все сеансы согласованы,
// все агенты онлайн к концу.
//
// По умолчанию поднимает собственный сервер отдельным процессом (node
// server/main.mjs) на временной базе — замер не смешивается с event loop
// генератора. Сервер доверяет генератору как прокси (ENOT_TRUSTED_PROXY), и
// у каждого агента, клиента и оператора свой адрес в X-Forwarded-For: лимиты
// частоты по IP остаются включёнными, как в жизни, где машины приходят с
// разных адресов.
//
// Что делает каждый участник (как настоящие программы, client/lib/agent.mjs):
//   агент — раз в LOAD_HEARTBEAT_MS POST /agent/heartbeat с инвентарём и опрос
//     GET /agent/session; найден сеанс — WS /signal как host, согласие, answer;
//   attended-клиент — POST /sessions, WS host, согласие, offer и ICE через сервер;
//   оператор — claim (attended по паролю, машина — с причиной), WS, сигналинг;
//     время от времени читает список машин и историю, админ — журнал.
//
// Переменные (значения по умолчанию — S-8):
//   LOAD_AGENTS=300 LOAD_SESSIONS=30 (половина — машинные) LOAD_OPERATORS=10
//   LOAD_DURATION_S=120 (устойчивая фаза после подъёма сеансов) LOAD_RAMP_S=60 (подъём сеансов)
//   LOAD_HEARTBEAT_MS=5000 LOAD_P95_MS=200 LOAD_REPORT=<путь JSON-отчёта>
//   LOAD_P95_SLOW_MS=500 — порог для входа и приёма приглашения (scrypt, см. load-stats.mjs)
// Запуск: npm run load   (или node scripts/load-test.mjs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { bootstrapAdmin } from '../server/bootstrap.mjs';
import { createRecorder, verdict } from './load-stats.mjs';

const env = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const CFG = {
  agents: env('LOAD_AGENTS', 300),
  sessions: env('LOAD_SESSIONS', 30),
  operators: env('LOAD_OPERATORS', 10),
  durationS: env('LOAD_DURATION_S', 120),
  heartbeatMs: env('LOAD_HEARTBEAT_MS', 5000),
  p95Ms: env('LOAD_P95_MS', 200),
  slowP95Ms: env('LOAD_P95_SLOW_MS', 500),
  rampS: env('LOAD_RAMP_S', 60),
};
CFG.machineSessions = Math.min(CFG.agents, Math.floor(CFG.sessions / 2));
CFG.attendedSessions = CFG.sessions - CFG.machineSessions;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rec = createRecorder();
const wsRec = createRecorder();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
// адрес участника: агенты 10.77.*, клиенты 10.78.*, операторы 10.79.* — у всех разные
const fakeIp = (net, i) => `10.${net}.${Math.floor(i / 250)}.${(i % 250) + 1}`;

let base = '';
let stopping = false;

async function api(cls, method, p, { token, body, ip } = {}) {
  const headers = { 'x-forwarded-for': ip ?? '10.80.0.1' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/v1${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    rec.time(cls, performance.now() - t0);
    return { status: res.status, data };
  } catch (e) {
    rec.error(cls, e.message);
    return { status: 0, data: {} };
  }
}

// Ответ вне ожидаемых статусов — ошибка класса (ответ уже замерен по времени)
function expect(cls, r, ...statuses) {
  if (statuses.includes(r.status)) return true;
  rec.error(cls, `HTTP ${r.status} ${JSON.stringify(r.data?.error ?? r.data).slice(0, 100)}`);
  return false;
}

// ---- WS: подключение с адресом участника и ожидание сообщений ----
function openWs(ip) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/signal`, { headers: { 'x-forwarded-for': ip } });
  const waiters = new Set();
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    for (const w of [...waiters]) if (w.pred(m)) { waiters.delete(w); clearTimeout(w.t); w.resolve(m); }
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws,
    opened,
    send: (m) => ws.send(JSON.stringify(m)),
    wait(pred, label, ms = 15000) {
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, t: setTimeout(() => { waiters.delete(w); reject(new Error(`timeout: ${label}`)); }, ms) };
        waiters.add(w);
      });
    },
    close: () => { try { ws.close(); } catch { /* уже закрыт */ } },
  };
}

const FAKE_SDP = `v=0\r\n${'a=x-load:'.padEnd(64, 'x')}\r\n`.repeat(40); // ~2,7 КБ — порядок настоящего SDP
const ICE_PER_SIDE = 8;

// Обмен описаниями и кандидатами через сервер; задержка доставки — в ws-замеры
async function exchange(offerer, answerer) {
  const t0 = performance.now();
  const gotOffer = answerer.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer', 'offer');
  offerer.send({ type: 'signal', data: { description: { type: 'offer', sdp: FAKE_SDP } } });
  await gotOffer;
  wsRec.time('relay.offer', performance.now() - t0);
  const t1 = performance.now();
  const gotAnswer = offerer.wait((m) => m.type === 'signal' && m.data?.description?.type === 'answer', 'answer');
  answerer.send({ type: 'signal', data: { description: { type: 'answer', sdp: FAKE_SDP } } });
  await gotAnswer;
  wsRec.time('relay.answer', performance.now() - t1);
  let seenA = 0;
  let seenB = 0;
  const iceA = answerer.wait((m) => m.type === 'signal' && m.data?.candidate && ++seenA === ICE_PER_SIDE, 'ice→answerer');
  const iceB = offerer.wait((m) => m.type === 'signal' && m.data?.candidate && ++seenB === ICE_PER_SIDE, 'ice→offerer');
  const t2 = performance.now();
  for (let i = 0; i < ICE_PER_SIDE; i += 1) {
    const cand = (n) => ({ candidate: `candidate:${n} 1 udp 2122260223 10.0.0.${n} ${50000 + n} typ host`, sdpMid: '0', sdpMLineIndex: 0 });
    offerer.send({ type: 'signal', data: { candidate: cand(i + 1) } });
    answerer.send({ type: 'signal', data: { candidate: cand(i + 100) } });
  }
  await Promise.all([iceA, iceB]);
  wsRec.time('relay.ice', performance.now() - t2);
}

// ---- агенты ----
const agents = [];
const sessionsState = { planned: CFG.sessions, approved: 0, failed: [] };

function startAgent(a) {
  const beat = async () => {
    if (stopping) return;
    const inventory = { os: 'Windows 11 (нагрузка)', appVersion: '0.6.28', uptimeSec: Math.floor(process.uptime()), diskFreeGb: 120 };
    const r = await api('agent.heartbeat', 'POST', '/agent/heartbeat', { token: a.token, body: { inventory }, ip: a.ip });
    expect('agent.heartbeat', r, 200);
    a.beatTimer = setTimeout(beat, jitter(CFG.heartbeatMs));
  };
  const poll = async () => {
    if (stopping) return;
    if (!a.inSession) {
      const r = await api('agent.session', 'GET', '/agent/session', { token: a.token, ip: a.ip });
      expect('agent.session', r, 200, 404);
      if (r.status === 200 && r.data.sessionId && !stopping) {
        a.inSession = true;
        runAgentSession(a, r.data).catch((e) => sessionsState.failed.push(`агент ${a.idx}: ${e.message}`)).finally(() => { a.inSession = false; });
      }
    }
    a.pollTimer = setTimeout(poll, jitter(CFG.heartbeatMs));
  };
  a.beatTimer = setTimeout(beat, Math.random() * CFG.heartbeatMs);
  a.pollTimer = setTimeout(poll, Math.random() * CFG.heartbeatMs);
}

// Хост машинного сеанса: WS, согласие по claim (политику проверил сервер), answer на offer оператора
async function runAgentSession(a, s) {
  const c = openWs(a.ip);
  a.ws = c;
  await c.opened;
  const claimP = c.wait((m) => m.type === 'claim' && m.claimId, 'agent claim');
  const t0 = performance.now();
  c.send({ type: 'auth', role: 'host', sessionId: s.sessionId, token: a.token });
  await c.wait((m) => m.type === 'ready', 'agent ready');
  wsRec.time('ready.host', performance.now() - t0);
  const claim = await claimP;
  const approved = c.wait((m) => m.type === 'approved', 'agent approved');
  const d = await api('sessions.decision', 'POST', `/sessions/${s.sessionId}/decision`, { token: a.token, body: { claimId: claim.claimId, allow: true }, ip: a.ip });
  expect('sessions.decision', d, 200);
  await approved;
  a.session = s.sessionId;
  // answer на offer оператора отдаёт сам exchange() у оператора; держим heartbeat сеанса
  const hb = setInterval(() => { try { c.send({ type: 'heartbeat' }); } catch { /* закрыт */ } }, CFG.heartbeatMs);
  await new Promise((resolve) => c.ws.once('close', resolve));
  clearInterval(hb);
}

// ---- сеансы ----
const live = [];

async function attendedSession(i, op) {
  const ip = fakeIp(78, i);
  const s = await api('sessions.create', 'POST', '/sessions', { body: {}, ip });
  if (!expect('sessions.create', s, 200, 201)) throw new Error('создание сеанса');
  const host = openWs(ip);
  await host.opened;
  let t0 = performance.now();
  host.send({ type: 'auth', role: 'host', sessionId: s.data.sessionId, token: s.data.hostToken });
  await host.wait((m) => m.type === 'ready', 'host ready');
  wsRec.time('ready.host', performance.now() - t0);
  const claimMsg = host.wait((m) => m.type === 'claim', 'host claim');
  const claim = await api('sessions.claim', 'POST', `/sessions/${s.data.sessionId}/claim`, { token: op.token, body: { password: s.data.password }, ip: op.ip });
  if (!expect('sessions.claim', claim, 200, 201)) throw new Error('claim');
  await claimMsg;
  const opc = openWs(op.ip);
  await opc.opened;
  t0 = performance.now();
  opc.send({ type: 'auth', role: 'operator', sessionId: s.data.sessionId, claimId: claim.data.claimId, token: op.token });
  await opc.wait((m) => m.type === 'ready', 'op ready');
  wsRec.time('ready.operator', performance.now() - t0);
  const ap = Promise.all([host.wait((m) => m.type === 'approved', 'host approved'), opc.wait((m) => m.type === 'approved', 'op approved')]);
  const dec = await api('sessions.decision', 'POST', `/sessions/${s.data.sessionId}/decision`, { token: s.data.hostToken, body: { claimId: claim.data.claimId, allow: true }, ip });
  expect('sessions.decision', dec, 200);
  await ap;
  await exchange(host, opc); // attended: офферит хост
  sessionsState.approved += 1;
  const hb = setInterval(() => { try { host.send({ type: 'heartbeat' }); } catch { /* закрыт */ } }, CFG.heartbeatMs);
  live.push({
    kind: 'attended',
    end: async () => {
      clearInterval(hb);
      const r = await api('sessions.end', 'POST', `/sessions/${s.data.sessionId}/end`, { token: s.data.hostToken, body: {}, ip });
      expect('sessions.end', r, 200);
      host.close(); opc.close();
    },
  });
}

async function machineSession(agent, op) {
  const claim = await api('machines.claim', 'POST', `/machines/${agent.machineId}/claim`, { token: op.token, body: { reason: 'нагрузочный прогон S-8' }, ip: op.ip });
  if (!expect('machines.claim', claim, 201)) throw new Error('claim машины');
  const opc = openWs(op.ip);
  await opc.opened;
  const t0 = performance.now();
  opc.send({ type: 'auth', role: 'operator', sessionId: claim.data.sessionId, claimId: claim.data.claimId, token: op.token });
  await opc.wait((m) => m.type === 'ready', 'op ready');
  wsRec.time('ready.operator', performance.now() - t0);
  // согласие даёт агент, когда его опрос найдёт сеанс (до одного heartbeat-интервала)
  const tWait = performance.now();
  await opc.wait((m) => m.type === 'approved', 'machine approved', CFG.heartbeatMs * 4 + 15000);
  wsRec.time('machine.pickup', performance.now() - tWait);
  for (let i = 0; i < 50 && !agent.ws; i += 1) await sleep(100);
  await exchange(opc, agent.ws); // машинный сеанс: офферит оператор
  sessionsState.approved += 1;
  live.push({
    kind: 'machine',
    end: async () => {
      const r = await api('sessions.end', 'POST', `/sessions/${claim.data.sessionId}/end`, { token: op.token, body: {}, ip: op.ip });
      expect('sessions.end', r, 200);
      opc.close();
      agent.ws?.close();
      agent.ws = null;
    },
  });
}

// ---- чтения панели оператора ----
function startReaders(ops, admin) {
  const timers = [];
  for (const op of ops) {
    const read = async () => {
      if (stopping) return;
      expect('machines.list', await api('machines.list', 'GET', '/machines?limit=100&sort=recent', { token: op.token, ip: op.ip }), 200);
      expect('history', await api('history', 'GET', '/history?limit=50', { token: op.token, ip: op.ip }), 200);
      timers.push(setTimeout(read, jitter(15000)));
    };
    timers.push(setTimeout(read, Math.random() * 15000));
  }
  const audit = async () => {
    if (stopping) return;
    expect('audit', await api('audit', 'GET', '/audit?limit=50', { token: admin.token, ip: admin.ip }), 200);
    expect('health', await api('health', 'GET', '/health', { ip: admin.ip }), 200);
    timers.push(setTimeout(audit, jitter(10000)));
  };
  timers.push(setTimeout(audit, 2000));
  return () => timers.forEach(clearTimeout);
}

// ---- свой сервер на временной базе ----
async function startServer(dbPath, admin) {
  const boot = bootstrapAdmin(dbPath, { login: admin.login, name: 'Load Admin', password: admin.password });
  if (!boot.ok) throw new Error(`bootstrap: ${boot.reason}`);
  const logPath = `${dbPath}.log`;
  const out = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'main.mjs')], {
    env: {
      ...process.env, ENOT_DB: dbPath, ENOT_HOST: '127.0.0.1', ENOT_PORT: '0',
      ENOT_TRUSTED_PROXY: '127.0.0.1,::1,::ffff:127.0.0.1',
    },
    stdio: ['ignore', out, out],
  });
  fs.closeSync(out); // у сервера своя копия; открытый лог Windows не даст удалить
  for (let i = 0; i < 100; i += 1) {
    const m = /listening on [^:]+:(\d+)/.exec(fs.readFileSync(logPath, 'utf8'));
    if (m) return { child, port: Number(m[1]), logPath };
    if (child.exitCode != null) break;
    await sleep(100);
  }
  child.kill('SIGTERM'); // не оставлять сервер-сироту
  throw new Error(`сервер не стартовал: ${fs.readFileSync(logPath, 'utf8').slice(-400)}`);
}

function sampleServer(pid, samples) {
  try {
    const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
    samples.push({ rssMb: Math.round(rss / 1024), cpu });
  } catch { /* процесс мог уже выйти */ }
}

// Ограниченный параллелизм для подготовки (создание и регистрация 300 машин)
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next; next += 1; await fn(items[i], i); }
  }));
}

async function main() {
  const loopLag = monitorEventLoopDelay({ resolution: 20 });
  loopLag.enable();
  // своя временная папка: база с -wal/-shm, лог и каталог relay сервера; в конце удаляется целиком
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enotdesk-load-'));
  const removeWorkDir = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* уборка не роняет прогон */ } };
  const dbPath = path.join(workDir, 'load.db');
  const admin = { login: 'loadadmin', password: crypto.randomBytes(18).toString('base64url'), ip: '10.80.0.1' };
  const srv = await startServer(dbPath, admin).catch((e) => { removeWorkDir(); throw e; });
  base = `http://127.0.0.1:${srv.port}`;
  const serverSamples = [];
  const sampler = setInterval(() => sampleServer(srv.child.pid, serverSamples), 5000);
  const report = { config: CFG, startedAt: new Date().toISOString() };
  let stopReaders = () => {};
  try {
    const health = await api('health', 'GET', '/health', { ip: admin.ip });
    report.serverVersion = health.data.version;
    log(`сервер ${health.data.version} на :${srv.port}; агентов ${CFG.agents}, сеансов ${CFG.sessions} (машинных ${CFG.machineSessions})`);
    const login = await api('auth.login', 'POST', '/auth/login', { body: { login: admin.login, password: admin.password }, ip: admin.ip });
    if (!login.data.token) throw new Error(`вход админа: HTTP ${login.status}`);
    admin.token = login.data.token;

    // операторы по приглашениям — каждый со своего адреса
    const ops = [];
    for (let i = 0; i < CFG.operators; i += 1) {
      const ip = fakeIp(79, i);
      const inv = await api('invites.create', 'POST', '/invites', { token: admin.token, body: { role: 'operator' }, ip: admin.ip });
      const password = crypto.randomBytes(18).toString('base64url');
      const acc = await api('invites.accept', 'POST', '/invites/accept', { body: { token: inv.data.token, login: `loadop${i}`, name: `Оператор ${i}`, password }, ip });
      expect('invites.accept', acc, 200, 201);
      const l = await api('auth.login', 'POST', '/auth/login', { body: { login: `loadop${i}`, password }, ip });
      if (!l.data.token) throw new Error(`вход оператора ${i}: HTTP ${l.status}`);
      ops.push({ token: l.data.token, ip });
    }

    // 300 машин: код у админа → регистрация агента
    let t0 = performance.now();
    for (let i = 0; i < CFG.agents; i += 1) agents.push({ idx: i, ip: fakeIp(77, i) });
    await pool(agents, 20, async (a) => {
      const m = await api('machines.create', 'POST', '/machines', { token: admin.token, body: { name: `load-${a.idx}`, group: 'нагрузка' }, ip: admin.ip });
      if (!expect('machines.create', m, 201)) return;
      const r = await api('agent.register', 'POST', '/agent/register', { body: { code: m.data.code, name: `load-${a.idx}`, os: 'Windows 11', version: '0.6.28' }, ip: a.ip });
      if (!expect('agent.register', r, 201)) return;
      a.token = r.data.token;
      a.machineId = r.data.machineId;
    });
    report.setupMs = Math.round(performance.now() - t0);
    const enrolled = agents.filter((a) => a.token);
    log(`зарегистрировано агентов ${enrolled.length} за ${report.setupMs} мс`);
    enrolled.forEach(startAgent);
    stopReaders = startReaders(ops, admin);
    await sleep(CFG.heartbeatMs * 2); // все агенты успели отметиться

    // подъём сеансов: равномерно за LOAD_RAMP_S (как приходят обращения), операторы по кругу
    t0 = performance.now();
    const starts = [];
    const spread = (CFG.rampS * 1000) / Math.max(1, CFG.sessions);
    for (let i = 0; i < CFG.sessions; i += 1) {
      const op = ops[i % ops.length];
      const run = i < CFG.attendedSessions
        ? () => attendedSession(i, op)
        : () => machineSession(enrolled[i - CFG.attendedSessions], op);
      starts.push(sleep(Math.round(i * spread)).then(run).catch((e) => sessionsState.failed.push(`сеанс ${i}: ${e.message}`)));
    }
    await Promise.all(starts);
    report.sessionsUpMs = Math.round(performance.now() - t0);
    log(`сеансов поднято ${sessionsState.approved} из ${CFG.sessions} за ${report.sessionsUpMs} мс; устойчивая фаза ${CFG.durationS} с`);

    await sleep(CFG.durationS * 1000);

    // онлайн к концу — по списку машин (страницами по 100)
    let online = 0;
    for (let off = 0; off < CFG.agents; off += 100) {
      const l = await api('machines.list', 'GET', `/machines?limit=100&offset=${off}`, { token: admin.token, ip: admin.ip });
      online += (l.data.items ?? []).filter((m) => m.online && m.name?.startsWith('load-')).length;
    }
    report.agents = { planned: CFG.agents, registered: enrolled.length, onlineAtEnd: online };

    stopping = true;
    stopReaders();
    for (const a of agents) { clearTimeout(a.beatTimer); clearTimeout(a.pollTimer); }
    await Promise.all(live.map((s) => s.end().catch((e) => rec.error('sessions.end', e.message))));
  } catch (e) {
    report.error = e.message;
  } finally {
    stopping = true;
    stopReaders();
    for (const a of agents) { clearTimeout(a.beatTimer); clearTimeout(a.pollTimer); a.ws?.close(); }
    clearInterval(sampler);
    sampleServer(srv.child.pid, serverSamples);
    srv.child.kill('SIGTERM');
    await new Promise((r) => { if (srv.child.exitCode != null) r(); else { srv.child.once('exit', r); setTimeout(r, 5000); } });
    removeWorkDir();
    loopLag.disable();
  }

  report.api = rec.summary();
  report.ws = wsRec.summary();
  report.sessions = { planned: sessionsState.planned, approved: sessionsState.approved, failed: sessionsState.failed.slice(0, 20) };
  report.agents ??= { planned: CFG.agents, registered: agents.filter((a) => a.token).length, onlineAtEnd: 0 };
  report.server = serverSamples.length ? {
    rssPeakMb: Math.max(...serverSamples.map((s) => s.rssMb)),
    cpuAvgPct: Math.round(serverSamples.reduce((s, x) => s + x.cpu, 0) / serverSamples.length),
  } : null;
  // задержка event loop генератора: если она велика, замеры завышены самим генератором
  report.generator = { loopLagP99Ms: Math.round(loopLag.percentile(99) / 1e6), cpus: os.cpus().length, platform: `${os.platform()} ${os.release()}` };
  const v = report.error
    ? { ok: false, failures: [report.error] }
    : verdict({ api: report.api, ws: report.ws, sessions: report.sessions, agents: report.agents, p95Ms: CFG.p95Ms, slowP95Ms: CFG.slowP95Ms });
  report.ok = v.ok;
  report.failures = v.failures;
  if (process.env.LOAD_REPORT) fs.writeFileSync(process.env.LOAD_REPORT, JSON.stringify(report, null, 2));

  console.log('\nкласс                 запросов   p50    p95    p99    max  ошибок');
  for (const [cls, s] of Object.entries({ ...report.api, ...Object.fromEntries(Object.entries(report.ws).map(([k, x]) => [`ws ${k}`, x])) })) {
    const f = (v) => String(v ?? '—').padStart(6);
    console.log(`${cls.padEnd(22)}${String(s.count).padStart(8)} ${f(s.p50)} ${f(s.p95)} ${f(s.p99)} ${f(s.max)} ${String(s.errors).padStart(6)}`);
  }
  console.log(`\nагенты: онлайн к концу ${report.agents.onlineAtEnd} из ${report.agents.planned}; сеансы: ${report.sessions.approved} из ${report.sessions.planned}`);
  if (report.server) console.log(`сервер: пик памяти ${report.server.rssPeakMb} МБ, CPU в среднем ${report.server.cpuAvgPct}%`);
  console.log(`генератор: задержка event loop p99 ${report.generator.loopLagP99Ms} мс`);
  console.log(report.ok ? `LOAD PASS: p95 ≤${CFG.p95Ms} мс (вход и приглашения ≤${CFG.slowP95Ms} мс), ошибок нет` : `LOAD FAIL:\n- ${report.failures.join('\n- ')}`);
  process.exit(report.ok ? 0 : 1);
}

await main();

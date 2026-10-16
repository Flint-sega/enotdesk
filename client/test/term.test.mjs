// Шов терминала (spec R09/R09.1, interfaces.md): createTerm — фейк-PTY,
// spawnShellFor — чистый резолв оболочки по ОС, createTermHost — DC-протокол
// и лимиты (1 на машину, кольцо 512 КБ, простой 5 мин). Реальные оболочки —
// MANUAL-QA; в тестах spawn и каналы только фейковые.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerm, spawnShellFor, createTermHost, rejectTermChannel,
  normalizeTermInput, killProcessTree,
  TERM_BUFFER_LIMIT,
} from '../lib/term.mjs';
import { createAgent } from '../lib/agent.mjs';

// ---- фейк-PTY: минимальный proc-адаптер с ручной подкачкой событий ----

function fakeProc() {
  const proc = {
    written: [],
    killed: 0,
    resized: [],
    dataCbs: [],
    exitCbs: [],
    write(data) { proc.written.push(data); },
    kill() { proc.killed += 1; if (!proc.exited) { proc.exited = true; for (const cb of proc.exitCbs) cb({ code: 0 }); } },
    resize(cols, rows) { proc.resized.push([cols, rows]); },
    onData(cb) { proc.dataCbs.push(cb); },
    onExit(cb) { proc.exitCbs.push(cb); },
    emit(data) { for (const cb of proc.dataCbs) cb(data); },
    exited: false,
  };
  return proc;
}

function fakeChannel() {
  const ch = {
    readyState: 'open',
    sent: [],
    closed: 0,
    onopen: null, onmessage: null, onclose: null,
    send(m) { ch.sent.push(m); },
    close() { ch.closed += 1; ch.readyState = 'closed'; if (ch.onclose) ch.onclose(); },
    recv(obj) { if (ch.onmessage) ch.onmessage({ data: JSON.stringify(obj) }); },
    open() { if (ch.onopen) ch.onopen(); },
  };
  return ch;
}

test('spawnShellFor: windows — powershell, контекст SYSTEM (честно)', () => {
  const s = spawnShellFor('win32');
  assert.equal(s.file, 'powershell.exe');
  assert.deepEqual(s.args, ['-NoProfile', '-NoLogo']);
  assert.equal(s.context, 'SYSTEM');
});

test('spawnShellFor: linux — sudo -u <console-user> bash, без пользователя — bash службы', () => {
  const s = spawnShellFor('linux', { consoleUser: 'ivan' });
  assert.equal(s.file, 'sudo');
  assert.deepEqual(s.args, ['-u', 'ivan', 'bash']);
  assert.equal(s.context, 'ivan');
  const fb = spawnShellFor('linux');
  assert.equal(fb.file, 'bash');
  assert.equal(fb.context, 'service');
});

test('spawnShellFor: darwin — launchctl asuser + zsh (best-effort), без uid — zsh службы', () => {
  const s = spawnShellFor('darwin', { consoleUser: 'ivan', uid: 501 });
  assert.equal(s.file, 'launchctl');
  assert.deepEqual(s.args, ['asuser', '501', '/bin/zsh']);
  assert.equal(s.context, 'ivan');
  const fb = spawnShellFor('darwin');
  assert.equal(fb.file, '/bin/zsh');
  assert.equal(fb.context, 'service');
});

test('createTerm: write/onData/kill поверх фейк-PTY, буфер отдаёт вывод', () => {
  const proc = fakeProc();
  const opened = [];
  const term = createTerm({
    shell: { file: 'bash', args: [] },
    cols: 80, rows: 24,
    spawn: ({ shell }) => { opened.push(shell.file); return proc; },
  });
  assert.deepEqual(opened, ['bash']);
  const chunks = [];
  term.onData((d) => chunks.push(d));
  proc.emit('привет\n');
  assert.deepEqual(chunks, ['привет\n']);
  assert.equal(term.buffer(), 'привет\n');
  assert.equal(term.write('ls\r'), true);
  assert.deepEqual(proc.written, ['ls\r']);
  assert.deepEqual(proc.resized, []);
  term.resize(120, 40);
  assert.deepEqual(proc.resized, [[120, 40]]);
  term.kill();
  assert.equal(proc.killed, 1);
  // после kill запись закрыта и повторный kill не бьёт процесс
  assert.equal(term.write('x'), false);
  term.kill();
  assert.equal(proc.killed, 1);
});

test('createTerm: кольцевой буфер держит хвост не больше 512 КБ', () => {
  const proc = fakeProc();
  const term = createTerm({
    shell: { file: 'bash', args: [] },
    spawn: () => proc,
    bufferLimit: TERM_BUFFER_LIMIT,
  });
  const chunk = 'x'.repeat(64 * 1024); // 64 КБ
  for (let i = 0; i < 10; i += 1) proc.emit(chunk); // 640 КБ
  const buf = term.buffer();
  assert.ok(Buffer.byteLength(buf) <= TERM_BUFFER_LIMIT);
  assert.ok(Buffer.byteLength(buf) >= TERM_BUFFER_LIMIT - 64 * 1024);
  // голова вытеснена: остался ровно хвост из 8 полных кусков (512 КБ)
  assert.equal(buf, chunk.repeat(8));
});

test('createTerm: простой 5 мин (здесь 30 мс) закрывает терминал, активность продлевает', async () => {
  const proc = fakeProc();
  const exits = [];
  const term = createTerm({
    shell: { file: 'bash', args: [] },
    spawn: () => proc,
    idleTimeoutMs: 30,
  });
  term.onExit((e) => exits.push(e));
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(exits, [{ reason: 'idle-timeout' }]);
  assert.equal(proc.killed, 1);
  assert.equal(term.write('x'), false); // убит по таймауту

  const proc2 = fakeProc();
  const exits2 = [];
  const term2 = createTerm({
    shell: { file: 'bash', args: [] },
    spawn: () => proc2,
    idleTimeoutMs: 40,
  });
  term2.onExit((e) => exits2.push(e));
  // активность каждые 15 мс держит терминал живым дольше одного таймаута
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 15));
    term2.write(`line ${i}\r`);
  }
  assert.deepEqual(exits2, []);
  term2.kill();
});

test('createTermHost: открытие по каналу, протокол in/out/resize/close, активность наружу', async () => {
  const proc = fakeProc();
  const activeStates = [];
  const host = createTermHost({
    platform: 'win32',
    createTerm: (opts) => {
      assert.equal(opts.shell.file, 'powershell.exe');
      assert.equal(opts.cols, 80);
      assert.equal(opts.rows, 24);
      return createTerm({ ...opts, spawn: () => proc });
    },
    onActiveChange: (v) => activeStates.push(v),
  });
  assert.equal(host.isActive(), false);
  const ch = fakeChannel();
  assert.equal(host.handleChannel(ch), true);
  ch.open();
  assert.deepEqual(activeStates, [true]);
  assert.equal(host.isActive(), true);
  const opened = ch.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'opened');
  assert.equal(opened.context, 'SYSTEM');
  proc.emit('готово\n');
  const out = ch.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'out');
  assert.deepEqual(out, [{ type: 'out', data: 'готово\n' }]);
  ch.recv({ type: 'in', data: 'dir\r' });
  assert.deepEqual(proc.written, ['dir\r']);
  ch.recv({ type: 'resize', cols: 100, rows: 30 });
  assert.deepEqual(proc.resized, [[100, 30]]);
  // мусор и неизвестные типы игнорируются (allowlist), процесс не падает
  ch.recv({ type: 'reboot' });
  ch.recv('not-json');
  assert.equal(proc.killed, 0);
  ch.recv({ type: 'close' });
  assert.equal(proc.killed, 1);
  assert.deepEqual(activeStates, [true, false]);
  assert.equal(host.isActive(), false);
  assert.ok(ch.closed >= 1);
});

test('createTermHost: второй канал отклоняется (1 терминал на машину)', () => {
  const proc = fakeProc();
  const host = createTermHost({
    platform: 'linux',
    consoleUser: 'ivan',
    createTerm: (opts) => createTerm({ ...opts, spawn: () => proc }),
  });
  const first = fakeChannel();
  assert.equal(host.handleChannel(first), true);
  first.open(); // канал открыт — слот занят
  const second = fakeChannel();
  assert.equal(host.handleChannel(second), false); // отклонён
  assert.equal(host.isActive(), true);
  const err = second.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'error');
  assert.equal(err.code, 'term-busy');
  assert.ok(second.closed >= 1);
});

test('createTermHost: обрыв канала убивает терминал; выход оболочки уведомляет оператора', async () => {
  const proc = fakeProc();
  const host = createTermHost({
    platform: 'darwin',
    uid: 501,
    createTerm: (opts) => createTerm({ ...opts, spawn: () => proc }),
  });
  const ch = fakeChannel();
  host.handleChannel(ch);
  ch.open();
  ch.close(); // оператор закрыл канал
  assert.equal(proc.killed, 1);
  assert.equal(host.isActive(), false);

  const proc2 = fakeProc();
  const host2 = createTermHost({
    platform: 'linux',
    createTerm: (opts) => createTerm({ ...opts, spawn: () => proc2 }),
  });
  const ch2 = fakeChannel();
  host2.handleChannel(ch2);
  ch2.open();
  proc2.emit('ok');
  proc2.kill(); // оболочка завершилась сама
  const exit = ch2.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'exit');
  assert.equal(exit.reason, 'exit');
  assert.equal(host2.isActive(), false);
});

test('createTerm: один кусок крупнее лимита — buffer() не превышает лимит (граница)', () => {
  const proc = fakeProc();
  const term = createTerm({
    shell: { file: 'bash', args: [] },
    spawn: () => proc,
    bufferLimit: 1024,
  });
  proc.emit('y'.repeat(4096)); // 4 КБ при лимите 1 КБ
  const buf = term.buffer();
  assert.ok(Buffer.byteLength(buf) <= 1024);
  assert.ok(buf.endsWith('y'.repeat(16))); // хвост куска сохранён
});

test('rejectTermChannel: attended-хост честно отказывает term-unavailable', async () => {
  const ch = fakeChannel();
  rejectTermChannel(ch);
  const err = ch.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'error');
  assert.equal(err.code, 'term-unavailable');
  await new Promise((r) => setTimeout(r, 150)); // пауза «дать ошибке уйти»
  assert.ok(ch.closed >= 1);
});

// ---- цепочка агента (dos-условие 1): approved → pc → offer → answer → канал ----

function fakePc() {
  const pc = {
    remoteDescription: null, localDescription: null, closed: false,
    ondatachannel: null, onicecandidate: null,
    async setRemoteDescription(d) { pc.remoteDescription = d; },
    async createAnswer() { return { type: 'answer', sdp: 'v=0 fake-answer' }; },
    async setLocalDescription(d) { pc.localDescription = d; },
    async addIceCandidate() {},
    close() { pc.closed = true; },
  };
  return pc;
}

test('агент: approved → RTCPeerConnection без медиа → offer оператора → answer → term-канал отвечает', async () => {
  const sent = [];
  const heartbeats = [];
  let handler = null;
  const signalClient = {
    onMessage(cb) { handler = cb; return () => { handler = null; }; },
    async open() { return { type: 'ready', role: 'host', sessionId: 777, state: 'waiting' }; },
    heartbeat(extra) { heartbeats.push(extra); },
    sendSignal(data) { sent.push(data); },
    close() {},
  };
  const decisions = [];
  const api = {
    register: async () => ({ status: 201, body: { token: 'tok', machineId: 'm1' } }),
    session: async () => ({ status: 200, body: { sessionId: 777, state: 'pending-consent' } }),
    heartbeat: async () => ({ status: 200, body: { ok: true } }),
    decision: async (d) => { decisions.push(d); return { status: 200, body: {} }; },
  };
  const native = { load() {}, end() {}, status: () => ({ ok: true }) };

  const proc = fakeProc();
  const host = createTermHost({
    platform: 'win32',
    createTerm: (opts) => createTerm({ ...opts, spawn: () => proc }),
  });
  const pcs = [];
  const agent = createAgent({
    api,
    signal: () => signalClient,
    native,
    policy: { name: 'm', os: 'win32', version: '1', heartbeatMs: 10 },
    termHost: host,
    rtc: () => { const pc = fakePc(); pcs.push(pc); return pc; },
  });
  assert.equal(agent.start({ code: 'ONBOARD' }).ok, true); // первая регистрация — по одноразовому коду
  try {
    await new Promise((r) => setTimeout(r, 30)); // регистрация → опрос → open host-ролью
  handler({ type: 'claim', claimId: 'c1' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(decisions, [{ sessionId: 777, token: 'tok', claimId: 'c1', allow: true }]);

  handler({ type: 'approved' });
  assert.equal(pcs.length, 1); // pc создан, медиа-треков нет по построению фейка

  // оператор офферит — агент отвечает answer'ом через сигнал
  handler({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0 op-offer' } } });
  await new Promise((r) => setTimeout(r, 5));
  // answer обязан уйти в конверте {type:'signal', data:…}: клиентский
  // validateOutgoingSignal (signal.sendSignal) кидает на всём остальном — сигнал
  // вообще не выходил на провод (регресс живого сеанса 28.09, дефект №12)
  const answer = sent.find((d) => d.type === 'signal' && d.data?.description?.type === 'answer');
  assert.ok(answer, 'answer не отправлен (или без конверта signal/data)');
  assert.equal(answer.data.description.sdp, 'v=0 fake-answer');

  // агент принимает канал term → терминал открывается и отвечает выводом
  const ch = fakeChannel();
  ch.label = 'term';
  pcs[0].ondatachannel({ channel: ch });
  ch.open();
  assert.equal(host.isActive(), true);
  proc.emit('C:\\> ');
  const out = ch.sent.map((m) => JSON.parse(m)).find((m) => m.type === 'out');
  assert.equal(out.data, 'C:\\> ');
  await new Promise((r) => setTimeout(r, 25)); // ждём тик wsBeat (10 мс) с живым терминалом
  assert.ok(heartbeats.some((h) => h?.termActive === true), 'termActive не дошёл до heartbeat');

  // посторонний канал не открывает терминал; G2 (16.10): chat-канал без
  // services больше НЕ закрывается — он живёт релеем сообщений операторов
  const rogue = fakeChannel();
  rogue.label = 'garbage';
  pcs[0].ondatachannel({ channel: rogue });
  assert.ok(rogue.closed >= 1);
  const chatCh = fakeChannel();
  chatCh.label = 'chat';
  pcs[0].ondatachannel({ channel: chatCh });
  assert.equal(chatCh.closed, 0, 'G2: chat без services живёт (релей операторам)');
  assert.equal(host.isActive(), true, 'чат-канал терминал не трогает');

  } finally {
    // гарантируем остановку: иначе интервалы агента держат процесс тестов живым
    agent.stop();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(proc.killed >= 1, true); // остановка агента убивает терминал
});

test('агент: моста нет (rtc → null) — терминал честно недоступен, сеанс живёт', async () => {
  const heartbeats = [];
  let handler = null;
  const signalClient = {
    onMessage(cb) { handler = cb; return () => { handler = null; }; },
    async open() { return { type: 'ready', role: 'host', sessionId: 778, state: 'waiting' }; },
    heartbeat(extra) { heartbeats.push(extra); },
    sendSignal() {},
    close() {},
  };
  const api = {
    register: async () => ({ status: 201, body: { token: 't', machineId: 'm' } }),
    session: async () => ({ status: 200, body: { sessionId: 778, state: 'pending-consent' } }),
    heartbeat: async () => ({ status: 200, body: {} }),
    decision: async () => ({ status: 200, body: {} }),
  };
  const host = createTermHost({ platform: 'win32', createTerm: (o) => createTerm({ ...o, spawn: () => fakeProc() }) });
  const agent = createAgent({
    api,
    signal: () => signalClient,
    native: { load() {}, end() {}, status: () => ({}) },
    policy: { name: 'm', os: 'win32', version: '1', heartbeatMs: 10 },
    termHost: host,
    rtc: () => null, // main не смог собрать мост (нет RTCPeerConnection и т.п.)
  });
  agent.start({ code: 'ONBOARD' });
  try {
    await new Promise((r) => setTimeout(r, 30));
    handler({ type: 'approved' });
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(!heartbeats.some((h) => h?.termActive === true), 'без моста терминал не может быть активен');
    assert.equal(agent.status().state, 'online'); // сеанс жив, терминал просто недоступен
  } finally {
    agent.stop();
    await new Promise((r) => setTimeout(r, 5));
  }
});

// ---- волна 0.6.19: normalizeTermInput + killProcessTree ----

test('term: normalizeTermInput превращает CR в \\n, не трогая \\r\\n и мультибайты', () => {
  assert.equal(normalizeTermInput('ls\r'), 'ls\n', 'одиночный \\r — терминатор для пайп-bash');
  assert.equal(normalizeTermInput('a\r\nb'), 'a\nb', '\\r\\n схлопывается в \\n без дубля');
  assert.equal(normalizeTermInput('a\nb'), 'a\nb', '\\n не трогается');
  assert.equal(normalizeTermInput('привет\rмир'), 'привет\nмир', 'мультибайты не рвутся');
  assert.equal(normalizeTermInput(''), '');
  assert.equal(normalizeTermInput(42), 42, 'не-строка проходит как есть');
});

test('term: killProcessTree — posix бьёт группу и ребёнка, win только ребёнка, мусор честный false', () => {
  const calls = [];
  const killImpl = (pid, sig) => calls.push([pid, sig]);

  calls.length = 0;
  assert.equal(killProcessTree({ pid: 4242, platform: 'linux', killImpl }), true);
  assert.deepEqual(calls, [[-4242, 'SIGKILL'], [4242, 'SIGKILL']], 'posix: группа (-pid) затем прямой pid');

  calls.length = 0;
  assert.equal(killProcessTree({ pid: 4242, platform: 'darwin', killImpl }), true);
  assert.deepEqual(calls, [[-4242, 'SIGKILL'], [4242, 'SIGKILL']], 'darwin тоже posix-группа');

  calls.length = 0;
  assert.equal(killProcessTree({ pid: 4242, platform: 'win32', killImpl }), true);
  assert.deepEqual(calls, [[4242, 'SIGKILL']], 'win: только прямой pid');

  // группа уже разошлась (ESRCH) — добиваем прямого ребёнка, наружу не бросаем
  calls.length = 0;
  const killGroupDead = (pid, sig) => { if (pid < 0) throw new Error('ESRCH'); calls.push([pid, sig]); };
  assert.equal(killProcessTree({ pid: 4242, platform: 'linux', killImpl: killGroupDead }), true);
  assert.deepEqual(calls, [[4242, 'SIGKILL']], 'отказ группы не роняет килл ребёнка');

  // pid уже мёртв целиком — false, без throw
  assert.equal(killProcessTree({ pid: 4242, platform: 'linux', killImpl: () => { throw new Error('ESRCH'); } }), false);

  // мусорные входы
  assert.equal(killProcessTree({ pid: 0, killImpl }), false);
  assert.equal(killProcessTree({ pid: undefined, killImpl }), false);
  assert.equal(killProcessTree({ pid: 4242, killImpl: 'nope' }), false);
});

test('term: defaultSpawn (реальный адаптер) нормализует ввод и умирает по киллу группы', async () => {
  if (process.platform === 'win32') return; // detached/группа — семантика POSIX
  const { createTerm } = await import('../lib/term.mjs');
  const node = process.execPath;
  // эхо: каждый чанк stdin печатаем как JSON-строку — видно, что дошло до процесса
  const shell = { file: node, args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(JSON.stringify(d.toString())))'] };
  const term = createTerm({ shell });
  term.write('x\r');
  await new Promise((r) => setTimeout(r, 250));
  const got = term.buffer();
  assert.ok(got.includes('"x\\n"'), `до процесса должен дойти x\n (нормализовано), факт: ${got}`);
  assert.ok(!got.includes('\r'), 'голый \r до процесса не доходит');
  let exitSeen = false;
  term.onExit(() => { exitSeen = true; });
  term.kill('closed');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(exitSeen, 'группа процессов убита — close дошёл');
});

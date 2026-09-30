import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, port, admin };
}

async function makeSession(base, port, admin) {
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;
  return { sessionId, hostToken, host, claimId };
}

test('heartbeat обновляет lease: без него сеанс истекает, с ним живёт', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 700, heartbeatMs: 200 });

  const { hostToken, host } = await makeSession(base, port, admin);
  // держим heartbeat ~1.4с (два lease-периода) — сеанс жив
  const ackP = host.wait((m) => m.type === 'heartbeat');
  for (let i = 0; i < 9; i++) {
    host.send(JSON.stringify({ type: 'heartbeat' }));
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal((await ackP).type, 'heartbeat');
  const endedP = host.wait((m) => m.type === 'ended', 3000);
  // перестаём слать — через lease сеанс истекает
  const h = await api(base, 'GET', '/history', { token: admin.token });
  assert.equal(h.json.items[0].state, 'pending-consent');
  const ended = await endedP;
  assert.equal(ended.reason, 'lease-expired');
  // наблюдаемое следствие: hostToken завершённого сеанса больше не даёт rtc-config
  const rtcAfter = await api(base, 'GET', '/rtc-config', { token: hostToken });
  assert.equal(rtcAfter.status, 401);
});

test('потеря host-сокета завершает сеанс и уведомляет оператора (graceMs=0, fail-closed)', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0 });
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host2 = wsConnect(port);
  await wsAuth(host2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const claim2 = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const op2 = wsConnect(port);
  await wsAuth(op2, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: claim2.json.claimId });

  const endedP = op2.wait((m) => m.type === 'ended');
  host2.close(); // host уходит без end
  assert.equal((await endedP).reason, 'host-lost');
});

test('потеря operator-сокета завершает сеанс и уведомляет host (graceMs=0, fail-closed)', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0 });
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const h2 = wsConnect(port);
  await wsAuth(h2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const c2 = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: c2.json.claimId });

  const endedP = h2.wait((m) => m.type === 'ended');
  op.close();
  assert.equal((await endedP).reason, 'operator-lost');
});

test('host подключается после claim: получает pending-consent и отложенный claim', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200 });
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;

  const host = wsConnect(port);
  const ready = await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  assert.equal(ready.state, 'pending-consent');
  const claimMsg = await host.wait((m) => m.type === 'claim');
  assert.equal(claimMsg.claimId, claimId);
});

test('operator подключается после approval: сразу получает approved', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200 });
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const { claimId } = claim.json;
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId, allow: true } });

  const op = wsConnect(port);
  const ready = await wsAuth(op, { type: 'auth', role: 'operator', sessionId, token: admin.token, claimId });
  assert.equal(ready.state, 'approved');
  const approved = await op.wait((m) => m.type === 'approved');
  assert.equal(approved.claimId, claimId);
});

// ---- грейс переподключения (ADR 0013) ----

async function approvedSession(base, port, admin) {
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  const claim = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const claimId = claim.json.claimId;
  const op = wsConnect(port);
  await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId });
  await api(base, 'POST', `/sessions/${s.sessionId}/decision`, { token: s.hostToken, body: { claimId, allow: true } });
  await host.wait((m) => m.type === 'approved');
  await op.wait((m) => m.type === 'approved');
  return { s, host, op, claimId };
}

// Ожидание НАБЛЮДАЕМОГО предусловия вместо слипа «в надежде»: слип после
// host.close() на медленном раннере кончался раньше обработки close, auth
// упирался в duplicate-4004 и ронял тест бессмысленным «timeout»
// (ревью v0.4.6)
async function waitFor(cond, ms = 2500, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  assert.ok(cond(), 'наблюдаемое предусловие не выполнилось за отведённое время');
}

const peerNotes = (ws) => ws.log.filter((m) => m?.type === 'peer-reconnecting');

test('грейс: host переподключается тем же токеном — сеанс жив, обе стороны получают resumed', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 5000 });
  const { s, host, op, claimId } = await approvedSession(base, port, admin);

  const peerNoteP = op.wait((m) => m.type === 'peer-reconnecting');
  host.close(); // host «обрывается»
  assert.equal((await peerNoteP).role, 'host');

  // в грейсе lease не судья: heartbeat не идут дольше leaseMs, но сеанс не завершился
  await new Promise((r) => setTimeout(r, 700));

  const host2 = wsConnect(port);
  const ready = await wsAuth(host2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  assert.equal(ready.state, 'approved');
  // replay approved: ворота ввода на клиенте открываются только реальным approved
  assert.equal((await host2.wait((m) => m.type === 'approved')).claimId, claimId);
  assert.equal((await host2.wait((m) => m.type === 'resumed')).type, 'resumed');
  assert.equal((await op.wait((m) => m.type === 'resumed')).type, 'resumed');

  // heartbeat после переподключения снова продлевает lease
  host2.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal((await host2.wait((m) => m.type === 'heartbeat')).type, 'heartbeat');
});

test('грейс: operator переподключается — claimId тот же, resumed обоим', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 5000 });
  const { s, host, op, claimId } = await approvedSession(base, port, admin);

  const peerNoteP = host.wait((m) => m.type === 'peer-reconnecting');
  op.close();
  assert.equal((await peerNoteP).role, 'operator');

  const op2 = wsConnect(port);
  const ready = await wsAuth(op2, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId });
  assert.equal(ready.state, 'approved');
  assert.equal((await op2.wait((m) => m.type === 'approved')).claimId, claimId);
  await host.wait((m) => m.type === 'resumed');
  await op2.wait((m) => m.type === 'resumed');
});

test('грейс: переподключение другим токеном и до согласия — по-прежнему отказ', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 5000 });
  const { s, host } = await approvedSession(base, port, admin);

  // чужой hostToken не пускаем и в грейсе (сервер закрывает 4003 без сообщения)
  const other = await api(base, 'POST', '/sessions');
  const intruder = wsConnect(port);
  await intruder.opened;
  intruder.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: s.sessionId, token: other.json.hostToken }));
  assert.equal(await intruder.closeCode(), 4003);

  // до approval обрыв мгновенно завершает сеанс, грейс не применяется
  const reg = await api(base, 'POST', '/sessions');
  const h2 = wsConnect(port);
  await wsAuth(h2, { type: 'auth', role: 'host', sessionId: reg.json.sessionId, token: reg.json.hostToken });
  await api(base, 'POST', `/sessions/${reg.json.sessionId}/claim`, { token: admin.token, body: { password: reg.json.password } });
  h2.close();
  await new Promise((r) => setTimeout(r, 150));
  const h = await api(base, 'GET', '/history', { token: admin.token });
  const row = h.json.items.find((it) => it.id === reg.json.sessionId);
  assert.equal(row.state, 'ended');
  assert.equal(row.endReason, 'host-lost');
  void host;
});

test('грейс: истёкший грейс завершает сеанс как host-lost/operator-lost', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 60_000, heartbeatMs: 200, graceMs: 1200 });
  const { host, op } = await approvedSession(base, port, admin);

  const resumed = op.wait((m) => m.type === 'ended', 4000);
  host.close();
  const ended = await resumed;
  assert.equal(ended.reason, 'host-lost', 'по истечении грейса сеанс завершается с честной причиной');
});

// ---- грейс от истечения лизинга (№13b, ретест 28–29.09) ----
// «Тихая смерть»: host жив сокетом (WS не закрыт), но heartbeat'ов нет. Свипер
// объявляет грейс СРАЗУ при истечении лизинга — раньше во всём окне
// «лизинг истёк → пинг → terminate» ретраи отбивались 4003, и клиент по
// контракту «4003 = сеанса нет» честно завершался при живом сеансе.

test('№13b: ретрай в пинг-окне не 4003, после terminate принимается — сеанс жив', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 5000 });
  const { s, host, op, claimId } = await approvedSession(base, port, admin);

  // хост молчит без close — свипер объявляет грейс и уведомляет оператора
  assert.equal((await op.wait((m) => m.type === 'peer-reconnecting', 4000)).role, 'host');

  // ретрай теми же токенами при ещё живом (серверно) старом сокете: duplicate-чек
  // даёт 4004 (клиент ретраит сквозь него), но НИКОГДА 4003 — это и есть №13b
  const retry1 = wsConnect(port);
  await retry1.opened;
  retry1.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken }));
  assert.equal(await retry1.closeCode(), 4004);

  // свипер не дождался pong'а → terminate; тестовый ws-клиент отвечает pong'ы
  // сам (стек), поэтому слот освобождаем close'ом — тот же close-обработчик,
  // что и после серверного terminate: rt.hostWs = null + participantLost,
  // который НЕ двигает объявленный свипером грейс
  host.close();
  // close обработан, когда participantLost долил оператору ВТОРОЙ
  // peer-reconnecting (объявление было первым) — не «через 150 мс»
  await waitFor(() => peerNotes(op).length >= 2);
  const host2 = wsConnect(port);
  const ready = await wsAuth(host2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  assert.equal(ready.state, 'approved');
  assert.equal((await host2.wait((m) => m.type === 'approved')).claimId, claimId);
  assert.equal((await host2.wait((m) => m.type === 'resumed')).type, 'resumed');
  assert.equal((await op.wait((m) => m.type === 'resumed')).type, 'resumed');

  // heartbeat возобновился — сеанс жив и после лизинг-окна (не lease-expired)
  host2.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal((await host2.wait((m) => m.type === 'heartbeat')).type, 'heartbeat');
  await new Promise((r) => setTimeout(r, 700));
  const h = await api(base, 'GET', '/history', { token: admin.token });
  const row = h.json.items.find((it) => it.id === s.sessionId);
  assert.notEqual(row.state, 'ended');
});

test('№13b: без ретрая и heartbeat — host-lost по истечении грейса, оператор предупреждён', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 1500 });
  const { host, op } = await approvedSession(base, port, admin);

  const endedP = op.wait((m) => m.type === 'ended', 6000);
  assert.equal((await op.wait((m) => m.type === 'peer-reconnecting', 4000)).role, 'host');
  const ended = await endedP;
  assert.equal(ended.reason, 'host-lost', 'грейс, объявленный от лизинга, кончился — host-lost, не lease-expired');
  host.close();
});

test('№13b: оживший heartbeat снимает объявленный грейс — оператору resumed, сеанс жив', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 2000 });
  const { s, host, op } = await approvedSession(base, port, admin);

  await op.wait((m) => m.type === 'peer-reconnecting', 4000);
  const resumedP = op.wait((m) => m.type === 'resumed', 4000);
  // хост «завис и ожил»: heartbeat по ещё живому (не терминированному) сокету
  host.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal((await resumedP).type, 'resumed');

  // держим heartbeat — сеанс переживает и лизинг-окно, и объявленный грейс
  for (let i = 0; i < 6; i++) {
    host.send(JSON.stringify({ type: 'heartbeat' }));
    await new Promise((r) => setTimeout(r, 300));
  }
  const h = await api(base, 'GET', '/history', { token: admin.token });
  const row = h.json.items.find((it) => it.id === s.sessionId);
  assert.notEqual(row.state, 'ended');
});

// ---- №13b доводка по ревью GLM-5.3 v0.4.4 ----

test('№13b: ретрай в зазоре «лизинг истёк, свипер ещё не объявил» — без 4003', async (t) => {
  // heartbeatMs=800: свипер впервые видит сеанс только на тике с
  // now > T_claim+1200 — зазор до первого объявляющего тика шире 750 мс,
  // ретрай на ~450 мс после claim попадает в него и на медленном раннере
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 800, graceMs: 5000 });
  const { s, host, op } = await approvedSession(base, port, admin);

  await new Promise((r) => setTimeout(r, 450));
  // Предусловие зазора — наблюдаемое: свипер ещё НЕ объявлял грейс оператору.
  // Без него покрытие мутации gate-4003 вероятностно (ревью v0.4.6)
  assert.equal(peerNotes(op).length, 0, 'ретрай обязан попасть в зазор ДО объявления грейса');
  const retry1 = wsConnect(port);
  await retry1.opened;
  retry1.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken }));
  // В зазоре live-сокет хоста даёт duplicate-4004 — клиент ретраит сквозь него;
  // фатального 4003 в утверждённом сеансе больше не существует вовсе
  assert.equal(await retry1.closeCode(), 4004);

  // слот освобождается → грейс от participantLost (первый peer-reconnecting
  // оператору) → ретрай принимается; ждём событие, а не «150 мс»
  host.close();
  await waitFor(() => peerNotes(op).length >= 1);
  const retry2 = wsConnect(port);
  const ready = await wsAuth(retry2, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });
  assert.equal(ready.state, 'approved');
  assert.equal((await retry2.wait((m) => m.type === 'resumed', 3000)).type, 'resumed');
  assert.equal((await op.wait((m) => m.type === 'resumed', 3000)).type, 'resumed');
});

test('№13b: close после объявления не двигает грейс (??=) — конец по расписанию от объявления', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 400, heartbeatMs: 200, graceMs: 1500 });
  const { s, host, op } = await approvedSession(base, port, admin);

  // T0 — момент объявления грейса (peer-reconnecting уходит оператору ровно в
  // объявлении). Поздний close «мёртвого» сокета (T0+1400) не сдвигает clock
  // грейса: ended обязан прийти к T0+2500 даже на медленном раннере (тик свипера
  // ≤1с поверх grace 1500). Мутант `=` вместо `??=` отложил бы конец на
  // close+grace ≈ T0+2900..3900. Детерминированно: ждём ended щедро, а ассерт —
  // по серверному endedAt из /history (без гонки доставки) — ревью v0.4.5
  // (фиксированное окно 2800 мс флакало на CI-macos).
  await op.wait((m) => m.type === 'peer-reconnecting', 4000);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 1400));
  host.close();
  const ended = await op.wait((m) => m.type === 'ended', 6000);
  assert.equal(ended.reason, 'host-lost');
  const h = await api(base, 'GET', '/history?limit=1', { token: admin.token });
  const row = h.json.items.find((it) => it.id === s.sessionId);
  const elapsed = Date.parse(row.endedAt) - t0;
  // потолок 2900, не 2800: джиттер тика свипера до ~800 мс не должен ронять
  // честный прогон (мутант `=` даёт ≥2900 всегда — различение сохранено,
  // ревью v0.4.6)
  assert.ok(elapsed >= 1000 && elapsed < 2900,
    `грейс должен тикать от ОБЪЯВЛЕНИЯ: endedAt-t0 = ${elapsed} мс (мутант = дал бы ≥2900)`);
});

test('№13b: лимит пинг-циклов — «тихо мёртвый» хост не держит слот бессрочно (HOST_PING_MAX)', async (t) => {
  // graceMs=0: грейс не объявляется, hostLostAt не ставится — каждый тик
  // свипера при истёкшем лизинге и живом (но молчащем) сокете хоста
  // инкрементит hostPingCount; после HOST_PING_MAX — честный lease-expired.
  // Раньше ветка не покрывалась ничем: удаление гварда проходило весь сюит
  // (ревью v0.4.6), а регресс вернул бы бессрочное занятие слота live/maxSessions
  const { base, port, admin } = await setup(t, { leaseMs: 300, heartbeatMs: 300, graceMs: 0, sweeperMs: 100 });
  const { s, host, op } = await approvedSession(base, port, admin);

  const ended = await op.wait((m) => m.type === 'ended', 8000);
  assert.equal(ended.reason, 'lease-expired', 'пинг-лимит должен гасить зомби-хост как lease-expired');
  const h = await api(base, 'GET', '/history', { token: admin.token });
  const row = h.json.items.find((it) => it.id === s.sessionId);
  assert.equal(row.endReason, 'lease-expired');
  host.close();
});

test('повторный decision allow — no-op: approved не рассылается дважды', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0 });
  const { s, claimId } = await approvedSession(base, port, admin);

  const approves = () => api(base, 'GET', '/audit?limit=100', { token: admin.token })
    .then((r) => r.json.items.filter((a) => a.action === 'session.approve' && a.targetId === s.sessionId));
  assert.equal((await approves()).length, 1, 'первое одобрение записано один раз');

  const repeat = await api(base, 'POST', `/sessions/${s.sessionId}/decision`, { token: s.hostToken, body: { claimId, allow: true } });
  assert.equal(repeat.status, 200);
  assert.equal((await approves()).length, 1, 'повторное одобрение — no-op: ни аудита, ни рассылки');
});

test('потолок живых сеансов: новые отклоняются (4005), свои и после освобождения слота — да', async (t) => {
  const { base, port, admin } = await setup(t, { leaseMs: 8000, heartbeatMs: 200, graceMs: 0, maxSessions: 1 });
  const reg = await api(base, 'POST', '/sessions');
  const s = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId: s.sessionId, token: s.hostToken });

  // свой оператор подключается, хотя потолок уже достигнут (сеанс A уже в live)
  const claim = await api(base, 'POST', `/sessions/${s.sessionId}/claim`, { token: admin.token, body: { password: s.password } });
  const op = wsConnect(port);
  const opReady = await wsAuth(op, { type: 'auth', role: 'operator', sessionId: s.sessionId, token: admin.token, claimId: claim.json.claimId });
  assert.equal(opReady.type, 'ready');

  // новый сеанс B — новый live-запись — отклонён честным server-busy
  const reg2 = await api(base, 'POST', '/sessions');
  const busy = wsConnect(port);
  await busy.opened;
  busy.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: reg2.json.sessionId, token: reg2.json.hostToken }));
  assert.equal(await busy.closeCode(), 4005);

  // завершение A освобождает слот — B подключается
  await api(base, 'POST', `/sessions/${s.sessionId}/end`, { token: s.hostToken, body: {} });
  const retry = wsConnect(port);
  const ready = await wsAuth(retry, { type: 'auth', role: 'host', sessionId: reg2.json.sessionId, token: reg2.json.hostToken });
  assert.equal(ready.type, 'ready');
});

test('connect-маршрут: свой claimId оператору без пароля (one-click), чужой/аноним/до-claim — отказ', async (t) => {
  const { base, admin } = await setup(t);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;

  // аноним — 401 (панель оператора требует вход; гостю вход не нужен)
  const anon = await api(base, 'GET', `/sessions/${sessionId}/connect`);
  assert.equal(anon.status, 401);

  // до claim сеанс никому не закреплён — даже админу 404
  const before = await api(base, 'GET', `/sessions/${sessionId}/connect`, { token: admin.token });
  assert.equal(before.status, 404);

  // авто-claim хаба (как в one-click) → connect отдаёт тот же claimId без пароля
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);
  const info = await api(base, 'GET', `/sessions/${sessionId}/connect`, { token: admin.token });
  assert.equal(info.status, 200);
  assert.equal(info.json.sessionId, sessionId);
  assert.equal(info.json.claimId, claim.json.claimId);
  assert.equal(info.json.state, 'pending-consent');

  // чужой оператор — 404 (сеанс закреплён не за ним)
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  assert.equal(inv.status, 201);
  const acc = await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login: 'op2', name: 'Op2', password: 'operator-pass-1' } });
  assert.equal(acc.status, 200);
  const opLogin = await api(base, 'POST', '/auth/login', { body: { login: 'op2', password: 'operator-pass-1' } });
  const alien = await api(base, 'GET', `/sessions/${sessionId}/connect`, { token: opLogin.json.token });
  assert.equal(alien.status, 404);

  // после завершения — 404
  await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken, body: {} });
  const after = await api(base, 'GET', `/sessions/${sessionId}/connect`, { token: admin.token });
  assert.equal(after.status, 404);

  // несуществующий ID — 404
  const missing = await api(base, 'GET', '/sessions/000000000/connect', { token: admin.token });
  assert.equal(missing.status, 404);
});

test('multi-operator: join по ID+паролю в approved, свой claimId, WS обоих, ended всем', async (t) => {
  const { base, port, admin } = await setup(t);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);
  const op1 = wsConnect(port);
  await wsAuth(op1, { type: 'auth', role: 'operator', sessionId, token: admin.token, claimId: claim.json.claimId });
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId: claim.json.claimId, allow: true } });

  // второй оператор: join по паролю в approved
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login: 'op2', name: 'Op2', password: 'operator-pass-2' } });
  const op2Login = await api(base, 'POST', '/auth/login', { body: { login: 'op2', password: 'operator-pass-2' } });
  const join = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: op2Login.json.token, body: { password } });
  t.diagnostic('join: ' + join.status + ' ' + JSON.stringify(join.json).slice(0, 140));
  assert.equal(join.status, 201, 'join в approved: 201');
  assert.equal(join.json.joined, true, 'помечен как присоединённый');
  assert.notEqual(join.json.claimId, claim.json.claimId, 'свой claimId');
  assert.equal(join.json.operator.login, 'op2', 'логин в ответе');

  // /connect: основному — сеансовый claimId, присоединённому — свой
  const c1 = await api(base, 'GET', `/sessions/${sessionId}/connect`, { token: admin.token });
  assert.equal(c1.json.claimId, claim.json.claimId);
  const c2 = await api(base, 'GET', `/sessions/${sessionId}/connect`, { token: op2Login.json.token });
  assert.equal(c2.json.claimId, join.json.claimId);

  // WS: хост получает operator-joined, оба оператора живут параллельно
  const op2ws = wsConnect(port);
  await wsAuth(op2ws, { type: 'auth', role: 'operator', sessionId, token: op2Login.json.token, claimId: join.json.claimId });
  const joined = await host.wait((m) => m.type === 'operator-joined', 3000);
  t.diagnostic('joined ok: ' + joined.operator.login);
  assert.equal(joined.operator.login, 'op2');

  // fan-out: host сигнал получают оба оператора
  host.send(JSON.stringify({ type: 'signal', data: { candidate: { candidate: 'c', sdpMid: '0' } } }));
  const got1 = await op1.wait((m) => m.type === 'signal', 2000).catch(() => null);
  const got2 = await op2ws.wait((m) => m.type === 'signal', 2000).catch(() => null);
  assert.ok(got1, 'первый оператор получил сигнал');
  assert.ok(got2, 'второй оператор получил сигнал');

  // end основным оператором: обе стороны и оба оператора получили ended
  await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken, body: {} });
  const e1 = await op1.wait((m) => m.type === 'ended', 2000).catch(() => null);
  const e2 = await op2ws.wait((m) => m.type === 'ended', 2000).catch(() => null);
  assert.ok(e1 && e2, 'ended доставлен обоим операторам');
  host.close(); op1.close(); op2ws.close();
});

test('idle: host завершает сеанс с причиной idle по POST end', async (t) => {
  const { base, admin } = await setup(t);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);
  await api(base, 'POST', `/sessions/${sessionId}/decision`, { token: hostToken, body: { claimId: claim.json.claimId, allow: true } });
  const end = await api(base, 'POST', `/sessions/${sessionId}/end`, { token: hostToken, body: { reason: 'idle' } });
  assert.equal(end.status, 200);
  const h = await api(base, 'GET', '/history?limit=1', { token: admin.token });
  assert.equal(h.json.items[0].endReason ?? h.json.items[0].reason, 'idle');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, tmpDb, ADMIN } from '../../server/test/util.mjs';
import { bootstrapAdmin } from '../../server/bootstrap.mjs';
import { createApi } from '../lib/api.mjs';
import { createSignalClient } from '../lib/signal.mjs';

// Шов: «Lifecycle and WS behavior tested against real service» — через собственные
// сетевые модули desktop (api.mjs/signal.mjs), как их использует main-процесс.

async function setup(t) {
  const dbPath = tmpDb(t);
  const { inst, port, base } = await startServer(t, { dbPath });
  return { inst, port, base, dbPath };
}

test('полный жизненный цикл через модули desktop: register → claim → approve → signal → end', async (t) => {
  const { port, base, dbPath } = await setup(t);
  bootstrapAdmin(dbPath, { login: ADMIN.login, name: 'Главный Енот', password: ADMIN.password });
  const api = createApi({ baseUrl: base });

  const login = await api.request('login', { login: ADMIN.login, password: ADMIN.password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const operator = { token: api.authToken, name: login.body.user.name };

  // 1. Клиент регистрирует сеанс (main делает это сам, токен остаётся в main)
  const created = await api.request('session.create', {});
  assert.equal(created.status, 201);
  const { sessionId, password } = created.body;
  // Контракт: 9-значный числовой ID, пароль непустой (длину генератора T01 не проверяем)
  assert.match(String(sessionId), /^\d{9}$/);
  assert.ok(created.body.password.length > 0);
  

  // 2. Оператор подключается по ID+паролю
  const claim = await api.request('session.claim', {
    token: operator.token, sessionId, password,
  });
  assert.equal(claim.status, 201);
  const claimId = claim.body.claimId;

  // 3. Host-сигналинг: main открывает WS с hostToken, получает ready + claim
  const host = createSignalClient({ url: `ws://127.0.0.1:${port}/signal`, wsFactory: (u) => new WebSocket(u) });
  const hostMsgs = [];
  host.onMessage((m) => hostMsgs.push(m));
  await host.open({ role: 'host', sessionId, hostToken: api.hostToken });
  assert.ok(hostMsgs.find((m) => m.type === 'ready' && m.role === 'host' && m.state === 'pending-consent'));
  const claimEv = hostMsgs.find((m) => m.type === 'claim');
  assert.equal(claimEv.claimId, claimId, 'имя оператора видно клиенту');
  assert.equal(claimEv.operator.name, operator.name);

  // 4. Клиент одобряет оператора по имени (решение UI → main → HTTP)
  const decision = await api.request('session.decision', {
    hostToken: api.hostToken, sessionId, claimId, allow: true,
  });
  assert.equal(decision.status, 200);

  // 5. Обе стороны получили approved; host офферится, оператор отвечает
  await host.wait((m) => m.type === 'approved' && m.claimId === claimId);
  const op = createSignalClient({ url: `ws://127.0.0.1:${port}/signal`, wsFactory: (u) => new WebSocket(u) });
  const opMsgs = [];
  op.onMessage((m) => opMsgs.push(m));
  await op.open({ role: 'operator', sessionId, token: operator.token, claimId });
  await op.wait((m) => m.type === 'approved');

  await host.sendSignal({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0 offer' } } });
  const offerAtOp = await op.wait((m) => m.type === 'signal' && m.data?.description?.type === 'offer');
  assert.equal(offerAtOp.data.description.sdp, 'v=0 offer');

  await op.sendSignal({ type: 'signal', data: { description: { type: 'answer', sdp: 'v=0 answer' } } });
  await host.wait((m) => m.type === 'signal' && m.data?.description?.type === 'answer');

  await op.sendSignal({ type: 'signal', data: { candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5 typ host' } } });
  await host.wait((m) => m.type === 'signal' && m.data?.candidate);

  // 6. Завершение host-токеном — обе стороны получают ended; сессия инвалидируется
  const end = await api.request('session.end', { sessionId, asHost: true });
  assert.equal(end.status, 200);
  const endedHost = await host.wait((m) => m.type === 'ended');
  const endedOp = await op.wait((m) => m.type === 'ended');
  assert.ok(endedHost.reason && endedOp.reason);

  host.close();
  op.close();
  await api.request('logout', { token: operator.token });

  // Повторное подключение со старым hostToken невозможно (R16: старые сокеты не работают)
  const stale = createSignalClient({ url: `ws://127.0.0.1:${port}/signal`, wsFactory: (u) => new WebSocket(u) });
  await assert.rejects(() => stale.open({ role: 'host', sessionId, hostToken: api.hostToken }), /closed 4003/);
  stale.close();
});

test('api.request не возвращает hostToken наружу рендерера (токены живут в main)', async (t) => {
  const { base } = await setup(t);
  const api = createApi({ baseUrl: base });
  const created = await api.request('session.create', {});
  assert.equal(created.status, 201);
  assert.equal(created.body.hostToken, undefined, 'renderer не должен получать hostToken');
  assert.ok(api.hostToken, 'токен остался в main для signaling/decision');
  assert.ok(created.body.sessionId && created.body.password);
});

test('недоступный сервер даёт честную ошибку, а не выдуманные данные', async (t) => {
  const api = createApi({ baseUrl: 'http://127.0.0.1:9' }); // ничего не слушает
  await assert.rejects(() => api.request('session.create', {}), /fetch failed|ECONNREFUSED|недоступен/i);
});

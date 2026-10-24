import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';

// ADR 0037 (Р11): обязательная 2FA для администраторов — переключатель админа.
// Пока у админа 2FA не включена, ему доступны только «кто я», выход, смена
// пароля и включение 2FA; операторов требование не касается.

async function invited(base, adminToken, role, login) {
  const inv = await api(base, 'POST', '/invites', { token: adminToken, body: { role } });
  assert.equal(inv.status, 201);
  const password = `pass-${login}-12345`;
  const acc = await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login, name: login, password } });
  assert.equal(acc.status, 200);
  const li = await api(base, 'POST', '/auth/login', { body: { login, password } });
  assert.equal(li.status, 200);
  return li.json.token;
}

test('обязательная 2FA для админов: включает только админ с 2FA; админ без 2FA — только настройка 2FA', async (t) => {
  const dbPath = tmpDb(t);
  const { base, inst } = await startServer(t, { dbPath, secretKey: 'a'.repeat(64) });
  const admin = await adminLogin(dbPath, base);
  const A = { token: admin.token };

  // по умолчанию требование выключено
  assert.deepEqual((await api(base, 'GET', '/settings/security', A)).json, { adminTotpRequired: false });

  // админ без своей 2FA включить требование не может — иначе запер бы себя
  const self = await api(base, 'POST', '/settings/security', { ...A, body: { adminTotpRequired: true } });
  assert.equal(self.status, 409);
  assert.equal(self.json.error.code, 'totp_required_self');

  const admin2 = await invited(base, admin.token, 'admin', 'admin-two');
  const oper = await invited(base, admin.token, 'operator', 'oper-one');

  // у первого админа 2FA включена (путь включения покрыт totp.test.mjs)
  inst.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(admin.user.id);
  const on = await api(base, 'POST', '/settings/security', { ...A, body: { adminTotpRequired: true } });
  assert.equal(on.status, 200);
  assert.equal(on.json.adminTotpRequired, true);
  assert.equal(inst.db.prepare("SELECT count(*) c FROM audit WHERE action = 'security.config'").get().c, 1, 'изменение — в журнале безопасности');

  // включение требования завершило входы админов без 2FA (решение владельца 24.10, P2-8)
  assert.equal((await api(base, 'GET', '/auth/me', { token: admin2 })).status, 401, 'старый вход второго админа погас');
  assert.match(inst.db.prepare("SELECT detail FROM audit WHERE action = 'security.config'").get().detail, /"signedOut":1/);
  assert.equal((await api(base, 'GET', '/contacts', { token: oper })).status, 200, 'входы операторов не тронуты');
  const relogin = await api(base, 'POST', '/auth/login', { body: { login: 'admin-two', password: 'pass-admin-two-12345' } });
  assert.equal(relogin.status, 200, 'войти можно — дальше только настройка 2FA');
  const admin2b = relogin.json.token;

  // второй админ без 2FA: всё, кроме настройки 2FA, — честный отказ
  const blocked = await api(base, 'GET', '/members', { token: admin2b });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'totp_setup_required');
  const me = await api(base, 'GET', '/auth/me', { token: admin2b });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.totpSetupRequired, true, 'панель знает, что вести в «Аккаунт»');
  const enable = await api(base, 'POST', '/auth/totp/enable', { token: admin2b, body: { password: 'pass-admin-two-12345' } });
  assert.equal(enable.status, 200, 'включение 2FA доступно');

  // оператора требование не касается; у админа с 2FA всё работает
  assert.equal((await api(base, 'GET', '/contacts', { token: oper })).status, 200);
  assert.equal((await api(base, 'GET', '/members', A)).status, 200);

  // выключили — второй админ снова работает
  assert.equal((await api(base, 'POST', '/settings/security', { ...A, body: { adminTotpRequired: false } })).status, 200);
  assert.equal((await api(base, 'GET', '/members', { token: admin2b })).status, 200);
});

test('настройки безопасности: читают admin и auditor, меняет только admin; мусор — 400', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const aud = await invited(base, admin.token, 'auditor', 'aud-one');
  const oper = await invited(base, admin.token, 'operator', 'oper-two');
  assert.equal((await api(base, 'GET', '/settings/security', { token: aud })).status, 200);
  assert.equal((await api(base, 'GET', '/settings/security', { token: oper })).status, 403);
  assert.equal((await api(base, 'POST', '/settings/security', { token: aud, body: { adminTotpRequired: false } })).status, 403);
  assert.equal((await api(base, 'POST', '/settings/security', { token: admin.token, body: { adminTotpRequired: 'yes' } })).status, 400);
});

// живой сеанс: оператор подключён к сеансу клиента (claim + WS оператора)
async function liveOperator(base, port, token) {
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token, body: { password } });
  assert.equal(claim.status, 201);
  const op = wsConnect(port);
  const ready = await wsAuth(op, { type: 'auth', role: 'operator', sessionId, token, claimId: claim.json.claimId });
  assert.equal(ready.type, 'ready');
  return { host, op, sessionId, claimId: claim.json.claimId };
}

test('живой WS админа без 2FA рвётся сразу при включении «2FA обязательна»; новый WS не открывается (P2-8)', async (t) => {
  const dbPath = tmpDb(t);
  const { base, port, inst } = await startServer(t, { dbPath, secretKey: 'a'.repeat(64), opAuthCheckMs: 60_000 });
  const admin = await adminLogin(dbPath, base);
  const admin2 = await invited(base, admin.token, 'admin', 'admin-live');
  const oper = await invited(base, admin.token, 'operator', 'oper-live');
  const a2 = await liveOperator(base, port, admin2);
  const o = await liveOperator(base, port, oper);
  t.after(() => { for (const w of [a2.host, a2.op, o.host, o.op]) w.terminate(); });

  inst.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(admin.user.id);
  const closed = a2.op.closeCode(3000); // свипер сверяет раз в минуту — значит, закрыл сам переключатель
  assert.equal((await api(base, 'POST', '/settings/security', { token: admin.token, body: { adminTotpRequired: true } })).status, 200);
  assert.equal(await closed, 4003);
  assert.equal(o.op.readyState, o.op.OPEN, 'оператора требование не касается');

  // вошёл заново (без 2FA) — к сеансу по WS не пускают, как и в REST
  const fresh = (await api(base, 'POST', '/auth/login', { body: { login: 'admin-live', password: 'pass-admin-live-12345' } })).json.token;
  const again = wsConnect(port);
  t.after(() => again.terminate());
  await again.opened;
  const code = again.closeCode(3000);
  again.send(JSON.stringify({ type: 'auth', role: 'operator', sessionId: a2.sessionId, token: fresh, claimId: a2.claimId }));
  assert.equal(await code, 4003);
});

test('вход отозван другим процессом (reset-2fa с консоли) — живой WS оператора закрывается свипером (P2-11)', async (t) => {
  const dbPath = tmpDb(t);
  const { base, port, inst } = await startServer(t, { dbPath, opAuthCheckMs: 50 });
  const admin = await adminLogin(dbPath, base);
  const oper = await invited(base, admin.token, 'operator', 'oper-reset');
  const o = await liveOperator(base, port, oper);
  t.after(() => { o.host.terminate(); o.op.terminate(); });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(o.op.readyState, o.op.OPEN, 'пока вход действителен — сеанс живёт');
  const closed = o.op.closeCode(5000);
  // reset-2fa работает с консоли на той же базе: удаляет входы пользователя, сервер об этом не знает
  inst.db.prepare("DELETE FROM auth_tokens WHERE user_id = (SELECT id FROM users WHERE login = 'oper-reset')").run();
  assert.equal(await closed, 4003);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb } from './util.mjs';

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

  // второй админ без 2FA: всё, кроме настройки 2FA, — честный отказ
  const blocked = await api(base, 'GET', '/members', { token: admin2 });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'totp_setup_required');
  const me = await api(base, 'GET', '/auth/me', { token: admin2 });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.totpSetupRequired, true, 'панель знает, что вести в «Аккаунт»');
  const enable = await api(base, 'POST', '/auth/totp/enable', { token: admin2, body: { password: 'pass-admin-two-12345' } });
  assert.equal(enable.status, 200, 'включение 2FA доступно');

  // оператора требование не касается; у админа с 2FA всё работает
  assert.equal((await api(base, 'GET', '/contacts', { token: oper })).status, 200);
  assert.equal((await api(base, 'GET', '/members', A)).status, 200);

  // выключили — второй админ снова работает
  assert.equal((await api(base, 'POST', '/settings/security', { ...A, body: { adminTotpRequired: false } })).status, 200);
  assert.equal((await api(base, 'GET', '/members', { token: admin2 })).status, 200);
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

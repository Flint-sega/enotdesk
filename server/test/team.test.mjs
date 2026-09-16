import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, ADMIN, tmpDb } from './util.mjs';
import { bootstrapAdmin } from '../bootstrap.mjs';

test('bootstrap: создаёт первого админа и отказывается перезаписывать существующего', async (t) => {
  const dbPath = tmpDb(t);
  const ok1 = bootstrapAdmin(dbPath, { login: 'boss', name: 'Босс', password: 'пароль-123456' });
  assert.equal(ok1.ok, true);
  const again = bootstrapAdmin(dbPath, { login: 'intruder', name: 'X', password: 'пароль-123456' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'exists');
});

test('login: неверный пароль — общий 401 без раскрытия деталей; me/logout работают', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  await bootstrapAdmin(dbPath, { login: ADMIN.login, name: 'A', password: ADMIN.password });

  const bad = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: 'совершенно-неверный' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'invalid_credentials');

  const noSuch = await api(base, 'POST', '/auth/login', { body: { login: 'nobody-here', password: 'x'.repeat(10) } });
  assert.equal(noSuch.status, 401);
  assert.equal(noSuch.json.error.code, bad.json.error.code);

  const good = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } });
  assert.equal(good.status, 200);
  assert.equal(good.json.user.role, 'admin');
  assert.match(good.json.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  const token = good.json.token;

  const me = await api(base, 'GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.login, ADMIN.login);

  const out = await api(base, 'POST', '/auth/logout', { token, body: {} });
  assert.equal(out.status, 200);
  const after = await api(base, 'GET', '/auth/me', { token });
  assert.equal(after.status, 401);
});

test('members: RBAC — auditor не видит список; admin понижает; последнего активного админа защитить', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);

  // приглашаем auditor и operator
  const invAud = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'auditor' } });
  const accAud = await api(base, 'POST', '/invites/accept', {
    body: { token: invAud.json.token, login: 'смотрящий', name: 'Смотрящий', password: 'пароль-auditor' },
  });
  assert.equal(accAud.status, 200);
  const aud = await api(base, 'POST', '/auth/login', { body: { login: 'смотрящий', password: 'пароль-auditor' } });

  const forbidden = await api(base, 'GET', '/members', { token: aud.json.token });
  assert.equal(forbidden.status, 403);

  const list = await api(base, 'GET', '/members', { token: admin.token });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 2);
  assert.ok(!('password' in list.json.items[0]));

  // последний активный админ: понижение самого себя запрещено
  const self = list.json.items.find((u) => u.login === ADMIN.login);
  const selfDemote = await api(base, 'PATCH', `/members/${self.id}`, { token: admin.token, body: { role: 'auditor' } });
  assert.equal(selfDemote.status, 409);

  // активный админ единственный: disable запрещён
  const selfOff = await api(base, 'PATCH', `/members/${self.id}`, { token: admin.token, body: { active: false } });
  assert.equal(selfOff.status, 409);

  // создаём второго админа — тогда понижение первого проходит
  const invAdm = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'admin' } });
  await api(base, 'POST', '/invites/accept', {
    body: { token: invAdm.json.token, login: 'второй-админ', name: 'Второй', password: 'пароль-второй' },
  });
  const demote = await api(base, 'PATCH', `/members/${self.id}`, { token: admin.token, body: { role: 'auditor' } });
  assert.equal(demote.status, 200);
  assert.equal(demote.json.user.role, 'auditor');
});

test('disable: отзывает токены и не пускает обратно; роль проверяется на каждом запросе', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);

  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  await api(base, 'POST', '/invites/accept', {
    body: { token: inv.json.token, login: 'оператор', name: 'Оп', password: 'пароль-опер-1' },
  });
  const op = await api(base, 'POST', '/auth/login', { body: { login: 'оператор', password: 'пароль-опер-1' } });
  assert.equal((await api(base, 'GET', '/contacts', { token: op.json.token })).status, 200);

  const list = await api(base, 'GET', '/members', { token: admin.token });
  const target = list.json.items.find((u) => u.login === 'оператор');
  const off = await api(base, 'PATCH', `/members/${target.id}`, { token: admin.token, body: { active: false } });
  assert.equal(off.status, 200);

  // старый токен больше не действует
  assert.equal((await api(base, 'GET', '/contacts', { token: op.json.token })).status, 401);
  // повторный вход запрещён
  assert.equal((await api(base, 'POST', '/auth/login', { body: { login: 'оператор', password: 'пароль-опер-1' } })).status, 401);
});

test('password: смена пароля — старый обязателен, прочие токены умирают, новый работает', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  await bootstrapAdmin(dbPath, { login: ADMIN.login, name: 'A', password: ADMIN.password });

  // два «устройства»
  const t1 = (await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } })).json.token;
  const t2 = (await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } })).json.token;

  // без авторизации — 401
  assert.equal((await api(base, 'PATCH', '/auth/password', { body: { oldPassword: ADMIN.password, newPassword: 'новый-пароль-123' } })).status, 401);
  // неверный старый — 403
  assert.equal((await api(base, 'PATCH', '/auth/password', { token: t1, body: { oldPassword: 'совсем-не-тот', newPassword: 'новый-пароль-123' } })).status, 403);
  // короткий новый — 400
  assert.equal((await api(base, 'PATCH', '/auth/password', { token: t1, body: { oldPassword: ADMIN.password, newPassword: 'коротко' } })).status, 400);

  // успешная смена с первого устройства
  const ok = await api(base, 'PATCH', '/auth/password', { token: t1, body: { oldPassword: ADMIN.password, newPassword: 'новый-пароль-123' } });
  assert.equal(ok.status, 200);

  // второй «устройство» выкинуто, первое живо
  assert.equal((await api(base, 'GET', '/auth/me', { token: t2 })).status, 401);
  assert.equal((await api(base, 'GET', '/auth/me', { token: t1 })).status, 200);

  // новый пароль работает, старый больше нет
  assert.equal((await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } })).status, 401);
  assert.equal((await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: 'новый-пароль-123' } })).status, 200);

  // смена записана в аудит
  const audit = await api(base, 'GET', '/audit?limit=50', { token: t1 });
  assert.ok(audit.json.items.some((a) => a.action === 'password.change'));
});

test('invites: одноразовость, отзыв, роль из приглашения, уникальный логин', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);

  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.json.invite.role, 'operator');
  assert.match(inv.json.url, /#token=/);
  // список без token-хешей
  const list = await api(base, 'GET', '/invites', { token: admin.token });
  assert.ok(!JSON.stringify(list.json).includes(inv.json.token));

  const body = { token: inv.json.token, login: '  Пришелец  ', name: 'П', password: 'пароль-пришельца' };
  assert.equal((await api(base, 'POST', '/invites/accept', { body })).status, 200);
  // повторное использование того же токена запрещено
  const dup = await api(base, 'POST', '/invites/accept', { body: { ...body, login: 'другой' } });
  assert.equal(dup.status, 400);

  // login нормализован к нижнему регистру
  const in2 = await api(base, 'POST', '/auth/login', { body: { login: 'пришелец', password: 'пароль-пришельца' } });
  assert.equal(in2.status, 200);

  // занятый логин не должен «съедать» приглашение (атомарность)
  const inv2 = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'auditor' } });
  const clash = await api(base, 'POST', '/invites/accept', {
    body: { token: inv2.json.token, login: 'ПРИШЕЛЕЦ', name: 'К', password: 'пароль-конфликта' },
  });
  assert.equal(clash.status, 409);
  // приглашение всё ещё принято вторым уникальным логином
  const reuse2 = await api(base, 'POST', '/invites/accept', {
    body: { token: inv2.json.token, login: 'свободный', name: 'С', password: 'пароль-свободного' },
  });
  assert.equal(reuse2.status, 200);

  // отзыв неиспользованного приглашения
  const inv3 = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  const del = await api(base, 'DELETE', `/invites/${inv3.json.invite.id}`, { token: admin.token });
  assert.equal(del.status, 200);
  const revoked = await api(base, 'POST', '/invites/accept', {
    body: { token: inv3.json.token, login: 'отзываемый', name: 'О', password: 'пароль-отзывной' },
  });
  assert.equal(revoked.status, 400);

  // не-админ не создаёт приглашения
  const opTok = (await api(base, 'POST', '/auth/login', { body: { login: 'пришелец', password: 'пароль-пришельца' } })).json.token;
  assert.equal((await api(base, 'POST', '/invites', { token: opTok, body: { role: 'admin' } })).status, 403);
});

test('invites: имя и логин ограничены по длине (без гигантских строк в БД)', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);

  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  assert.equal(inv.status, 201);

  const tooLongName = await api(base, 'POST', '/invites/accept', {
    body: { token: inv.json.token, login: 'нормальный', name: 'И'.repeat(121), password: 'пароль-длинного' },
  });
  assert.equal(tooLongName.status, 400);

  // приглашение не съедено отказом — принимаем с корректным логином
  const tooLongLogin = await api(base, 'POST', '/invites/accept', {
    body: { token: inv.json.token, login: 'л'.repeat(33), name: 'Л', password: 'пароль-длинного' },
  });
  assert.equal(tooLongLogin.status, 400);

  const ok = await api(base, 'POST', '/invites/accept', {
    body: { token: inv.json.token, login: 'нормальный', name: 'И'.repeat(120), password: 'пароль-длинного' },
  });
  assert.equal(ok.status, 200, 'граничные 120 символов допустимы');
});

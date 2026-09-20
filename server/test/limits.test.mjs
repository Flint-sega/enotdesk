import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, api, adminLogin, tmpDb, wsConnect } from './util.mjs';
import { RateLimiter } from '../app.mjs';

async function setup(t) {
  const dbPath = tmpDb(t);
  const { base, port } = await startServer(t, { dbPath });
  return { base, port };
}

test('rate limit: брутфорс одного логина останавливается, соседний логин не затронут', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, {
    dbPath,
    limits: { loginId: new RateLimiter(3, 60_000) }, // per-IP login оставляем дефолтный (10/мин)
  });
  const admin = await adminLogin(dbPath, base); // успешный вход лимит не тратит

  // 3 неудачных пароля исчерпывают per-login порог
  for (let i = 0; i < 3; i++) {
    const bad = await api(base, 'POST', '/auth/login', { body: { login: admin.user.login, password: `неверный-${i}` } });
    assert.equal(bad.status, 401);
  }
  // четвёртая — даже с ВЕРНЫМ паролем — отклонена, пока не истечёт окно
  const locked = await api(base, 'POST', '/auth/login', { body: { login: admin.user.login, password: 'Пароль-админа-123' } });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'rate_limited');

  // соседний логин не затронут
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'operator' } });
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login: 'сосед', name: 'С', password: 'пароль-соседа' } });
  const other = await api(base, 'POST', '/auth/login', { body: { login: 'сосед', password: 'пароль-соседа' } });
  assert.equal(other.status, 200);

  // неудачи видны в аудите
  const audit = await api(base, 'GET', '/audit?limit=100', { token: admin.token });
  const failures = audit.json.items.filter((a) => a.action === 'login.failure');
  assert.ok(failures.length >= 3, 'неудачные попытки входа записаны в аудит');
});

test('rate limit: POST /sessions ограничен по IP (429)', async (t) => {
  const { base } = await setup(t);
  let last;
  for (let i = 0; i < 12; i++) last = await api(base, 'POST', '/sessions');
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'rate_limited');
});

test('sessions: не более трёх висящих регистраций с одного IP; завершение освобождает слот', async (t) => {
  const { base } = await setup(t, { leaseMs: 60_000 });
  const regs = [];
  for (let i = 0; i < 3; i++) {
    const r = await api(base, 'POST', '/sessions');
    assert.equal(r.status, 201, `регистрация ${i + 1} должна пройти`);
    regs.push(r.json);
  }
  const fourth = await api(base, 'POST', '/sessions');
  assert.equal(fourth.status, 429, 'четвёртая висящая регистрация с того же IP отклонена');

  // хост завершает одну регистрацию — слот освобождается
  await api(base, 'POST', `/sessions/${regs[0].sessionId}/end`, { token: regs[0].hostToken, body: {} });
  const again = await api(base, 'POST', '/sessions');
  assert.equal(again.status, 201);
});

test('rate limit: login ограничен по IP (429)', async (t) => {
  const { base } = await setup(t);
  const body = { login: 'никто', password: 'несуществует-1' };
  let last;
  for (let i = 0; i < 12; i++) last = await api(base, 'POST', '/auth/login', { body });
  assert.equal(last.status, 429);
});

test('rate limit: claim ограничен по sessionId, соседние сеансы не затронуты', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, {
    dbPath,
    limits: {
      sessions: new RateLimiter(100, 60_000),
      login: new RateLimiter(100, 60_000),
      claim: new RateLimiter(100, 60_000),
      claimId: new RateLimiter(3, 60_000),
    },
  });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  let last;
  for (let i = 0; i < 5; i++) {
    last = await api(base, 'POST', `/sessions/${reg.json.sessionId}/claim`, { token: admin.token, body: { password: 'неверный' } });
  }
  assert.equal(last.status, 429);
  // per-ID лимит бьёт только по этому сеансу: другой sessionId отвечает обычным 400
  const reg2 = await api(base, 'POST', '/sessions');
  const other = await api(base, 'POST', `/sessions/${reg2.json.sessionId}/claim`, { token: admin.token, body: { password: 'неверный' } });
  assert.equal(other.status, 400);
});

test('body limit: слишком большой запрос — 413', async (t) => {
  const { base } = await setup(t);
  const huge = { name: 'x'.repeat(200 * 1024) };
  const res = await api(base, 'POST', '/sessions', { body: huge });
  assert.equal(res.status, 413);
});

test('rate limit: чужие IP не копятся в памяти вечно (eviction протухших окон)', () => {
  let now = 1_000_000;
  const rl = new RateLimiter(5, 60_000, { now: () => now, maxKeys: 10 });
  for (let i = 0; i < 10; i++) rl.take(`ip-${i}`); // 10 разных IP — Map полон
  now += 61_000; // все окна протухли
  assert.equal(rl.take('ip-new'), true, 'новый ключ допущен');
  // следующий take с полным Map снова выметает протухших — память не растёт безгранично
  for (let i = 0; i < 10; i++) rl.take(`fresh-${i}`);
  now += 61_000;
  for (let i = 0; i < 20; i++) rl.take(`wave-${i}`); // выметание должно происходить автоматически
  assert.equal(rl.take('после-выметания'), true);
});

test('WS frame limit: кадр больше 128KiB закрывает соединение (1009)', async (t) => {
  const { port, base } = await setup(t);
  const reg = await api(base, 'POST', '/sessions');
  const ws = wsConnect(port);
  await ws.opened;
  ws.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: reg.json.sessionId, token: reg.json.hostToken }));
  await ws.wait((m) => m.type === 'ready');
  ws.send('x'.repeat(129 * 1024));
  assert.equal(await ws.closeCode(), 1009);
});

test('origin check: чужой Origin — 403 в HTTP и 403 (не 101) на WS-апгрейд; без Origin WS работает', async (t) => {
  const { base, port } = await setup(t);
  const res = await fetch(base + '/api/v1/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);

  const { request } = await import('node:http');
  const outcome = await new Promise((resolve, reject) => {
    const r = request({
      host: '127.0.0.1',
      port,
      path: '/signal',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': 13,
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Origin: 'https://evil.example',
      },
    });
    r.on('upgrade', () => reject(new Error('чужой Origin получил WS-апгрейд')));
    r.on('response', (resp) => { resp.resume(); resolve(resp.statusCode); });
    r.on('error', reject);
    r.end();
  });
  assert.equal(outcome, 403);

  // контроль: легитимное подключение без Origin проходит — тест краснеет при сломанном шве
  const reg = await api(base, 'POST', '/sessions');
  const ok = wsConnect(port);
  await ok.opened;
  ok.send(JSON.stringify({ type: 'auth', role: 'host', sessionId: reg.json.sessionId, token: reg.json.hostToken }));
  await ok.wait((m) => m.type === 'ready');
});

test('rtc-config: без токена 401; с hostToken и TURN-конфигом отдаёт iceServers', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base } = await startServer(t, { dbPath, turnUrls: 'turn:turn.example:3478', turnUsername: 'enot', turnPassword: 'secret-кред' });
  assert.equal((await api(base, 'GET', '/rtc-config')).status, 401);
  const reg = await api(base, 'POST', '/sessions');
  const cfg = await api(base, 'GET', '/rtc-config', { token: reg.json.hostToken });
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.json.iceServers, [{ urls: ['turn:turn.example:3478'], username: 'enot', credential: 'secret-кред' }]);
  await inst.close();
});

// Изоляция реального dist/ проекта: собранный pack:mac артефакт не должен ни ломать
// тест (дистрибутив не пуст), ни удаляться тестом. Спрятать → прогнать → вернуть.
function isolateDist(t) {
  const distDir = path.join(process.cwd(), 'dist');
  const backup = distDir + '.test-backup';
  const had = fs.existsSync(distDir);
  if (had) fs.renameSync(distDir, backup);
  t.after(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
    if (had) fs.renameSync(backup, distDir);
  });
  return distDir;
}

test('downloads: страница и API честно пустые без dist', async (t) => {
  isolateDist(t);
  const { base } = await setup(t);
  const html = await fetch(base + '/downloads');
  assert.equal(html.status, 200);
  const text = await html.text();
  assert.match(text, /Сборка ещё не готова/);
  const apiRes = await api(base, 'GET', '/downloads');
  assert.equal(apiRes.status, 200);
  assert.deepEqual(apiRes.json.items, []);
});

test('downloads-files: отдаёт только allowlist-файлы из dist/, traversal отказан', async (t) => {
  const { base } = await setup(t);
  const distDir = isolateDist(t);
  fs.mkdirSync(distDir, { recursive: true });
  const fileName = 'EnotDesk-0.1.0.exe';
  fs.writeFileSync(path.join(distDir, fileName), 'PORTABLE-BYTES');

  const list = await api(base, 'GET', '/downloads');
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].name, fileName);
  assert.equal(list.json.items[0].platform, 'win32');
  assert.equal(list.json.items[0].size, 'PORTABLE-BYTES'.length);

  const file = await fetch(`${base}/api/v1/downloads-files/${encodeURIComponent(fileName)}`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'PORTABLE-BYTES');

  // вне allowlist / traversal / отсутствующий allowlist-файл
  assert.equal((await fetch(`${base}/api/v1/downloads-files/README.md`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/downloads-files/${encodeURIComponent('../package.json')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/downloads-files/EnotDesk-9.9.9.exe`)).status, 404);
});

test('XFF: без ENOT_TRUSTED_PROXY заголовок не доверяется (лимит по адресу сокета)', async (t) => {
  const { base } = await startServer(t, { limits: { sessions: new RateLimiter(2, 60_000) } });
  // оба запроса несут разные XFF, но адрес сокета один — лимит общий
  assert.equal((await api(base, 'POST', '/sessions', { headers: { 'x-forwarded-for': '9.9.9.9' } })).status, 201);
  assert.equal((await api(base, 'POST', '/sessions', { headers: { 'x-forwarded-for': '8.8.8.8' } })).status, 201);
  const third = await api(base, 'POST', '/sessions', { headers: { 'x-forwarded-for': '7.7.7.7' } });
  assert.equal(third.status, 429, 'XFF проигнорирован: третий запрос того же сокета отклонён');
});

test('XFF: с ENOT_TRUSTED_PROXY берётся последний недоверенный hop', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, {
    dbPath,
    trustedProxy: '127.0.0.1, ::1, 10.0.0.0/8',
    limits: { sessions: new RateLimiter(2, 60_000) },
  });
  const hdr = (ip) => ({ 'x-forwarded-for': ip });
  assert.equal((await api(base, 'POST', '/sessions', { headers: hdr('203.0.113.5') })).status, 201);
  assert.equal((await api(base, 'POST', '/sessions', { headers: hdr('203.0.113.5') })).status, 201);
  assert.equal((await api(base, 'POST', '/sessions', { headers: hdr('203.0.113.5') })).status, 429, 'лимит бьёт по клиенту из XFF');
  // цепочка из двух прокси: доверенный 10.9.9.9 пропускается, клиент 198.51.100.7 — отдельное ведро
  assert.equal((await api(base, 'POST', '/sessions', { headers: hdr('10.9.9.9, 198.51.100.7') })).status, 201);
  // запрос вообще без XFF — адрес сокета, тоже отдельное ведро
  assert.equal((await api(base, 'POST', '/sessions')).status, 201);
});

test('claim: анонимный флуд не выжигает лимит sessionId авторизованного', async (t) => {
  const dbPath = tmpDb(t);
  const { base } = await startServer(t, {
    dbPath,
    limits: {
      sessions: new RateLimiter(100, 60_000),
      login: new RateLimiter(100, 60_000),
      claim: new RateLimiter(100, 60_000),
      claimId: new RateLimiter(2, 60_000),
    },
  });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  // аноним бьёт в известный sessionId — каждый раз 401, лимиты не тратятся
  for (let i = 0; i < 6; i++) {
    const anon = await api(base, 'POST', `/sessions/${reg.json.sessionId}/claim`, { body: { password: 'угадал?' } });
    assert.equal(anon.status, 401);
  }
  // авторизованный с верным паролем проходит: порог не выжжен анонимом
  const real = await api(base, 'POST', `/sessions/${reg.json.sessionId}/claim`, { token: admin.token, body: { password: reg.json.password } });
  assert.equal(real.status, 201);
});

test('WS upgrade: лимит до аутентификации (429 на рукопожатие)', async (t) => {
  const { port } = await startServer(t, { limits: { wsUpgrade: new RateLimiter(2, 60_000) } });
  const { request } = await import('node:http');
  const upgradeOnce = () => new Promise((resolve, reject) => {
    const r = request({
      host: '127.0.0.1', port, path: '/signal',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13,
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      },
    });
    r.on('upgrade', () => { resolve(101); });
    r.on('response', (resp) => { resp.resume(); resolve(resp.statusCode); });
    r.on('error', reject);
    r.end();
  });
  assert.equal(await upgradeOnce(), 101);
  assert.equal(await upgradeOnce(), 101);
  assert.equal(await upgradeOnce(), 429, 'третье рукопожатие с того же IP отклонено');
});

test('rtc-config: с turnSecret отдаёт эфемерный кред (HMAC-SHA1, TTL ~1ч); auditor — 403', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base } = await startServer(t, {
    dbPath,
    turnUrls: 'turn:turn.example:3478',
    turnUsername: 'static',
    turnPassword: 'static-secret',
    turnSecret: 'turn-secret-369',
  });
  const admin = await adminLogin(dbPath, base);
  const cfgRes = await api(base, 'GET', '/rtc-config', { token: admin.token });
  assert.equal(cfgRes.status, 200);
  const [srv] = cfgRes.json.iceServers;
  const username = srv.username;
  // формула coturn REST API (use-auth-secret): credential = base64(HMAC-SHA1(secret, username))
  const expected = crypto.createHmac('sha1', 'turn-secret-369').update(username).digest('base64');
  assert.equal(srv.credential, expected, 'кредениал = HMAC-SHA1(секрет, username), как ждёт живой coturn');
  assert.notEqual(srv.credential, 'static-secret', 'статический пароль не раздаётся');
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Number(username) - nowSec;
  assert.ok(ttl > 3590 && ttl <= 3600, `TTL ~3600 (фактически ${ttl})`);

  // host-токенattended/attended-хоста получает тот же эфемерный формат
  const reg = await api(base, 'POST', '/sessions');
  const hostCfg = await api(base, 'GET', '/rtc-config', { token: reg.json.hostToken });
  assert.equal(hostCfg.status, 200);
  assert.equal(hostCfg.json.iceServers[0].credential,
    crypto.createHmac('sha1', 'turn-secret-369').update(hostCfg.json.iceServers[0].username).digest('base64'));

  // auditor — наблюдатель, в сеансах не участвует: конфиг не выдаётся
  const inv = await api(base, 'POST', '/invites', { token: admin.token, body: { role: 'auditor' } });
  await api(base, 'POST', '/invites/accept', { body: { token: inv.json.token, login: 'ауд2', name: 'А', password: 'пароль-аудитора' } });
  const aud = await api(base, 'POST', '/auth/login', { body: { login: 'ауд2', password: 'пароль-аудитора' } });
  assert.equal((await api(base, 'GET', '/rtc-config', { token: aud.json.token })).status, 403);
  await inst.close();
});

test('RateLimiter: карта не растёт без предела — вытесняется старейший по reset', () => {
  let now = 0;
  const rl = new RateLimiter(2, 60_000, { now: () => now, maxKeys: 3 });
  for (let i = 0; i < 2; i++) rl.take('a'); // 'a' исчерпан, минимальный reset
  now += 1000;
  rl.take('b');
  now += 1000;
  rl.take('c'); // карта полна живыми ключами, ничего не протухло
  now += 1000;
  assert.equal(rl.take('d'), true, 'место нашлось: старейший вытеснен');
  assert.equal(rl.exceeded('a'), false, "'a' вытеснен — порога больше нет");
  assert.equal(rl.take('a'), true, "'a' снова допущен: ключ пересоздан с нуля");
});

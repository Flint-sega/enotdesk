import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateSecret, verifyCode, matchCounter, backupCodes, normalizeBackupCode, secretKeyBytes, encryptSecret, decryptSecret } from '../totp.mjs';
import { sha256, verifyPassword } from '../crypto.mjs';
import { startServer, api, adminLogin, tmpDb, ADMIN } from './util.mjs';

// Независимая реализация (HMAC-SHA1 + динамическая обрезка, RFC 4227/6238) —
// только чтобы получить валидный код для заданного счётчика в тестах окна и
// полного пути. Известные ответы (правильность самих цифр) закрепляют
// RFC-векторы ниже, а не эта функция.
function refCode(base32Secret, timeSec) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const key = [];
  for (const ch of String(base32Secret).toUpperCase()) {
    const idx = alpha.indexOf(ch);
    if (idx === -1) continue; // паддинг/разделители
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeSec / 30)));
  const mac = crypto.createHmac('sha1', Buffer.from(key)).update(counter).digest();
  const off = mac[mac.length - 1] & 0xf;
  const num = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(num % 1_000_000).padStart(6, '0');
}

// Ожидаемые значения — RFC 6238, приложение B (SHA-1): секрет ASCII
// "12345678901234567890" → base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
// В RFC 8-значные коды; для стандартных 6 цифр берём последние 6 разрядов.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

test('RFC 6238 (SHA-1): известным секрет/время → известный код', () => {
  for (const [sec, code] of VECTORS) {
    assert.equal(verifyCode(RFC_SECRET, code, { now: sec * 1000 }), true, `T=${sec} → ${code}`);
  }
});

test('verifyCode: неверный код, лишние разряды и мусор — отказ', () => {
  assert.equal(verifyCode(RFC_SECRET, '287081', { now: 59_000 }), false, 'соседний код мимо');
  assert.equal(verifyCode(RFC_SECRET, '000000', { now: 59_000 }), false);
  assert.equal(verifyCode(RFC_SECRET, '0287082', { now: 59_000 }), false, '7 цифр не принимаются');
  assert.equal(verifyCode(RFC_SECRET, 'abc123', { now: 59_000 }), false);
  assert.equal(verifyCode(RFC_SECRET, '', { now: 59_000 }), false);
  assert.equal(verifyCode(RFC_SECRET, null, { now: 59_000 }), false);
  assert.equal(verifyCode('НЕ-BASE32!', '123456', { now: 59_000 }), false, 'недекодируемый секрет');
});

test('verifyCode: регистр и разделители не важны (ручной ввод)', () => {
  assert.equal(verifyCode(RFC_SECRET.toLowerCase(), '287082', { now: 59_000 }), true);
  assert.equal(verifyCode(RFC_SECRET, '287 082', { now: 59_000 }), true);
});

test('окно ±1: соседние 30-секундные шаги принимаются, дальние — нет', () => {
  // T=59 попадает в счётчик 1: коды счётчиков 0 и 2 принимаются, 3 — нет
  assert.equal(verifyCode(RFC_SECRET, refCode(RFC_SECRET, 29), { now: 59_000 }), true, 'шаг −1');
  assert.equal(verifyCode(RFC_SECRET, refCode(RFC_SECRET, 89), { now: 59_000 }), true, 'шаг +1');
  assert.equal(verifyCode(RFC_SECRET, refCode(RFC_SECRET, 119), { now: 59_000 }), false, 'шаг +2 отвергнут');
});

test('generateSecret: 32 символа base32, каждый секрет новый и рабочий', () => {
  const a = generateSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  const b = generateSecret();
  assert.notEqual(a, b);
  assert.equal(verifyCode(a, refCode(a, Date.now() / 1000), { now: Date.now() }), true);
});

test('backupCodes: 10 одноразовых кодов формата XXXX-XXXX, без повторов', () => {
  const codes = backupCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
});

// ---- AES-256-GCM: секреты в БД только шифротекстом; старый plaintext читается ----

test('secretKeyBytes: hex/base64/произвольная строка → 32 байта, пусто → null', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(secretKeyBytes(hex).length, 32);
  assert.equal(secretKeyBytes(hex).toString('hex'), hex);
  const raw = Buffer.alloc(32, 7);
  const b64 = raw.toString('base64');
  assert.equal(secretKeyBytes(b64).toString('hex'), raw.toString('hex'));
  assert.equal(secretKeyBytes('просто-строка').length, 32);
  assert.equal(secretKeyBytes(''), null);
  assert.equal(secretKeyBytes(null), null);
});

test('encryptSecret/decryptSecret: цикл туда-обратно, порча и чужой ключ не читаются', () => {
  const key = secretKeyBytes('k'.repeat(64));
  const enc = encryptSecret(key, 'секрет-оператора');
  assert.match(enc, /^v1:/, 'в БД лежит шифротекст');
  assert.ok(!enc.includes('секрет-оператора'));
  assert.equal(decryptSecret(key, enc), 'секрет-оператора');
  const other = secretKeyBytes('x'.repeat(64));
  assert.equal(decryptSecret(other, enc), null, 'чужой ключ не расшифровывает');
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal(decryptSecret(key, tampered), null, 'испорченный шифротекст не читается');
});

test('decryptSecret: старое plaintext-значение читается как есть (без першифровки)', () => {
  const key = secretKeyBytes('k'.repeat(64));
  assert.equal(decryptSecret(key, 'старое-открытое-значение'), 'старое-открытое-значение');
  assert.equal(decryptSecret(null, 'старое-открытое-значение'), 'старое-открытое-значение');
  assert.equal(decryptSecret(null, 'v1:AAAA'), null, 'шифротекст без ключа не читается');
});

// ---- HTTP: полный путь 2FA через createServer ----

async function setup(t, extra = {}) {
  const dbPath = tmpDb(t);
  const { base, inst } = await startServer(t, { dbPath, ...extra });
  const admin = await adminLogin(dbPath, base);
  return { base, admin, db: inst.db };
}

test('полный путь: включение → подтверждение кодом → логин с кодом → резервный код → отключение', async (t) => {
  const { base, admin, db } = await setup(t, { secretKey: 'a'.repeat(64) });
  const auth = { token: admin.token };

  // включение: сервер генерирует секрет, отдаёт otpauth + резервные коды один раз
  const en = await api(base, 'POST', '/auth/totp/enable', { ...auth, body: { password: admin.password } });
  assert.equal(en.status, 200);
  const { secret, otpauth, backupCodes: codes } = en.json;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(otpauth, /^otpauth:\/\/totp\/EnotDesk%3A/);
  assert.ok(otpauth.includes(`secret=${secret}`), 'otpauth несёт тот же секрет');
  assert.equal(codes.length, 10);

  // в БД секрет шифротекстом (AES-256-GCM), 2FA ещё не активна до первого кода
  const row = db.prepare('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = ?').get(admin.user.id);
  assert.match(row.totp_secret_enc, /^v1:/);
  assert.ok(!row.totp_secret_enc.includes(secret), 'открытого секрета в БД нет');
  assert.equal(row.totp_enabled, 0);

  // пока включение не подтверждено, вход без кода работает
  const pre = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } });
  assert.equal(pre.status, 200);

  // подтверждение неверным кодом — отказ, 2FA не включается
  const badConfirm = await api(base, 'POST', '/auth/totp/enable', { ...auth, body: { password: admin.password, code: 'abcdef' } });
  assert.equal(badConfirm.status, 400);
  assert.equal(badConfirm.json.error.code, 'bad_code');

  const code = refCode(secret, Date.now() / 1000);
  const confirm = await api(base, 'POST', '/auth/totp/enable', { ...auth, body: { password: admin.password, code } });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.enabled, true);

  const me = await api(base, 'GET', '/auth/me', auth);
  assert.equal(me.json.user.totpEnabled, true);

  // повторное включение без отключения — отказ
  const again = await api(base, 'POST', '/auth/totp/enable', { ...auth, body: { password: admin.password } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'totp_already');

  // логин без кода → totp_required (только после ВЕРНОГО пароля);
  // неверный пароль без кода — generic invalid_credentials: аноним не узнаёт,
  // что у аккаунта 2FA, пока не знает пароль
  const noCode = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.json.error.code, 'totp_required');
  const wrongPw = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: 'точно-не-пароль' } });
  assert.equal(wrongPw.status, 401);
  assert.equal(wrongPw.json.error.code, 'invalid_credentials', 'неверный пароль — generic отказ, не totp_required');

  // верный пароль + неверный код → тот же invalid_credentials, что и при неверном пароле (нет оракула)
  const stale = refCode(RFC_SECRET, 60); // давний код (счётчик 2) точно мимо нынешнего окна
  const wrongCode = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password, totp: stale } });
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.json.error.code, 'invalid_credentials');
  const wrongPwCode = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: 'точно-не-пароль', totp: stale } });
  assert.deepEqual(wrongPwCode.json.error, wrongCode.json.error);

  // верный пароль + верный код → 200
  const good = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: refCode(secret, Date.now() / 1000) },
  });
  assert.equal(good.status, 200);
  assert.ok(good.json.token);

  // резервный код одноразовый: сработал один раз, повтор — отказ
  const withBk = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: codes[0] },
  });
  assert.equal(withBk.status, 200);
  const bkAgain = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: codes[0] },
  });
  assert.equal(bkAgain.status, 401);

  // в БД только scrypt-хеши (P2-6), использованный удалён
  const hashes = db.prepare('SELECT code_hash FROM totp_backup_codes WHERE user_id = ?').all(admin.user.id);
  assert.equal(hashes.length, 9);
  assert.ok(hashes.every((h) => h.code_hash.startsWith('s1$')), 'хранятся scrypt-хеши, не sha256');
  assert.ok(
    hashes.some((h) => verifyPassword(normalizeBackupCode(codes[1]), h.code_hash)),
    'хранится scrypt-хеш нормализованного кода',
  );
  assert.ok(!hashes.some((h) => h.code_hash === codes[1]), 'открытых кодов в БД нет');

  // отключение: неверный пароль → 403, верный → 200, вход снова без кода
  const badDis = await api(base, 'POST', '/auth/totp/disable', { ...auth, body: { password: 'точно-не-пароль' } });
  assert.equal(badDis.status, 403);
  assert.equal(badDis.json.error.code, 'wrong_password');
  const dis = await api(base, 'POST', '/auth/totp/disable', { ...auth, body: { password: admin.password } });
  assert.equal(dis.status, 200);
  const after = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } });
  assert.equal(after.status, 200);
  const cleared = db.prepare('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = ?').get(admin.user.id);
  assert.equal(cleared.totp_enabled, 0);
  assert.equal(cleared.totp_secret_enc, null);
  assert.equal(db.prepare('SELECT count(*) c FROM totp_backup_codes WHERE user_id = ?').get(admin.user.id).c, 0);

  // журнал: включение и отключение записаны
  const audit = await api(base, 'GET', '/audit', auth);
  const actions = audit.json.items.map((a) => a.action);
  assert.ok(actions.includes('totp.enable'));
  assert.ok(actions.includes('totp.disable'));
});

test('без ENOT_SECRET_KEY включение честно отказывает с подсказкой', async (t) => {
  const { base, admin, db } = await setup(t, { secretKey: '' });
  const en = await api(base, 'POST', '/auth/totp/enable', { token: admin.token, body: { password: admin.password } });
  assert.equal(en.status, 400);
  assert.equal(en.json.error.code, 'secret_key_missing');
  assert.match(en.json.error.message, /ENOT_SECRET_KEY/, 'подсказка называет переменную');
  const row = db.prepare('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = ?').get(admin.user.id);
  assert.equal(row.totp_secret_enc, null);
  assert.equal(row.totp_enabled, 0);
  // вход остаётся рабочим
  const lg = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } });
  assert.equal(lg.status, 200);
});

test('включение требует авторизацию и текущий пароль; отключение невыключенной 2FA — отказ', async (t) => {
  const { base, admin } = await setup(t, { secretKey: 'a'.repeat(64) });
  const noAuth = await api(base, 'POST', '/auth/totp/enable', { body: { password: admin.password } });
  assert.equal(noAuth.status, 401);
  const badPw = await api(base, 'POST', '/auth/totp/enable', { token: admin.token, body: { password: 'точно-не-пароль' } });
  assert.equal(badPw.status, 403);
  assert.equal(badPw.json.error.code, 'wrong_password');
  const dis = await api(base, 'POST', '/auth/totp/disable', { token: admin.token, body: { password: admin.password } });
  assert.equal(dis.status, 409);
  assert.equal(dis.json.error.code, 'totp_not_enabled');
});

test('matchCounter: знает, какой шаг совпал (для replay-защиты)', () => {
  assert.equal(matchCounter(RFC_SECRET, '287082', { now: 59_000 }), 1, 'T=59 → счётчик 1');
  assert.equal(matchCounter(RFC_SECRET, refCode(RFC_SECRET, 29), { now: 59_000 }), 0, 'шаг −1');
  assert.equal(matchCounter(RFC_SECRET, '287081', { now: 59_000 }), null, 'мимо окна');
  assert.equal(matchCounter(RFC_SECRET, 'мусор', { now: 59_000 }), null);
});

test('replay: тот же TOTP-код второй раз — отказ, соседний свежий код работает', async (t) => {
  const { base, admin, db } = await setup(t, { secretKey: 'a'.repeat(64) });
  const en = await api(base, 'POST', '/auth/totp/enable', { token: admin.token, body: { password: admin.password } });
  const secret = en.json.secret;
  await api(base, 'POST', '/auth/totp/enable', { token: admin.token, body: { password: admin.password, code: refCode(secret, Date.now() / 1000) } });

  const first = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: refCode(secret, Date.now() / 1000) },
  });
  assert.equal(first.status, 200);
  // повтор того же кода (тот же 30-с шаг) — отказ
  const replay = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: refCode(secret, Date.now() / 1000) },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.json.error.code, 'invalid_credentials', 'повтор кода — generic отказ');
  // код следующего шага (в окне ±1) принят и счётчик сдвинут
  const next = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: refCode(secret, Date.now() / 1000 + 30) },
  });
  assert.equal(next.status, 200);
  const row = db.prepare('SELECT totp_last_counter FROM users WHERE id = ?').get(admin.user.id);
  const expected = Math.floor(Date.now() / 1000 / 30) + 1;
  assert.ok(Math.abs(row.totp_last_counter - expected) <= 1, 'счётчик последнего шага записан');
});

test('резервные коды старого sha256-формата — честный отказ backup_codes_legacy_reset', async (t) => {
  const { base, admin, db } = await setup(t, { secretKey: 'a'.repeat(64) });
  const en = await api(base, 'POST', '/auth/totp/enable', { token: admin.token, body: { password: admin.password } });
  const secret = en.json.secret;
  await api(base, 'POST', '/auth/totp/enable', { token: admin.token, body: { password: admin.password, code: refCode(secret, Date.now() / 1000) } });

  // подменяем коды на хеши старого формата (несолёный sha256, как до P2-6)
  const legacyCode = 'TEST-CODE-42';
  db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(admin.user.id);
  db.prepare('INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?,?,?)')
    .run(admin.user.id, sha256(normalizeBackupCode(legacyCode)), new Date().toISOString());

  // вход резервным кодом старого формата — отказ с честным кодом ошибки
  const legacy = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: legacyCode },
  });
  assert.equal(legacy.status, 401);
  assert.equal(legacy.json.error.code, 'backup_codes_legacy_reset');

  // случайный неверный код — обычный invalid_credentials, а не legacy_reset
  const wrong = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: 'ZZZZ-ZZZZ' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'invalid_credentials');

  // аккаунт не заблокирован: TOTP-код работает; перевыпуск (disable → enable) возвращает scrypt-коды
  const viaTotp = await api(base, 'POST', '/auth/login', {
    body: { login: ADMIN.login, password: ADMIN.password, totp: refCode(secret, Date.now() / 1000 + 30) },
  });
  assert.equal(viaTotp.status, 200);
  await api(base, 'POST', '/auth/totp/disable', { token: viaTotp.json.token, body: { password: admin.password } });
  const re = await api(base, 'POST', '/auth/totp/enable', { token: viaTotp.json.token, body: { password: admin.password } });
  assert.equal(re.status, 200);
  const hashes = db.prepare('SELECT code_hash FROM totp_backup_codes WHERE user_id = ?').all(admin.user.id);
  assert.equal(hashes.length, 10);
  assert.ok(hashes.every((h) => h.code_hash.startsWith('s1$')), 'перевыпущенные коды — scrypt');
});

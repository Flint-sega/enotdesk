import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpCredentialsStore } from '../lib/op-credentials.mjs';

// Шов — fs-подобные операции в памяти + safeStorage-подобный шифратор.
// Контракт: пароль на диск только шифротекстом; недоступное шифрование —
// честный отказ; битый/чужой шифротекст — файл стирается, load отдаёт null;
// save/load никогда не бросают.

function memoryFs() {
  const files = new Map();
  return {
    files,
    readText: async (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeText: async (p, data) => { files.set(p, data); },
    unlink: async (p) => {
      if (!files.delete(p)) throw new Error('ENOENT');
    },
    exists: (p) => files.has(p),
  };
}

function fakeSafeStorage({ available = true, wrongKey = false, backend } = {}) {
  return {
    isEncryptionAvailable: () => available,
    ...(backend !== undefined ? { getSelectedStorageBackend: () => backend } : {}),
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (buf) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad payload');
      if (wrongKey) throw new Error('decrypt failed');
      return s.slice(4);
    },
  };
}

const FILE = '/profile/op-credentials.json';

test('op-credentials: save/load — пароль на диске только шифротекстом', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage(), file: FILE });
  assert.equal(await store.available(), true);
  const res = await store.save({ login: 'op', password: 'пароль-123' });
  assert.deepEqual(res, { ok: true });
  const raw = fsx.files.get(FILE);
  assert.ok(!raw.includes('пароль-123'), 'открытого пароля на диске нет');
  assert.match(raw, /"passwordEnc"/);
  assert.deepEqual(await store.load(), { login: 'op', password: 'пароль-123' });
});

test('op-credentials: без шифрования ОС — честный отказ, файл не пишется', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage({ available: false }), file: FILE });
  assert.equal(await store.available(), false);
  const res = await store.save({ login: 'op', password: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'encryption-unavailable');
  assert.equal(fsx.files.size, 0, 'ничего не записано');
  assert.equal(await store.load(), null);
});

test('op-credentials: мусор в полях отклонён (allowlist/лимиты)', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage(), file: FILE });
  assert.equal((await store.save({ login: '  ', password: 'x' })).reason, 'bad_login');
  assert.equal((await store.save({ login: 'x'.repeat(121), password: 'x' })).reason, 'bad_login');
  assert.equal((await store.save({ login: 'op', password: '' })).reason, 'bad_password');
  assert.equal((await store.save({ login: 'op', password: 'y'.repeat(257) })).reason, 'bad_password');
  assert.equal((await store.save({ login: ' op ', password: 'x' })).ok, true, 'пробелы по краям логина обрезаются');
  assert.equal((await store.load()).login, 'op');
});

test('op-credentials: битый файл и чужой ключ — файл стирается, load null', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage(), file: FILE });
  fsx.files.set(FILE, '{не-json');
  assert.equal(await store.load(), null);
  assert.equal(fsx.files.has(FILE), false, 'битый файл удалён');

  fsx.files.set(FILE, JSON.stringify({ v: 1, login: 'op', passwordEnc: 'A'.repeat(32) }));
  const wrong = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage({ wrongKey: true }), file: FILE });
  assert.equal(await wrong.load(), null, 'чужой шифротекст не расшифровывается — null');
  assert.equal(fsx.files.has(FILE), false, 'и этот файл удалён');

  fsx.files.set(FILE, JSON.stringify({ v: 2, login: 'op', passwordEnc: 'A'.repeat(32) }));
  assert.equal(await store.load(), null, 'неизвестная версия — null');
});

test('op-credentials: clear стирает файл и безопасен при его отсутствии', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage(), file: FILE });
  await store.save({ login: 'op', password: 'x' });
  assert.deepEqual(await store.clear(), { ok: true });
  assert.equal(fsx.files.has(FILE), false);
  assert.deepEqual(await store.clear(), { ok: true }, 'повторный clear не бросает');
});

test('op-credentials: Linux basic_text = шифрования нет (ревью 10.10 P1-1)', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage({ backend: 'basic_text' }), file: FILE });
  assert.equal(await store.available(), false, 'статический ключ Chromium — не «шифрование»');
  const res = await store.save({ login: 'op', password: 'x' });
  assert.equal(res.reason, 'encryption-unavailable', 'чекбокс скрыт, файл не пишется');
  assert.equal(fsx.files.size, 0);
  // нормальный бэкенд проходит
  const ok = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage({ backend: 'gnome_keyring' }), file: FILE });
  assert.equal(await ok.available(), true);
});

test('op-credentials: гигантский login из подменённого файла — null (ревью 10.10 P2-1)', async () => {
  const fsx = memoryFs();
  const store = createOpCredentialsStore({ ...fsx, safeStorage: fakeSafeStorage(), file: FILE });
  await store.save({ login: 'op', password: 'x' });
  const good = JSON.parse(fsx.files.get(FILE));
  fsx.files.set(FILE, JSON.stringify({ ...good, login: 'x'.repeat(5000) }));
  assert.equal(await store.load(), null, 'login длиннее лимита — файл стирается');
  assert.equal(fsx.files.has(FILE), false);
});

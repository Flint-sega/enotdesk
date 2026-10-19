// Запомненные креды оператора: «Запомнить меня» на входе оператора.
// Пароль никогда не лежит на диске открытым текстом — только шифротекст
// Electron safeStorage (Windows DPAPI / macOS Keychain / Linux keyring).
// Всё входящее — allowlist и лимиты; недоступное шифрование — честный отказ,
// битый/чужой шифротекст — файл стирается и хранилище отдаёт null (никогда
// не бросает исключений наверх: форма входа не должна падать из-за хранилища).
const LOGIN_MAX = 120;
const PASSWORD_MAX = 256;
const ORIGIN_MAX = 200;
// Окно оператора (ADR 0033, этап 2) грузит страницу С СЕРВЕРА: креды
// привязываются к origin сервера и отдаются только странице того же origin —
// смена адреса сервера не уносит пароль на чужой сервер. Запись без origin
// (старый встроенный оператор) такой странице не отдаётся.
const validOrigin = (o) => typeof o === 'string' && o.length > 0 && o.length <= ORIGIN_MAX;

export function createOpCredentialsStore({
  readText, writeText, unlink, exists, safeStorage, file,
}) {
  const toB64 = (buf) => Buffer.from(buf).toString('base64');
  const fromB64 = (s) => Buffer.from(String(s), 'base64');

  async function available() {
    try {
      if (safeStorage.isEncryptionAvailable() !== true) return false;
      // Linux: фолбэк basic_text — «шифрование» известным статическим ключом
      // Chromium, расшифровывается офлайн. Приравниваем к отсутствию шифрования.
      if (typeof safeStorage.getSelectedStorageBackend === 'function'
        && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }

  async function save({ login, password, origin } = {}) {
    if (typeof login !== 'string' || !login.trim() || login.length > LOGIN_MAX) return { ok: false, reason: 'bad_login' };
    if (origin !== undefined && !validOrigin(origin)) return { ok: false, reason: 'bad_origin' };
    if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX) return { ok: false, reason: 'bad_password' };
    if (!(await available())) return { ok: false, reason: 'encryption-unavailable' };
    let enc;
    try { enc = safeStorage.encryptString(password); } catch { return { ok: false, reason: 'encryption-unavailable' }; }
    const payload = JSON.stringify({ v: 1, login: login.trim(), passwordEnc: toB64(enc), ...(origin ? { origin } : {}) });
    try {
      await writeText(file, payload);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'write-failed' };
    }
  }

  // origin задан — отдаём только запись, сохранённую для этого же origin
  // (чужая или старая запись без origin — null, файл не трогаем).
  async function load({ origin } = {}) {
    try {
      if (!exists(file)) return null;
      const raw = JSON.parse(await readText(file));
      if (raw?.v !== 1 || typeof raw.login !== 'string' || typeof raw.passwordEnc !== 'string') throw new Error('shape');
      if (!raw.login || raw.login.length > LOGIN_MAX) throw new Error('shape');
      if (raw.origin !== undefined && !validOrigin(raw.origin)) throw new Error('shape');
      if (origin !== undefined && raw.origin !== origin) return null;
      const password = safeStorage.decryptString(fromB64(raw.passwordEnc));
      if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX) throw new Error('decrypt');
      return { login: raw.login, password };
    } catch {
      // битый файл или шифротекст с чужого ключа/машины — не хранить мусор
      try { await unlink(file); } catch { /* уже нет */ }
      return null;
    }
  }

  async function clear() {
    try { await unlink(file); } catch { /* уже нет */ }
    return { ok: true };
  }

  return { available, save, load, clear };
}

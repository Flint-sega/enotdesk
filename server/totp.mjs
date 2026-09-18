import crypto from 'node:crypto';

// TOTP-2FA (D2, R11): RFC 6238 поверх base32-секрета, окно ±1 шаг (30 с),
// константное сравнение. Резервные коды — одноразовые, в БД только их sha256.
// Секрет пользователя хранится шифротекстом AES-256-GCM от ключа ENOT_SECRET_KEY
// (тот же механизм пригоден и для прочих секретов, например webhook'ов):
// шифрование/расшифровка здесь, детали формата наружу не выходят.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SEC = 30;
const WINDOW = 1;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Валидатор не прощает чужой алфавит; разделители и паддинг игнорируются.
export function base32Decode(str) {
  const clean = String(str ?? '').toUpperCase().replace(/[\s\-=]/g, '');
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160-битный секрет → 32 символа base32 (без паддинга), как в otpauth://.
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(keyBytes, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', keyBytes).update(msg).digest();
  const off = mac[mac.length - 1] & 0xf;
  const num = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(num % 1_000_000).padStart(6, '0');
}

function sameCode(expected, given) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// verifyCode(secret, code, {now}) — код текущего шага или соседних ±1.
export function verifyCode(secret, code, { now = Date.now() } = {}) {
  const keyBytes = base32Decode(secret);
  if (!keyBytes) return false;
  const given = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(now / 1000 / STEP_SEC);
  for (let shift = -WINDOW; shift <= WINDOW; shift++) {
    if (sameCode(hotp(keyBytes, counter + shift), given)) return true;
  }
  return false;
}

// 10 резервных кодов, формат XXXX-XXXX (40 бит случайности на код).
export function backupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = base32Encode(crypto.randomBytes(5));
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

// Нормализация резервного кода перед хешированием: разделители и регистр не важны.
export function normalizeBackupCode(code) {
  const clean = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean || null;
}

// ---- AES-256-GCM: общий механизм шифрования секретов от ENOT_SECRET_KEY ----

// Ключ из конфигурации: 64 hex-символа или base64 из 32 байт берутся как есть,
// любая другая строка приводится к 32 байтам через sha256. Пусто — ключа нет.
export function secretKeyBytes(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  const b64 = Buffer.from(v, 'base64');
  if (b64.length === 32 && b64.toString('base64') === v.trim()) return b64;
  return crypto.createHash('sha256').update(v, 'utf8').digest();
}

// Формат 'v1:' + base64(iv[12] | tag[16] | ciphertext); iv свежий на каждое значение.
export function encryptSecret(keyBytes, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

// Значение без префикса 'v1:' — старое plaintext (пишется до введения шифрования):
// читается как есть, чтобы ничего не ломать; першифровка не требуется.
// Шифротекст с чужим/отсутствующим ключом или с порчей → null.
export function decryptSecret(keyBytes, stored) {
  const s = String(stored ?? '');
  if (!s.startsWith('v1:')) return s || null;
  if (!keyBytes) return null;
  try {
    const raw = Buffer.from(s.slice(3), 'base64');
    if (raw.length <= 28) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

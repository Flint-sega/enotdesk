import crypto from 'node:crypto';
import { promisify } from 'node:util';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [tag, saltHex, hashHex] = String(stored).split('$');
  if (tag !== 's1' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// Асинхронный scrypt для путьей запросов (логин, claim, смена пароля): не
// блокирует event loop на ~50 мс на каждый вызов, поведение идентично sync-версии.
// hashPassword остаётся синхронным — он нужен на не-запросных путях (bootstrap).
const scryptAsync = promisify(crypto.scrypt);

export async function verifyPasswordAsync(password, stored) {
  const [tag, saltHex, hashHex] = String(stored).split('$');
  if (tag !== 's1' || !saltHex || !hashHex) return false;
  try {
    const hash = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Алфавит без визуально двусмысленных символов (0O1lI и строчная o).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function sessionPassword(length = 8) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)]; // без modulo bias
  return out;
}

export function newSessionId(db) {
  // 9-digit numeric id with collision check
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = String(100000000 + crypto.randomInt(900000000));
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) return id;
  }
  throw new Error('Не удалось сгенерировать идентификатор сеанса');
}

export function newClaimId() {
  return crypto.randomUUID();
}

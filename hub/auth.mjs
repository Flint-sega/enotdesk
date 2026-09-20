import crypto from 'node:crypto';
import { sha256 } from '../server/crypto.mjs';
import { secretKeyBytes, encryptSecret, decryptSecret } from '../server/totp.mjs';

// SSO-прокси хаба (ADR 0023): логин уходит в EnotDesk /api/v1/auth/login, bearer
// остаётся в записи hub-сессии (НИКОГДА не в cookie — cookie несёт только sid),
// каждый запрос ревалидируется через /api/v1/auth/me (кэш 60 с). Bearer умер
// (ротация/логаут на стороне EnotDesk) → hub-сессия удаляется, 401 честный.

const DEFAULT_SESSION_TTL_MS = 12 * 3600 * 1000; // 12 ч
const DEFAULT_REVALIDATE_MS = 60 * 1000; // кэш ревалидации /auth/me
const UPSTREAM_TIMEOUT_MS = 5000; // реальные вызовы fetch — с таймаутом 5 с

export function createAuth({
  db,
  enotdeskUrl = 'http://127.0.0.1:8080',
  secretKey = '',
  enotFetch,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  revalidateMs = DEFAULT_REVALIDATE_MS,
  now = Date.now,
}) {
  const base = String(enotdeskUrl).replace(/\/+$/, '');
  const doFetch = enotFetch ?? ((url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }));
  const keyBytes = secretKey ? secretKeyBytes(secretKey) : null;
  const cache = new Map(); // sid_hash -> { user, at }

  // Восстановимо нужен только bearer (им ходят в EnotDesk); есть ключ —
  // шифруем AES-256-GCM, нет — храним как есть, но наружу не отдаём никогда.
  const storeBearer = (bearer) => (keyBytes ? encryptSecret(keyBytes, bearer) : bearer);
  const loadBearer = (stored) => {
    if (!keyBytes) return stored;
    try { return decryptSecret(keyBytes, stored); } catch { return null; }
  };

  function session(sid) {
    if (typeof sid !== 'string' || sid.length < 16 || sid.length > 256) return null;
    const h = sha256(sid);
    const row = db.prepare('SELECT * FROM hub_sessions WHERE sid_hash = ?').get(h);
    if (!row) return null;
    if (row.expires_at <= new Date(now()).toISOString()) {
      db.prepare('DELETE FROM hub_sessions WHERE sid_hash = ?').run(h);
      cache.delete(h);
      return null;
    }
    return row;
  }

  function dropSession(sidHash) {
    db.prepare('DELETE FROM hub_sessions WHERE sid_hash = ?').run(sidHash);
    cache.delete(sidHash);
  }

  // login(login, password, totp?) -> { ok, sid?, user?, expiresAt? }
  //   | { ok:false, status, code, message }
  // 4xx апстрима (invalid_credentials, totp_required, rate_limited) проходят
  // насквозь; сеть/таймаут/5xx — честный 502 enotdesk_unavailable.
  async function login(loginName, password, totp) {
    let res;
    try {
      res = await doFetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: loginName, password, ...(totp ? { totp } : {}) }),
      });
    } catch {
      return { ok: false, status: 502, code: 'enotdesk_unavailable', message: 'EnotDesk недоступен' };
    }
    let body = null;
    try { body = await res.json(); } catch { /* не-JSON апстрима */ }
    if (res.status !== 200 || typeof body?.token !== 'string' || !body?.user) {
      const code = body?.error?.code ?? 'enotdesk_error';
      const status = res.status >= 400 && res.status < 500 ? res.status : 502;
      return { ok: false, status, code, message: String(body?.error?.message ?? '') };
    }
    const user = body.user;
    const sid = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now() + sessionTtlMs).toISOString();
    db.prepare(
      'INSERT INTO hub_sessions (sid_hash, bearer, user_json, expires_at, created_at) VALUES (?,?,?,?,?)'
    ).run(sha256(sid), storeBearer(body.token), JSON.stringify(user), expiresAt, new Date(now()).toISOString());
    cache.set(sha256(sid), { user, at: now() });
    return { ok: true, sid, user, expiresAt };
  }

  // authUser(sid) -> { ok:true, user } | { ok:false, status, code }
  async function authUser(sid) {
    const row = session(sid);
    if (!row) return { ok: false, status: 401, code: 'unauthorized' };
    const h = sha256(sid);
    const hit = cache.get(h);
    if (hit && now() - hit.at < revalidateMs) return { ok: true, user: hit.user };
    const bearer = loadBearer(row.bearer);
    if (!bearer) { dropSession(h); return { ok: false, status: 401, code: 'unauthorized' }; }
    let res;
    try {
      res = await doFetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${bearer}` } });
    } catch {
      // апстрим мигнул — сессию не рвём (кэш ещё жив 60 с, дальше 502 честный)
      return { ok: false, status: 502, code: 'enotdesk_unavailable' };
    }
    if (res.status !== 200) {
      dropSession(h); // bearer умер — hub-сессия недействительна
      return { ok: false, status: 401, code: 'unauthorized' };
    }
    let body = null;
    try { body = await res.json(); } catch { /* не-JSON апстрима */ }
    const user = body?.user ?? JSON.parse(row.user_json);
    db.prepare('UPDATE hub_sessions SET user_json = ? WHERE sid_hash = ?').run(JSON.stringify(user), h);
    cache.set(h, { user, at: now() });
    return { ok: true, user };
  }

  // logout(sid): hub-сессия удаляется всегда, логаут в EnotDesk — best-effort.
  async function logout(sid) {
    const row = session(sid);
    if (!row) return { ok: false, status: 401, code: 'unauthorized' };
    dropSession(sha256(sid));
    const bearer = loadBearer(row.bearer);
    if (bearer) {
      try {
        await doFetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } });
      } catch { /* best-effort: hub-сессия уже удалена */ }
    }
    return { ok: true };
  }

  return { login, authUser, logout, session };
}

import crypto from 'node:crypto';
import { sha256 } from '../server/crypto.mjs';
import { t } from '../client/lib/i18n.mjs';

// One-click «Подключиться» (T05, spec §One-click, ADR 0024): одноразовые
// join-токены, привязанные к треду; репорт клиента {sessionId,password};
// авто-claim в EnotDesk с bearer'ом агента, создавшего токен; system-сообщения
// в тред. Сырые токены не хранятся (только sha256); consumе одноразовый —
// повторный репорт честно 410 до ленивой чистки. Bearer добывается колбэком
// (bearer-хранение спрятано в hub/auth.mjs), сам claim-фетч инъекцией.

export const JOIN_TTL_MS = 10 * 60 * 1000; // TTL токена — 10 минут
// Язык system-сообщений треда: они — общее содержимое треда (видят консоль и
// гость), локаль получателя в схеме не хранится, поэтому детерминированный
// язык продукта для всех путей (репорт, webhooks) — без смешения языков.
export const SYSTEM_LOCALE = 'ru';
// формат тела репорта: sessionId — 9 цифр (как генерирует server/app.mjs), пароль ≤64
export const SESSION_ID_RE = /^\d{9}$/;
export const PASSWORD_MAX = 64;
const TOKEN_BYTES = 24; // randomBytes(24) → base64url 32 симв — в диапазоне клиента [A-Za-z0-9_-]{16,128}
const PURGE_AFTER_MS = 24 * 3600 * 1000; // consumed/истёкшие живут сутки (честный 410), потом чистка

export function createJoinStore(db, { nowMs = Date.now } = {}) {
  const nowIso = () => new Date(nowMs()).toISOString();

  // Одноразовый consume: атомарный UPDATE по used_at IS NULL + живому TTL.
  // → {threadId, agentId, tokenHash} | 'gone' (consumed/истёкший) | null (неизвестный)
  function consume(token) {
    if (typeof token !== 'string' || !token || token.length > 128) return null;
    const hash = sha256(token);
    const r = db.prepare(
      'UPDATE hub_join_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
    ).run(nowIso(), hash, nowIso());
    if (r.changes === 1) {
      const row = db.prepare('SELECT * FROM hub_join_tokens WHERE token_hash = ?').get(hash);
      return { threadId: row.thread_id, agentId: row.agent_id, tokenHash: hash };
    }
    const row = db.prepare('SELECT token_hash FROM hub_join_tokens WHERE token_hash = ?').get(hash);
    return row ? 'gone' : null;
  }

  // peek — для /join-страницы: показать кнопку можно, токен не сжигаем.
  function peek(token) {
    if (typeof token !== 'string' || !token || token.length > 128) return null;
    const row = db.prepare(
      'SELECT thread_id FROM hub_join_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?'
    ).get(sha256(token), nowIso());
    return row ? { threadId: row.thread_id } : null;
  }

  // Связь тред↔сеанс (для webhooks). null — треда нет или агент пустой.
  function create({ threadId, agentId, ttlMs = JOIN_TTL_MS } = {}) {
    if (typeof threadId !== 'string' || !threadId) return null;
    if (typeof agentId !== 'string' || !agentId || agentId.length > 120) return null;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 3600 * 1000) return null;
    if (!db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)) return null;
    // ленивая чистка: consumed/истёкшие старше суток — мусор, 410 им уже не нужен
    db.prepare('DELETE FROM hub_join_tokens WHERE expires_at < ?')
      .run(new Date(nowMs() - PURGE_AFTER_MS).toISOString());
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const at = nowIso();
    const expiresAt = new Date(nowMs() + ttlMs).toISOString();
    db.prepare(`INSERT INTO hub_join_tokens (token_hash, thread_id, agent_id, session_id, created_at, expires_at, used_at)
                VALUES (?,?,?,NULL,?,?,NULL)`)
      .run(sha256(token), threadId, agentId, at, expiresAt);
    return { token, expiresAt };
  }

  function linkSession(tokenHash, sessionId) {
    if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return false;
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
    return db.prepare('UPDATE hub_join_tokens SET session_id = ? WHERE token_hash = ?')
      .run(sessionId, tokenHash).changes === 1;
  }

  // Последний тред, чей токен репортил этот сеанс (webhooks session.*).
  function threadIdForSession(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
    const row = db.prepare(
      'SELECT thread_id FROM hub_join_tokens WHERE session_id = ? ORDER BY created_at DESC, token_hash DESC LIMIT 1'
    ).get(sessionId);
    return row ? row.thread_id : null;
  }

  return { create, consume, peek, linkSession, threadIdForSession };
}

// Причина отказа авто-claim — человекочитаемая строка для system-сообщения.
// Коды ошибок EnotDesk проходят насквозь как есть (error.code не локализуется —
// правило i18n), известные — словарём.
function claimFailureReason(code) {
  const keys = {
    bad_request: 'hub.join.reason.bad_request',
    not_found: 'hub.join.reason.bad_request',
    forbidden: 'hub.join.reason.forbidden',
    unauthorized: 'hub.join.reason.forbidden',
    rate_limited: 'hub.join.reason.rate_limited',
    enotdesk_unavailable: 'hub.join.reason.enotdesk_unavailable',
  };
  return t(keys[code] ?? 'hub.join.reason.other', {}, SYSTEM_LOCALE);
}

// Репорт join-токена: валидация тела → consume → авто-claim с bearer'ом агента
// → system-сообщение в тред + связь sessionId. Bearer и broadcast приходят
// колбэками из app.mjs (auth прячет bearer-хранение).
// → { status: 200, ok:true, claimed:true, sessionId }
//   | { status: 200, ok:true, claimed:false, reason }
//   | { status: 400|404|410, ok:false, code }
export function createJoinReporter({
  join,
  threads,
  bearerForAgent,
  enotdeskUrl,
  doFetch = (...a) => globalThis.fetch(...a),
  claimTimeoutMs = 5000,
  onSystem = () => {},
}) {
  const base = String(enotdeskUrl).replace(/\/+$/, '');

  function systemMessage(threadId, key, vars) {
    const message = threads.appendMessage(threadId, { author: 'system', body: t(key, vars, SYSTEM_LOCALE) });
    if (message) onSystem(threadId, message);
    return message;
  }

  return async function report(token, { sessionId, password } = {}) {
    // валидация ДО consume: мусорное тело не сжигает одноразовый токен
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return { status: 400, ok: false, code: 'bad_request' };
    if (typeof password !== 'string' || !password || password.length > PASSWORD_MAX) return { status: 400, ok: false, code: 'bad_request' };
    const used = join.consume(token);
    if (used === null) return { status: 404, ok: false, code: 'not_found' };
    if (used === 'gone') return { status: 410, ok: false, code: 'gone' };

    const bearer = bearerForAgent(used.agentId);
    if (!bearer) {
      systemMessage(used.threadId, 'hub.join.systemFailed', {
        id: sessionId, reason: t('hub.join.reason.agent_unavailable'),
      });
      return { status: 200, ok: true, claimed: false, reason: 'agent_unavailable' };
    }

    let res;
    try {
      res = await doFetch(`${base}/api/v1/sessions/${sessionId}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(claimTimeoutMs),
      });
    } catch {
      systemMessage(used.threadId, 'hub.join.systemFailed', {
        id: sessionId, reason: t('hub.join.reason.enotdesk_unavailable'),
      });
      return { status: 200, ok: true, claimed: false, reason: 'enotdesk_unavailable' };
    }
    if (res.status === 201) {
      join.linkSession(used.tokenHash, sessionId);
      systemMessage(used.threadId, 'hub.join.systemClaimed', { id: sessionId });
      return { status: 200, ok: true, claimed: true, sessionId };
    }
    let body = null;
    try { body = await res.json(); } catch { /* не-JSON апстрима */ }
    // в ответе — машинный код (не локализуется), человекочитаемый текст уходит в system-сообщение
    const reason = typeof body?.error?.code === 'string' && body.error.code ? body.error.code : 'enotdesk_error';
    systemMessage(used.threadId, 'hub.join.systemFailed', { id: sessionId, reason: claimFailureReason(reason) });
    return { status: 200, ok: true, claimed: false, reason };
  };
}

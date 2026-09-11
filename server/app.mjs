import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { openDb, endLiveSessions, auditLog } from './db.mjs';
import {
  hashPassword, verifyPassword, newToken, sha256,
  sessionPassword, newSessionId, newClaimId,
} from './crypto.mjs';

const ROLES = ['admin', 'operator', 'auditor'];
const SIGNAL_WINDOW_MS = 5000;
const SIGNAL_MAX = 150;

function err(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function ok(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(undefined); }
    });
    req.on('error', () => resolve(null));
  });
}

export class RateLimiter {
  #hits = new Map();
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; }
  take(key) {
    const now = Date.now();
    let h = this.#hits.get(key);
    if (!h || now > h.reset) { h = { count: 0, reset: now + this.windowMs }; this.#hits.set(key, h); }
    h.count += 1;
    return h.count <= this.limit;
  }
}

function page(res, title, bodyHtml) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body>${bodyHtml}</body></html>`);
}

function validSignalData(data) {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (data.description) {
    const d = data.description;
    if (typeof d !== 'object' || d === null) return false;
    if (!['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string') return false;
    return keys.every((k) => k === 'description');
  }
  if ('candidate' in data) {
    const c = data.candidate;
    if (c === null) return true;
    if (typeof c !== 'object' || typeof c.candidate !== 'string') return false;
    return keys.every((k) => k === 'candidate');
  }
  return false;
}

const CONTACT_LIMITS = { name: 120, notes: 2000, tags: 10, tag: 30 };

function validateContactInput(body) {
  if (typeof body !== 'object' || body === null) return 'Некорректный запрос';
  if ('name' in body && (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > CONTACT_LIMITS.name)) {
    return 'Имя контакта: от 1 до 120 символов';
  }
  if ('notes' in body && (typeof body.notes !== 'string' || body.notes.length > CONTACT_LIMITS.notes)) {
    return 'Заметки: до 2000 символов';
  }
  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.length > CONTACT_LIMITS.tags ||
        body.tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > CONTACT_LIMITS.tag)) {
      return 'Метки: до 10 строк по 30 символов';
    }
  }
  return null;
}

function bearer(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' ? token || null : null;
}

export function createServer(opts = {}) {
  const cfg = {
    dbPath: opts.dbPath ?? ':memory:',
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 0,
    version: opts.version ?? '0.0.0',
    publicUrl: opts.publicUrl ?? '',
    turnUrls: opts.turnUrls ?? '',
    turnUsername: opts.turnUsername ?? '',
    turnPassword: opts.turnPassword ?? '',
    leaseMs: opts.leaseMs ?? 20000,
    heartbeatMs: opts.heartbeatMs ?? 5000,
    authTimeoutMs: opts.authTimeoutMs ?? 5000,
    bodyLimit: opts.bodyLimit ?? 64 * 1024,
    limits: {
      login: opts.limits?.login ?? new RateLimiter(10, 60_000),
      sessions: opts.limits?.sessions ?? new RateLimiter(10, 60_000),
      claim: opts.limits?.claim ?? new RateLimiter(10, 60_000),
      claimId: opts.limits?.claimId ?? new RateLimiter(20, 60_000),
      accept: opts.limits?.accept ?? new RateLimiter(10, 60_000),
    },
  };
  const db = openDb(cfg.dbPath);
  endLiveSessions(db, 'server-restart'); // рестарт инвалидирует живые регистрации

  const live = new Map(); // sessionId -> {hostWs, opWs, sigCount, sigReset}
  let closed = false;

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function endSession(sessionId, reason) {
    const now = new Date().toISOString();
    const r = db.prepare(
      "UPDATE sessions SET state='ended', ended_at=?, end_reason=? WHERE id=? AND state!='ended'"
    ).run(now, reason, sessionId);
    if (r.changes === 0) return false;
    const rt = live.get(sessionId);
    if (rt) {
      send(rt.hostWs, { type: 'ended', reason });
      send(rt.opWs, { type: 'ended', reason });
      for (const ws of [rt.hostWs, rt.opWs]) if (ws) ws.close(1000, 'ended');
      live.delete(sessionId);
    }
    return true;
  }

  const sweeper = setInterval(() => {
    const cutoff = new Date(Date.now() - cfg.heartbeatMs).toISOString();
    const rows = db.prepare(
      "SELECT id FROM sessions WHERE state!='ended' AND lease_expires_at < ?"
    ).all(cutoff);
    for (const row of rows) endSession(row.id, 'lease-expired');
  }, 1000);
  sweeper.unref();

  function authUser(req) {
    const token = bearer(req);
    if (!token) return null;
    const now = new Date().toISOString();
    const row = db.prepare(`
      SELECT u.id, u.login, u.name, u.role, u.active
      FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1
    `).get(sha256(token), now);
    return row || null;
  }

  function hostTokenSession(req) {
    const token = bearer(req);
    if (!token) return null;
    return db.prepare(
      "SELECT * FROM sessions WHERE host_token_hash = ? AND state != 'ended'"
    ).get(sha256(token)) || null;
  }

  function ip(req) {
    return req.socket.remoteAddress || 'unknown';
  }

  function listParams(url) {
    const q = url.searchParams;
    let limit = parseInt(q.get('limit') ?? '50', 10);
    let offset = parseInt(q.get('offset') ?? '0', 10);
    if (!Number.isInteger(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    return { limit, offset };
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) err(res, 500, 'internal', 'Внутренняя ошибка сервера');
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname.replace(/^\/api\/v1/, '');
    // CORS deny unknown origins: заголовки не выставляются вообще
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        if (o.host !== req.headers.host) return err(res, 403, 'forbidden', 'Недопустимый источник запроса');
      } catch { return err(res, 403, 'forbidden', 'Недопустимый источник запроса'); }
    }
    if (req.method !== 'GET') {
      var body = await readJson(req, cfg.bodyLimit);
      if (body === null) return err(res, 413, 'too_large', 'Слишком большой запрос');
    }

    // ---- health ----
    if (p === '/health' && req.method === 'GET') return ok(res, 200, { ok: true, version: cfg.version });

    // ---- auth ----
    if (p === '/auth/login' && req.method === 'POST') {
      if (!cfg.limits.login.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много попыток входа');
      const { login, password } = body || {};
      if (typeof login !== 'string' || typeof password !== 'string') {
        return err(res, 400, 'bad_request', 'Некорректный запрос');
      }
      const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login.trim().toLowerCase());
      if (!user || !user.active || !verifyPassword(password, user.password)) {
        auditLog(db, null, 'login.failure', null, { login: String(login).slice(0, 120) });
        return err(res, 401, 'invalid_credentials', 'Неверный логин или пароль');
      }
      const token = newToken();
      const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
        .run(sha256(token), user.id, expiresAt, new Date().toISOString());
      auditLog(db, user.id, 'login.success', user.id, {});
      return ok(res, 200, {
        token,
        user: { id: user.id, login: user.login, name: user.name, role: user.role, active: !!user.active },
        expiresAt,
      });
    }

    const user = authUser(req);

    if (p === '/auth/me' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      return ok(res, 200, { user });
    }
    if (p === '/auth/logout' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const token = bearer(req);
      if (token) db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(sha256(token));
      auditLog(db, user.id, 'logout', user.id, {});
      return ok(res, 200, { ok: true });
    }

    // ---- members ----
    if (p === '/members' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const { limit, offset } = listParams(url);
      const items = db.prepare(
        'SELECT id, login, name, role, active, created_at AS createdAt FROM users ORDER BY created_at LIMIT ? OFFSET ?'
      ).all(limit, offset).map((u) => ({ ...u, active: !!u.active }));
      const total = db.prepare('SELECT count(*) c FROM users').get().c;
      return ok(res, 200, { items, total });
    }
    let m = p.match(/^\/members\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(m[1]);
      if (!target) return err(res, 404, 'not_found', 'Участник не найден');
      const { role, active } = body || {};
      if (role !== undefined && !ROLES.includes(role)) return err(res, 400, 'bad_request', 'Некорректная роль');
      if (active !== undefined && typeof active !== 'boolean') return err(res, 400, 'bad_request', 'Некорректный признак активности');
      const losesAdmin = (role !== undefined && role !== 'admin' && target.role === 'admin') ||
                         (active === false && !!target.active && target.role === 'admin');
      if (losesAdmin) {
        const admins = db.prepare(
          "SELECT count(*) c FROM users WHERE role='admin' AND active=1 AND id != ?"
        ).get(target.id).c;
        if (admins === 0) return err(res, 409, 'last_admin', 'Нельзя отключить или понизить последнего активного администратора');
      }
      const now = new Date().toISOString();
      if (role !== undefined && role !== target.role) {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
        auditLog(db, user.id, 'member.role', target.id, { role });
      }
      if (active !== undefined && !!active !== !!target.active) {
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, target.id);
        auditLog(db, user.id, active ? 'member.enable' : 'member.disable', target.id, {});
        if (!active) {
          db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(target.id);
          for (const [sid, rt] of live) {
            if (rt.operatorUserId === target.id) endSession(sid, 'operator-revoked');
          }
        }
      }
      const u = db.prepare('SELECT id, login, name, role, active FROM users WHERE id = ?').get(target.id);
      return ok(res, 200, { user: { ...u, active: !!u.active } });
    }

    // ---- invites ----
    if (p === '/invites' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const { limit, offset } = listParams(url);
      const items = db.prepare(`
        SELECT id, role, expires_at AS expiresAt, used_at AS usedAt, revoked_at AS revokedAt, created_at AS createdAt
        FROM invites ORDER BY created_at LIMIT ? OFFSET ?`).all(limit, offset);
      const total = db.prepare('SELECT count(*) c FROM invites').get().c;
      return ok(res, 200, { items, total });
    }
    if (p === '/invites' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const role = body?.role;
      if (!ROLES.includes(role)) return err(res, 400, 'bad_request', 'Некорректная роль');
      const id = crypto.randomUUID();
      const token = newToken();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      db.prepare(`INSERT INTO invites (id, role, token_hash, expires_at, created_by, created_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(id, role, sha256(token), expiresAt, user.id, new Date().toISOString());
      auditLog(db, user.id, 'invite.create', id, { role });
      const base = cfg.publicUrl || `http://${req.headers.host}`;
      return ok(res, 201, {
        invite: { id, role, expiresAt },
        token,
        url: `${base}/invite#token=${token}`,
      });
    }
    m = p.match(/^\/invites\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const r = db.prepare(
        "UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL"
      ).run(new Date().toISOString(), m[1]);
      if (r.changes === 0) return err(res, 404, 'not_found', 'Приглашение не найдено или уже использовано');
      auditLog(db, user.id, 'invite.revoke', m[1], {});
      return ok(res, 200, { ok: true });
    }
    if (p === '/invites/accept' && req.method === 'POST') {
      if (!cfg.limits.accept.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много попыток');
      const { token, login, name, password } = body || {};
      if (typeof token !== 'string' || typeof login !== 'string' || typeof name !== 'string' || typeof password !== 'string' ||
          login.trim().length < 3 || name.trim().length < 1 || password.length < 8) {
        return err(res, 400, 'bad_request', 'Проверьте данные: логин от 3 символов, пароль от 8 символов');
      }
      const inv = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
      if (!inv || inv.used_at || inv.revoked_at || inv.expires_at <= new Date().toISOString()) {
        return err(res, 400, 'bad_invite', 'Приглашение недействительно');
      }
      const normLogin = login.trim().toLowerCase();
      const now = new Date().toISOString();
      // атомарный приём: одно использование приглашения + уникальный логин
      const used = db.prepare(
        'UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL'
      ).run(now, inv.id);
      if (used.changes !== 1) return err(res, 400, 'bad_invite', 'Приглашение недействительно');
      try {
        db.prepare(`INSERT INTO users (id, login, name, role, active, password, created_at)
                    VALUES (?,?,?,?,1,?,?)`)
          .run(crypto.randomUUID(), normLogin, name.trim(), inv.role, hashPassword(password), now);
      } catch {
        db.prepare('UPDATE invites SET used_at = NULL WHERE id = ?').run(inv.id); // откат приёма
        return err(res, 409, 'login_taken', 'Такой логин уже занят');
      }
      auditLog(db, null, 'invite.accept', inv.id, { role: inv.role });
      return ok(res, 200, { ok: true });
    }

    // ---- contacts ----
    function contactOut(row) {
      return { id: row.id, name: row.name, notes: row.notes, tags: JSON.parse(row.tags),
               revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
    }
    if (p === '/contacts' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { limit, offset } = listParams(url);
      const q = (url.searchParams.get('q') || '').trim();
      const where = q ? "WHERE ulower(name) LIKE ? OR ulower(notes) LIKE ?" : '';
      const like = `%${q.toLowerCase()}%`;
      const items = db.prepare(
        `SELECT * FROM contacts ${where} ORDER BY name LIMIT ? OFFSET ?`).all(...(q ? [like, like] : []), limit, offset);
      const total = db.prepare(`SELECT count(*) c FROM contacts ${where}`).get(...(q ? [like, like] : [])).c;
      return ok(res, 200, { items: items.map(contactOut), total });
    }
    if (p === '/contacts' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      if (typeof body?.name !== 'string') return err(res, 400, 'bad_request', 'Укажите имя контакта');
      const e = validateContactInput(body);
      if (e) return err(res, 400, 'bad_request', e);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO contacts (id, name, notes, tags, revision, created_at, updated_at)
                  VALUES (?,?,?,?,1,?,?)`)
        .run(id, body.name.trim(), body.notes ?? '', JSON.stringify(body.tags ?? []), now, now);
      auditLog(db, user.id, 'contact.create', id, {});
      return ok(res, 201, { contact: contactOut(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)) });
    }
    m = p.match(/^\/contacts\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(m[1]);
      if (!row) return err(res, 404, 'not_found', 'Контакт не найден');
      const e = validateContactInput(body);
      if (e) return err(res, 400, 'bad_request', e);
      if (!Number.isInteger(body?.revision) || body.revision !== row.revision) {
        return err(res, 409, 'revision_conflict', 'Контакт изменён другим участником, обновите данные');
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE contacts SET name=?, notes=?, tags=?, revision=revision+1, updated_at=? WHERE id=?`)
        .run(
          body.name !== undefined ? body.name.trim() : row.name,
          body.notes !== undefined ? body.notes : row.notes,
          body.tags !== undefined ? JSON.stringify(body.tags) : row.tags,
          now, row.id,
        );
      auditLog(db, user.id, 'contact.update', row.id, {});
      return ok(res, 200, { contact: contactOut(db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.id)) });
    }
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(m[1]);
      if (!row) return err(res, 404, 'not_found', 'Контакт не найден');
      if (!Number.isInteger(body?.revision) || body.revision !== row.revision) {
        return err(res, 409, 'revision_conflict', 'Контакт изменён другим участником, обновите данные');
      }
      db.prepare('DELETE FROM contacts WHERE id = ?').run(row.id);
      auditLog(db, user.id, 'contact.delete', row.id, {});
      return ok(res, 200, { ok: true });
    }

    // ---- history / audit ----
    if (p === '/history' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { limit, offset } = listParams(url);
      const items = db.prepare(`
        SELECT s.id, s.contact_id AS contactId, s.operator_id AS operatorId,
               u.name AS operatorName, s.state, s.created_at AS createdAt,
               s.started_at AS startedAt, s.ended_at AS endedAt, s.end_reason AS endReason
        FROM sessions s LEFT JOIN users u ON u.id = s.operator_id
        ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
      const total = db.prepare('SELECT count(*) c FROM sessions').get().c;
      return ok(res, 200, { items, total });
    }
    if (p === '/audit' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { limit, offset } = listParams(url);
      const items = db.prepare(`
        SELECT id, actor_id AS actorId, action, target_id AS targetId, detail, created_at AS createdAt
        FROM audit ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset)
        .map((a) => ({ ...a, detail: JSON.parse(a.detail) }));
      const total = db.prepare('SELECT count(*) c FROM audit').get().c;
      return ok(res, 200, { items, total });
    }

    // ---- sessions ----
    if (p === '/sessions' && req.method === 'POST') {
      if (!cfg.limits.sessions.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
      const id = newSessionId(db);
      const password = sessionPassword(8);
      const hostToken = newToken();
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at)
                  VALUES (?,?,?,'waiting',?,?)`)
        .run(id, hashPassword(password), sha256(hostToken), now, lease);
      auditLog(db, null, 'session.create', id, {});
      return ok(res, 201, { sessionId: id, password, hostToken, expiresAt: lease });
    }
    m = p.match(/^\/sessions\/([^/]+)\/claim$/);
    if (m && req.method === 'POST') {
      if (!cfg.limits.claim.take(`ip:${ip(req)}`) || !cfg.limits.claimId.take(`id:${m[1]}`)) {
        return err(res, 429, 'rate_limited', 'Слишком много попыток подключения');
      }
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const generic = () => err(res, 400, 'bad_request', 'Не удалось подключиться: проверьте идентификатор и пароль');
      const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(m[1]);
      if (!s || s.state !== 'waiting' || !verifyPassword(String(body?.password ?? ''), s.password_hash)) return generic();
      const claimId = newClaimId();
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      const contactId = typeof body?.contactId === 'string' && body.contactId ? body.contactId : null;
      const r = db.prepare(`
        UPDATE sessions SET claim_id=?, operator_id=?, contact_id=?, state='pending-consent', started_at=?, lease_expires_at=?
        WHERE id=? AND state='waiting'`).run(claimId, user.id, contactId, now, lease, s.id);
      if (r.changes !== 1) return generic();
      auditLog(db, user.id, 'session.claim', s.id, {});
      const rt = live.get(s.id);
      if (rt?.hostWs) send(rt.hostWs, { type: 'claim', claimId, operator: { id: user.id, name: user.name } });
      return ok(res, 201, {
        sessionId: s.id, claimId,
        operator: { id: user.id, name: user.name },
        state: 'pending-consent',
      });
    }
    m = p.match(/^\/sessions\/([^/]+)\/decision$/);
    if (m && req.method === 'POST') {
      const s = hostTokenSession(req);
      if (!s || s.id !== m[1]) return err(res, 403, 'forbidden', 'Недостаточно прав для этого сеанса');
      const { claimId, allow } = body || {};
      if (claimId !== s.claim_id || typeof allow !== 'boolean') {
        return err(res, 400, 'bad_request', 'Некорректный запрос решения');
      }
      if (allow) {
        db.prepare("UPDATE sessions SET state='approved' WHERE id = ?").run(s.id);
        auditLog(db, 'host', 'session.approve', s.id, { claimId });
        const rt = live.get(s.id);
        send(rt?.hostWs, { type: 'approved', claimId });
        send(rt?.opWs, { type: 'approved', claimId });
        return ok(res, 200, { ok: true });
      }
      auditLog(db, 'host', 'session.reject', s.id, { claimId });
      endSession(s.id, 'denied');
      return ok(res, 200, { ok: true });
    }
    m = p.match(/^\/sessions\/([^/]+)\/end$/);
    if (m && req.method === 'POST') {
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(m[1]);
      if (!s) return err(res, 404, 'not_found', 'Сеанс не найден');
      const token = bearer(req);
      const isHost = token && s.host_token_hash === sha256(token);
      const operator = authUser(req);
      const isOperator = operator && s.operator_id === operator.id;
      if (!isHost && !isOperator) return err(res, 403, 'forbidden', 'Недостаточно прав для этого сеанса');
      const changed = endSession(s.id, 'ended');
      if (changed) auditLog(db, isHost ? 'host' : operator.id, 'session.end', s.id, {});
      return ok(res, 200, { ok: true });
    }
    if (p === '/rtc-config' && req.method === 'GET') {
      const s = hostTokenSession(req);
      const authorized = s || authUser(req);
      if (!authorized) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const iceServers = [];
      if (cfg.turnUrls) {
        iceServers.push({
          urls: cfg.turnUrls.split(',').map((u) => u.trim()).filter(Boolean),
          username: cfg.turnUsername,
          credential: cfg.turnPassword,
        });
      }
      return ok(res, 200, { iceServers });
    }

    // ---- downloads / invite pages ----
    if (p === '/downloads' && req.method === 'GET' && !req.url.startsWith('/api')) {
      const rows = distFiles();
      const items = rows.map((f) =>
        `<li><a href="/api/v1/downloads-files/${encodeURIComponent(f.name)}">${f.name}</a> (${f.platform}/${f.arch})</li>`).join('');
      return page(res, 'EnotDesk — загрузка',
        `<h1>EnotDesk</h1><p>Портативные сборки для Windows, macOS и Linux.</p>` +
        (items ? `<ul>${items}</ul>` : '<p>Сборка ещё не готова.</p>'));
    }
    if (p === '/downloads' && req.method === 'GET') {
      return ok(res, 200, { items: distFiles() });
    }
    m = p.match(/^\/downloads-files\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const name = decodeURIComponent(m[1]);
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return err(res, 400, 'bad_request', 'Некорректное имя файла');
      }
      const file = distFiles().find((f) => f.name === name);
      if (!file) return err(res, 404, 'not_found', 'Файл недоступен');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size });
      fs.createReadStream(path.join(process.cwd(), 'dist', name)).pipe(res);
      return;
    }
    if (p === '/invite' && req.method === 'GET' && !req.url.startsWith('/api')) {
      return page(res, 'EnotDesk — приглашение',
        `<h1>Приглашение в команду EnotDesk</h1>` +
        `<p>Откройте приложение EnotDesk и вставьте код приглашения в форму принятия приглашения.</p>`);
    }

    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  function distFiles() {
    // Только разрешённые имена файлов из dist/ — никакие другие файлы проекта не отдаются
    const allow = [/^EnotDesk.*\.exe$/, /^EnotDesk.*\.zip$/, /^EnotDesk.*\.AppImage$/];
    const dir = path.join(process.cwd(), 'dist');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    return names
      .filter((n) => allow.some((re) => re.test(n)))
      .map((n) => {
        const platform = n.endsWith('.exe') ? 'win32' : n.endsWith('.AppImage') ? 'linux' : 'darwin';
        const arch = /arm64/i.test(n) ? 'arm64' : 'x64';
        let size = 0;
        try { size = fs.statSync(path.join(dir, n)).size; } catch { /* исчез файл между readdir и stat */ }
        return { platform, arch, name: n, url: `/api/v1/downloads-files/${encodeURIComponent(n)}`, size };
      });
  }

  // ---- WS /signal ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/signal') { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
      if (!same) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws));
  });

  function onSocket(ws) {
    let session = null;
    let role = null;
    let authed = false;
    // превышение maxPayload и сетевые сбои приходят ошибкой; ws сам закрывает 1009
    ws.on('error', () => {});
    const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'auth-timeout'); }, cfg.authTimeoutMs);

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!authed || !session) return;
      const rt = live.get(session.id);
      if (!rt) return;
      if (role === 'host' && rt.hostWs === ws) {
        rt.hostWs = null;
        endSession(session.id, 'host-lost');
      } else if (role === 'operator' && rt.opWs === ws) {
        rt.opWs = null;
        endSession(session.id, 'operator-lost');
      }
    });

    ws.on('message', (raw) => {
      if (authed) return handleMessage(ws, raw);
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return ws.close(4002, 'bad-message'); }
      if (!msg || msg.type !== 'auth') return ws.close(4002, 'auth-first');
      const now = new Date().toISOString();
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(String(msg.sessionId ?? ''));
      if (!s || s.state === 'ended') return ws.close(4003, 'invalid-session');
      if (msg.role === 'host') {
        if (typeof msg.token !== 'string' || sha256(msg.token) !== s.host_token_hash) return ws.close(4003, 'invalid-session');
        if (s.lease_expires_at <= now) return ws.close(4003, 'invalid-session');
        role = 'host';
      } else if (msg.role === 'operator') {
        const u = authUser({ headers: { authorization: `Bearer ${msg.token}` }, socket: { remoteAddress: '' } });
        if (!u || !['admin', 'operator'].includes(u.role)) return ws.close(4003, 'invalid-session');
        if (msg.claimId !== s.claim_id || s.operator_id !== u.id) return ws.close(4003, 'invalid-session');
        if (!['pending-consent', 'approved'].includes(s.state)) return ws.close(4003, 'invalid-session');
        role = 'operator';
        ws._userId = u.id;
      } else {
        return ws.close(4002, 'auth-first');
      }
      // один сокет на участника
      let rt = live.get(s.id);
      if (rt && (msg.role === 'host' ? rt.hostWs : rt.opWs)) {
        return ws.close(4004, 'duplicate-socket');
      }
      if (!rt) { rt = { hostWs: null, opWs: null, operatorUserId: null, sigCount: 0, sigReset: 0 }; live.set(s.id, rt); }
      if (msg.role === 'host') {
        rt.hostWs = ws;
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() + cfg.leaseMs).toISOString(), s.id);
      } else {
        rt.opWs = ws;
        rt.operatorUserId = ws._userId;
      }
      session = s;
      authed = true;
      clearTimeout(authTimer);
      const fresh = db.prepare('SELECT state FROM sessions WHERE id = ?').get(s.id);
      send(ws, { type: 'ready', sessionId: s.id, role, state: fresh.state });
      if (role === 'host' && fresh.state === 'pending-consent' && s.claim_id) {
        const op = db.prepare('SELECT id, name FROM users WHERE id = ?').get(s.operator_id);
        send(ws, { type: 'claim', claimId: s.claim_id, operator: op });
      }
      if (role === 'operator' && fresh.state === 'approved') {
        send(ws, { type: 'approved', claimId: s.claim_id });
      }
    });

    function handleMessage(ws, raw) {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return send(ws, { type: 'error', code: 'bad_message', message: 'Некорректное сообщение' }); }
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      if (!s || s.state === 'ended') return;
      if (msg.type === 'heartbeat') {
        if (role !== 'host') return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() + cfg.leaseMs).toISOString(), s.id);
        return send(ws, { type: 'heartbeat' });
      }
      if (msg.type === 'signal') {
        if (role !== 'host' && role !== 'operator') return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        const rt = live.get(s.id);
        const isHost = role === 'host' && rt?.hostWs === ws;
        const isOp = role === 'operator' && rt?.opWs === ws;
        if (!isHost && !isOp) return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        if (s.state !== 'approved') {
          return send(ws, { type: 'error', code: 'not_approved', message: 'Сигналы доступны только после подтверждения' });
        }
        const now = Date.now();
        if (now > rt.sigReset) { rt.sigReset = now + SIGNAL_WINDOW_MS; rt.sigCount = 0; }
        rt.sigCount += 1;
        if (rt.sigCount > SIGNAL_MAX) {
          return send(ws, { type: 'error', code: 'rate_limited', message: 'Слишком частая передача сигналов' });
        }
        if (!validSignalData(msg.data)) {
          return send(ws, { type: 'error', code: 'bad_signal', message: 'Некорректный сигнал' });
        }
        const target = isHost ? rt.opWs : rt.hostWs;
        const clean = msg.data.description
          ? { type: 'signal', data: { description: { type: msg.data.description.type, sdp: msg.data.description.sdp } } }
          : { type: 'signal', data: { candidate: msg.data.candidate } };
        return send(target, clean);
      }
      return send(ws, { type: 'error', code: 'bad_message', message: 'Некорректное сообщение' });
    }
  }

  return {
    server,
    db,
    start: () => new Promise((resolve) => {
      server.listen(cfg.port, cfg.host, () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      clearInterval(sweeper);
      for (const [id, rt] of live) {
        for (const ws of [rt.hostWs, rt.opWs]) if (ws) ws.terminate();
      }
      live.clear();
      for (const client of wss.clients) client.terminate();
      server.close(() => { db.close(); resolve(); });
    }),
  };
}

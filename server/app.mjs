import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { openDb, endLiveSessions, auditLog, runRetention } from './db.mjs';
import { createMachinesStore } from './machines.mjs';
import { createWebhooks } from './webhooks.mjs';
import { page, downloadsHtml, inviteHtml, operatorPage, isInsecurePage } from './pages.mjs';
import { t, pickLocale } from '../client/lib/i18n.mjs';
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
  #now;
  #maxKeys;
  constructor(limit, windowMs, { now = Date.now, maxKeys = 5000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }
  take(key) {
    const now = this.#now();
    // публичный интернет: чужие IP не должны расти в памяти бесконечно
    if (this.#hits.size >= this.#maxKeys) {
      for (const [k, h] of this.#hits) if (now > h.reset) this.#hits.delete(k);
    }
    let h = this.#hits.get(key);
    if (!h || now > h.reset) { h = { count: 0, reset: now + this.windowMs }; this.#hits.set(key, h); }
    h.count += 1;
    return h.count <= this.limit;
  }

  // Порог исчерпан (без инкремента): для брутфорс-защиты логина, где
  // лимит бьют только неудачные попытки, а проверять надо каждую.
  exceeded(key) {
    const h = this.#hits.get(key);
    if (!h) return false;
    const now = this.#now();
    if (now > h.reset) return false;
    return h.count >= this.limit;
  }
}

const BRAND_FILES = {
  'enot-mascot.svg': 'image/svg+xml',
  'enot-icon.svg': 'image/svg+xml',
  'icon.png': 'image/png',
  'mascot-site.png': 'image/png',
  'mascot-app.png': 'image/png',
};

// Статика браузерного оператора: только разрешённые имена из каталогов репозитория —
// traversal исключён, всё остальное 404. Это модули страницы (/web, переиспользуемые
// client/lib и client/renderer/{dom,state}) и её словари.
const OPERATOR_ASSETS = {
  web: {
    dir: '../web/',
    files: { 'operator.mjs': 'text/javascript', 'input-source.mjs': 'text/javascript' },
  },
  'client/lib': {
    dir: '../client/lib/',
    files: {
      'i18n.mjs': 'text/javascript', 'protocol.mjs': 'text/javascript', 'keymap.mjs': 'text/javascript',
      'chat.mjs': 'text/javascript', 'clipboard-sync.mjs': 'text/javascript', 'file-transfer.mjs': 'text/javascript',
      'media-toggle.mjs': 'text/javascript', 'rtc-stats.mjs': 'text/javascript',
    },
  },
  'client/renderer': {
    dir: '../client/renderer/',
    files: { 'dom.js': 'text/javascript', 'state.js': 'text/javascript' },
  },
  'client/locales': {
    dir: '../client/locales/',
    files: { 'ru.json': 'application/json', 'en.json': 'application/json' },
  },
};

// RFC 9110: невалидный/чужой Range игнорируем (null → 200), валидный неудовлетворимый → {unsatisfiable} (416),
// единственный диапазон `bytes=start-end` / `bytes=start-` / `bytes=-suffix` → {start,end} (206).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') {
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? Number.POSITIVE_INFINITY : parseInt(m[2], 10);
    if (end < start) return null; // last-byte-pos < first-byte-pos — byte-range-spec невалиден, игнорируем
    if (end > size - 1) end = size - 1;
  }
  if (size === 0 || start >= size) return { unsatisfiable: true };
  return { start, end };
}

function streamOut(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
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
const MACHINE_LIMITS = { name: 120, group: 60, reason: 500, pin: 128 };

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
    distDir: opts.distDir || process.env.ENOT_DIST_DIR || path.join(process.cwd(), 'dist'),
    publicUrl: opts.publicUrl ?? '',
    turnUrls: opts.turnUrls ?? '',
    turnUsername: opts.turnUsername ?? '',
    turnPassword: opts.turnPassword ?? '',
    leaseMs: opts.leaseMs ?? 20000,
    heartbeatMs: opts.heartbeatMs ?? 5000,
    // грейс на переподключение участника в состоянии approved; 0 — старое fail-closed
    graceMs: opts.graceMs ?? 30_000,
    // сколько дней хранить завершённые сеансы; 0 — хранить вечно
    retentionDays: opts.retentionDays ?? 90,
    // потолок живых (WS) сеансов — защита памяти публичного сервера
    maxSessions: opts.maxSessions ?? 200,
    authTimeoutMs: opts.authTimeoutMs ?? 5000,
    bodyLimit: opts.bodyLimit ?? 64 * 1024,
    limits: {
      login: opts.limits?.login ?? new RateLimiter(10, 60_000),
      // брутфорс конкретного логина: порог бьют только неудачные попытки
      loginId: opts.limits?.loginId ?? new RateLimiter(5, 15 * 60_000),
      sessions: opts.limits?.sessions ?? new RateLimiter(10, 60_000),
      claim: opts.limits?.claim ?? new RateLimiter(10, 60_000),
      claimId: opts.limits?.claimId ?? new RateLimiter(20, 60_000),
      accept: opts.limits?.accept ?? new RateLimiter(10, 60_000),
      // unattended-машины: попытки claim с одного IP и порог неудачных политик
      // на конкретную машину (подбор PIN/причины), регистрация агента по коду
      machineClaim: opts.limits?.machineClaim ?? new RateLimiter(10, 60_000),
      machineClaimId: opts.limits?.machineClaimId ?? new RateLimiter(5, 15 * 60_000),
      agentRegister: opts.limits?.agentRegister ?? new RateLimiter(10, 60_000),
    },
  };
  const db = openDb(cfg.dbPath);
  endLiveSessions(db, 'server-restart'); // рестарт инвалидирует живые регистрации
  const machinesStore = createMachinesStore(db);
  const webhooks = createWebhooks(db);

  // Коды ошибок настройки webhooks → честные тексты маршрута
  const WEBHOOK_ERR_TEXT = {
    bad_url: 'URL должен быть http(s)-адресом',
    url_too_long: 'URL слишком длинный (до 2048 символов)',
    secret_required: 'Укажите секрет подписи',
    secret_too_long: 'Секрет слишком длинный (до 256 символов)',
  };

  const live = new Map(); // sessionId -> {hostWs, opWs, operatorUserId, sigCount, sigReset, hostLostAt, opLostAt, termActive}
  let closed = false;

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  // Истёкший грейс участника завершает сеанс; в активном грейсе lease не судья
  // (host не шлёт heartbeat, пока переподключается).
  function gracePending(rt, nowMs) {
    const hostWait = rt.hostLostAt != null && nowMs - rt.hostLostAt <= cfg.graceMs;
    const opWait = rt.opLostAt != null && nowMs - rt.opLostAt <= cfg.graceMs;
    return { hostWait, opWait, any: hostWait || opWait };
  }

  function endSession(sessionId, reason) {
    const now = new Date().toISOString();
    const r = db.prepare(
      "UPDATE sessions SET state='ended', ended_at=?, end_reason=? WHERE id=? AND state!='ended'"
    ).run(now, reason, sessionId);
    if (r.changes === 0) return false;
    // доставка события асинхронная: сеанс не ждёт webhook
    webhooks.emit('session.ended', { sessionId, reason });
    const rt = live.get(sessionId);
    if (rt) {
      // Терминал живёт не дольше сеанса (R09): если был активен — честный term.close.
      if (rt.termActive === true) {
        const s0 = db.prepare('SELECT machine_id FROM sessions WHERE id = ?').get(sessionId);
        auditLog(db, s0?.machine_id ?? null, 'term.close', sessionId, {
          host: !s0?.machine_id, unattended: !!s0?.machine_id, ...(s0?.machine_id ? { machineId: s0.machine_id } : {}), reason,
        });
      }
      send(rt.hostWs, { type: 'ended', reason });
      send(rt.opWs, { type: 'ended', reason });
      for (const ws of [rt.hostWs, rt.opWs]) if (ws) ws.close(1000, 'ended');
      live.delete(sessionId);
    }
    return true;
  }

  function endOperatorSessions(userId, reason) {
    for (const [sid, rt] of live) {
      if (rt.operatorUserId === userId) endSession(sid, reason);
    }
  }

  // Обрыв участника: до согласия и при graceMs=0 — fail-closed; в approved даём
  // грейс на переподключение теми же токенами (ADR 0013).
  function participantLost(sessionId, rt, who) {
    const s = db.prepare('SELECT state FROM sessions WHERE id = ?').get(sessionId);
    if (!s || s.state === 'ended') return;
    if (cfg.graceMs <= 0 || s.state !== 'approved') {
      endSession(sessionId, who === 'host' ? 'host-lost' : 'operator-lost');
      return;
    }
    if (who === 'host') rt.hostLostAt = Date.now();
    else rt.opLostAt = Date.now();
    send(who === 'host' ? rt.opWs : rt.hostWs, { type: 'peer-reconnecting', role: who });
  }

  const sweeper = setInterval(() => {
    const nowMs = Date.now();
    for (const [id, rt] of [...live]) {
      if (rt.hostLostAt != null && nowMs - rt.hostLostAt > cfg.graceMs) endSession(id, 'host-lost');
      else if (rt.opLostAt != null && nowMs - rt.opLostAt > cfg.graceMs) endSession(id, 'operator-lost');
    }
    const cutoff = new Date(nowMs - cfg.heartbeatMs).toISOString();
    const rows = db.prepare(
      "SELECT id FROM sessions WHERE state!='ended' AND lease_expires_at < ?"
    ).all(cutoff);
    for (const row of rows) {
      const rt = live.get(row.id);
      if (rt && gracePending(rt, nowMs).any) continue; // ждём переподключения
      endSession(row.id, 'lease-expired');
    }
  }, 1000);
  sweeper.unref();

  // Дом-уборщик: истёкшие токены, завершённые приглашения, старые сеансы (раз в час).
  const housekeeper = setInterval(() => { runRetention(db, { retentionDays: cfg.retentionDays }); }, 3_600_000);
  housekeeper.unref();

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
    if (p === '/health' && req.method === 'GET') {
      return ok(res, 200, {
        ok: true,
        version: cfg.version,
        activeSessions: live.size,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    // ---- auth ----
    if (p === '/auth/login' && req.method === 'POST') {
      if (!cfg.limits.login.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много попыток входа');
      const { login, password } = body || {};
      if (typeof login !== 'string' || typeof password !== 'string') {
        return err(res, 400, 'bad_request', 'Некорректный запрос');
      }
      const loginKey = `login:${login.trim().toLowerCase()}`;
      // брутфорс конкретного аккаунта: порог бьют только неудачные попытки,
      // поэтому состояние проверяем без инкремента — верный пароль тоже отклоняется
      if (cfg.limits.loginId.exceeded(loginKey)) {
        return err(res, 429, 'rate_limited', 'Слишком много неудачных попыток, попробуйте позже');
      }
      const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login.trim().toLowerCase());
      if (!user || !user.active || !verifyPassword(password, user.password)) {
        cfg.limits.loginId.take(loginKey);
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
    if (p === '/auth/password' && req.method === 'PATCH') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const { oldPassword, newPassword } = body || {};
      if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
        return err(res, 400, 'bad_request', 'Проверьте данные: новый пароль — от 8 символов');
      }
      const row = db.prepare('SELECT password FROM users WHERE id = ?').get(user.id);
      if (!row || !verifyPassword(oldPassword, row.password)) {
        return err(res, 403, 'wrong_password', 'Текущий пароль указан неверно');
      }
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
      // прочие сеансы выходят принудительно: старые токены умирают, текущий остаётся;
      // живые WS-сеансы, где пользователь — оператор, тоже рвём (WS-аутентификация одноразовая)
      const current = sha256(bearer(req) ?? '');
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash != ?').run(user.id, current);
      endOperatorSessions(user.id, 'password-changed');
      auditLog(db, user.id, 'password.change', user.id, {});
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
      if (role !== undefined && role !== target.role) {
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
        auditLog(db, user.id, 'member.role', target.id, { role });
      }
      if (active !== undefined && !!active !== !!target.active) {
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, target.id);
        auditLog(db, user.id, active ? 'member.enable' : 'member.disable', target.id, {});
        if (!active) {
          db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(target.id);
          endOperatorSessions(target.id, 'operator-revoked');
        }
      }
      const u = db.prepare('SELECT id, login, name, role, active FROM users WHERE id = ?').get(target.id);
      return ok(res, 200, { user: { ...u, active: !!u.active } });
    }
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(m[1]);
      if (!target) return err(res, 404, 'not_found', 'Участник не найден');
      if (target.id === user.id) return err(res, 409, 'self_delete', 'Нельзя удалить собственную учётную запись');
      if (target.role === 'admin' && !!target.active) {
        const admins = db.prepare(
          "SELECT count(*) c FROM users WHERE role='admin' AND active=1 AND id != ?"
        ).get(target.id).c;
        if (admins === 0) return err(res, 409, 'last_admin', 'Нельзя удалить последнего активного администратора');
      }
      endOperatorSessions(target.id, 'operator-revoked');
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      auditLog(db, user.id, 'member.delete', target.id, { login: target.login, role: target.role });
      return ok(res, 200, { ok: true });
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
          login.trim().length < 3 || login.trim().length > 32 || name.trim().length < 1 || name.trim().length > 120 || password.length < 8) {
        return err(res, 400, 'bad_request', 'Проверьте данные: логин от 3 до 32 символов, имя до 120, пароль от 8 символов');
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
               u.name AS operatorName, s.state, s.machine_id AS machineId,
               s.created_at AS createdAt,
               s.started_at AS startedAt, s.ended_at AS endedAt, s.end_reason AS endReason
        FROM sessions s LEFT JOIN users u ON u.id = s.operator_id
        ORDER BY s.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
      const total = db.prepare('SELECT count(*) c FROM sessions').get().c;
      return ok(res, 200, { items, total });
    }
    if (p === '/audit' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      // журнал действий — для админов и наблюдателей; оператору не нужен
      if (!['admin', 'auditor'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
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
      const clientIp = ip(req);
      if (!cfg.limits.sessions.take(clientIp)) return err(res, 429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
      // потолок «висящих» регистраций с одного адреса: без авторизации иначе копить мусор
      const waiting = db.prepare("SELECT count(*) c FROM sessions WHERE created_ip = ? AND state = 'waiting'").get(clientIp).c;
      if (waiting >= 3) return err(res, 429, 'rate_limited', 'Слишком много активных запросов, попробуйте позже');
      const id = newSessionId(db);
      const password = sessionPassword(8);
      const hostToken = newToken();
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at, created_ip)
                  VALUES (?,?,?,'waiting',?,?,?)`)
        .run(id, hashPassword(password), sha256(hostToken), now, lease, clientIp);
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
        // повторный allow — no-op: approved уходит один раз, при переподключении
        // его разыгрывает WS-аутентификация (replay)
        const r = db.prepare("UPDATE sessions SET state='approved' WHERE id = ? AND state != 'approved'").run(s.id);
        if (r.changes === 1) {
          auditLog(db, null, 'session.approve', s.id, { host: true, claimId });
          webhooks.emit('session.started', {
            sessionId: s.id, operatorId: s.operator_id, machineId: s.machine_id, contactId: s.contact_id,
          });
          const rt = live.get(s.id);
          send(rt?.hostWs, { type: 'approved', claimId });
          send(rt?.opWs, { type: 'approved', claimId });
        }
        return ok(res, 200, { ok: true });
      }
      auditLog(db, null, 'session.reject', s.id, { host: true, claimId });
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
      if (changed) auditLog(db, isHost ? null : operator.id, 'session.end', s.id, isHost ? { host: true } : {});
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

    // ---- webhooks (D1): настройка доставки событий, только админ ----
    if (p === '/settings/webhooks' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      return ok(res, 200, webhooks.get()); // секрет маскирован внутри webhooks.get()
    }
    if (p === '/settings/webhooks' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const { url, secret, events } = body || {};
      if (events !== undefined && events !== null && !Array.isArray(events)) {
        return err(res, 400, 'bad_request', 'Список событий должен быть массивом');
      }
      if (events !== undefined && events !== null && events.some((e) => typeof e !== 'string')) {
        return err(res, 400, 'bad_request', 'Список событий должен быть массивом строк');
      }
      const r = webhooks.configure(url, secret, events ?? null);
      if (!r.ok) return err(res, 400, r.error, WEBHOOK_ERR_TEXT[r.error] || 'Некорректные настройки');
      auditLog(db, user.id, 'webhooks.config', null, { url: r.url, events: r.events });
      return ok(res, 200, webhooks.get());
    }

    // ---- machines (unattended); отказные тексты — через словари i18n, язык запроса ----
    if (p === '/machines' && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const { limit, offset } = listParams(url);
      return ok(res, 200, machinesStore.list({ limit, offset }));
    }
    if (p === '/machines' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const locale = pickLocale(req.headers['accept-language']);
      const { name, group } = body || {};
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > MACHINE_LIMITS.name) {
        return err(res, 400, 'bad_request', t('machines.nameLength', {}, locale));
      }
      if (group !== undefined && (typeof group !== 'string' || group.trim().length > MACHINE_LIMITS.group)) {
        return err(res, 400, 'bad_request', t('machines.groupLength', {}, locale));
      }
      const { machine, code, expiresAt } = machinesStore.createOnboarding({
        name: name.trim(), groupName: (group ?? '').trim(), createdBy: user.id,
      });
      auditLog(db, user.id, 'machine.create', machine.id, { name: machine.name, group: machine.groupName });
      // открытый текст кода уходит один раз; в БД останется только хеш
      return ok(res, 201, { machine, code, expiresAt });
    }
    m = p.match(/^\/machines\/([^/]+)\/claim$/);
    if (m && req.method === 'POST') {
      const locale = pickLocale(req.headers['accept-language']);
      if (!cfg.limits.machineClaim.take(`ip:${ip(req)}`) || cfg.limits.machineClaimId.exceeded(`id:${m[1]}`)) {
        return err(res, 429, 'rate_limited', t('machines.claimLimited', {}, locale));
      }
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const machine = machinesStore.get(m[1]);
      if (!machine) return err(res, 404, 'not_found', t('machines.notFound', {}, locale));
      // отказ политики фиксируется в аудите; значение PIN в тексты и журнал не подставляется
      const deny = (code, key, status) => {
        auditLog(db, machine.id, 'machine.claim.deny', machine.id, { unattended: true, code, operatorId: user.id });
        webhooks.emit('machine.claim.denied', { machineId: machine.id, code, operatorId: user.id });
        return err(res, status, code, t(key, {}, locale));
      };
      if (machine.revoked_at) return err(res, 409, 'machine_revoked', t('machines.revoked', {}, locale));
      if (!machine.agent_token_hash) return err(res, 409, 'not_registered', t('machines.notRegistered', {}, locale));
      const busy = db.prepare("SELECT count(*) c FROM sessions WHERE machine_id = ? AND state != 'ended'").get(machine.id).c;
      if (busy > 0) return err(res, 409, 'machine_busy', t('machines.busy', {}, locale));
      const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 1 || reason.length > MACHINE_LIMITS.reason) {
        return deny('reason_required', 'machines.reasonRequired', 400);
      }
      if (machine.pin_hash) {
        const pin = body?.pin;
        if (typeof pin !== 'string' || !pin) return deny('pin_required', 'machines.pinRequired', 400);
        if (!machinesStore.verifyPin(machine, pin)) {
          // порог бьют только неудачные попытки: верный PIN не остаётся запертым
          cfg.limits.machineClaimId.take(`id:${machine.id}`);
          return deny('bad_pin', 'machines.badPin', 403);
        }
      }
      // успех: host сеанса — агент с машинным токеном; согласие человека не нужно,
      // политику (причина + PIN) сервер уже проверил сам
      const sessionId = newSessionId(db);
      const claimId = newClaimId();
      const nowIso = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, operator_id, claim_id, machine_id, created_at, started_at, lease_expires_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(sessionId, hashPassword(sessionPassword(8)), machine.agent_token_hash, 'pending-consent',
             user.id, claimId, machine.id, nowIso, nowIso, lease);
      auditLog(db, machine.id, 'machine.claim', sessionId, { unattended: true, reason, operatorId: user.id });
      return ok(res, 201, {
        sessionId, claimId, machineId: machine.id,
        operator: { id: user.id, name: user.name },
        state: 'pending-consent',
      });
    }
    m = p.match(/^\/machines\/([^/]+)\/pin$/);
    if (m && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const locale = pickLocale(req.headers['accept-language']);
      const machine = machinesStore.get(m[1]);
      if (!machine) return err(res, 404, 'not_found', t('machines.notFound', {}, locale));
      const pin = body?.pin;
      if (pin == null || pin === '') {
        machinesStore.setPin(machine.id, null);
        auditLog(db, user.id, 'machine.pin', machine.id, { set: false });
        return ok(res, 200, { ok: true, hasPin: false });
      }
      if (typeof pin !== 'string' || pin.length < 4 || pin.length > MACHINE_LIMITS.pin) {
        return err(res, 400, 'bad_request', t('machines.pinLength', {}, locale));
      }
      machinesStore.setPin(machine.id, pin);
      auditLog(db, user.id, 'machine.pin', machine.id, { set: true });
      return ok(res, 200, { ok: true, hasPin: true });
    }
    m = p.match(/^\/machines\/([^/]+)\/revoke$/);
    if (m && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const locale = pickLocale(req.headers['accept-language']);
      const machine = machinesStore.get(m[1]);
      if (!machine || !machinesStore.revoke(machine.id)) {
        return err(res, 404, 'not_found', t('machines.revokeNotFound', {}, locale));
      }
      // живые сеансы отозванной машины завершаются честной причиной
      for (const row of db.prepare("SELECT id FROM sessions WHERE machine_id = ? AND state != 'ended'").all(machine.id)) {
        endSession(row.id, 'machine-revoked');
      }
      auditLog(db, user.id, 'machine.revoke', machine.id, { name: machine.name });
      return ok(res, 200, { ok: true });
    }
    m = p.match(/^\/machines\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const locale = pickLocale(req.headers['accept-language']);
      const machine = machinesStore.get(m[1]);
      if (!machine) return err(res, 404, 'not_found', t('machines.notFound', {}, locale));
      machinesStore.delete(machine.id);
      auditLog(db, user.id, 'machine.delete', machine.id, { name: machine.name });
      return ok(res, 200, { ok: true });
    }

    // ---- agent (машина как клиент; аутентификация токеном машины) ----
    if (p === '/agent/register' && req.method === 'POST') {
      const locale = pickLocale(req.headers['accept-language']);
      if (!cfg.limits.agentRegister.take(ip(req))) return err(res, 429, 'rate_limited', t('machines.registerLimited', {}, locale));
      const { code, name, os, version } = body || {};
      if (typeof code !== 'string' || !code ||
          typeof name !== 'string' || name.trim().length < 1 || name.length > MACHINE_LIMITS.name ||
          (os !== undefined && (typeof os !== 'string' || os.length > 60)) ||
          (version !== undefined && (typeof version !== 'string' || version.length > 60))) {
        return err(res, 400, 'bad_request', t('machines.registerBad', {}, locale));
      }
      const r = machinesStore.register({ code, name: name.trim(), os: os ?? '', version: version ?? '' });
      if (!r) return err(res, 400, 'bad_code', t('machines.badCode', {}, locale));
      auditLog(db, r.machine.id, 'machine.register', r.machine.id, { os: r.machine.os, version: r.machine.agentVersion });
      return ok(res, 201, { machineId: r.machine.id, name: r.machine.name, token: r.token });
    }
    if (p === '/agent/session' && req.method === 'GET') {
      const locale = pickLocale(req.headers['accept-language']);
      const machine = machinesStore.machineByToken(bearer(req) ?? '');
      if (!machine) return err(res, 401, 'unauthorized', t('machines.tokenRequired', {}, locale));
      const s = db.prepare(`
        SELECT s.id, s.state, s.claim_id, u.id AS opId, u.name AS opName
        FROM sessions s LEFT JOIN users u ON u.id = s.operator_id
        WHERE s.machine_id = ? AND s.state != 'ended'
        ORDER BY s.created_at DESC LIMIT 1`).get(machine.id);
      if (!s) return err(res, 404, 'no_session', t('machines.noSession', {}, locale));
      return ok(res, 200, {
        sessionId: s.id, state: s.state, claimId: s.claim_id,
        operator: s.opId ? { id: s.opId, name: s.opName } : null,
      });
    }
    if (p === '/agent/heartbeat' && req.method === 'POST') {
      const locale = pickLocale(req.headers['accept-language']);
      const machine = machinesStore.machineByToken(bearer(req) ?? '');
      if (!machine) return err(res, 401, 'unauthorized', t('machines.tokenRequired', {}, locale));
      machinesStore.touch(machine.id);
      return ok(res, 200, { ok: true });
    }

    // ---- pages / brand / downloads ----
    if (p === '/' && req.method === 'GET' && !req.url.startsWith('/api')) {
      res.writeHead(302, { Location: '/downloads' });
      res.end();
      return;
    }
    if (p === '/downloads' && req.method === 'GET' && !req.url.startsWith('/api')) {
      const locale = pickLocale(req.headers['accept-language']);
      const insecure = isInsecurePage(req, cfg.publicUrl);
      return page(res, t('server.titleDownloads', {}, locale), downloadsHtml(distFiles(), cfg.version, locale, insecure), locale);
    }
    if (p === '/downloads' && req.method === 'GET') {
      return ok(res, 200, { items: distFiles() });
    }
    m = p.match(/^\/brand\/([^/]+)$/);
    if (m && req.method === 'GET') {
      let name;
      try { name = decodeURIComponent(m[1]); } catch { name = ''; }
      if (!Object.hasOwn(BRAND_FILES, name)) return err(res, 404, 'not_found', 'Файл не найден');
      let data;
      try { data = fs.readFileSync(new URL(`../assets/${name}`, import.meta.url)); }
      catch { return err(res, 404, 'not_found', 'Файл не найден'); }
      res.writeHead(200, { 'Content-Type': BRAND_FILES[name], 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
      return;
    }
    m = p.match(/^\/downloads-files\/([^/]+)$/);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      let name;
      try { name = decodeURIComponent(m[1]); } catch { name = ''; }
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        return err(res, 400, 'bad_request', 'Некорректное имя файла');
      }
      const file = distFiles().find((f) => f.name === name);
      if (!file) return err(res, 404, 'not_found', 'Файл недоступен');
      const fullPath = path.join(cfg.distDir, name);
      const etag = `"${file.etag}"`;
      const base = {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Last-Modified': new Date(file.mtimeMs).toUTCString(),
        'ETag': etag,
      };
      // качалка уже скачала эту версию — не перекачиваем гигабайты
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      const range = parseRange(req.headers.range, file.size);
      if (range?.unsatisfiable) {
        res.writeHead(416, { ...base, 'Content-Range': `bytes */${file.size}` });
        return res.end();
      }
      if (range) {
        res.writeHead(206, {
          ...base,
          'Content-Length': range.end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
        });
        if (req.method === 'HEAD') return res.end();
        return streamOut(fs.createReadStream(fullPath, { start: range.start, end: range.end }), res);
      }
      res.writeHead(200, { ...base, 'Content-Length': file.size });
      if (req.method === 'HEAD') return res.end();
      return streamOut(fs.createReadStream(fullPath), res);
    }
    if (p === '/invite' && req.method === 'GET' && !req.url.startsWith('/api')) {
      const locale = pickLocale(req.headers['accept-language']);
      const insecure = isInsecurePage(req, cfg.publicUrl);
      return page(res, t('server.titleInvite', {}, locale), inviteHtml(cfg.version, locale, insecure), locale);
    }

    // ---- браузерный оператор (spec: истории 14–19) ----
    m = p.match(/^\/(web|client\/lib|client\/renderer|client\/locales)\/([^/]+)$/);
    if (m && req.method === 'GET' && !req.url.startsWith('/api')) {
      const group = OPERATOR_ASSETS[m[1]];
      let name;
      try { name = decodeURIComponent(m[2]); } catch { name = ''; }
      const type = group?.files[name];
      if (!type) return err(res, 404, 'not_found', 'Файл не найден');
      let data;
      try { data = fs.readFileSync(new URL(group.dir + name, import.meta.url)); }
      catch { return err(res, 404, 'not_found', 'Файл не найден'); }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(data);
    }
    if (p === '/operator' && req.method === 'GET' && !req.url.startsWith('/api')) {
      const locale = pickLocale(req.headers['accept-language']);
      // Навигация браузера не шлёт Authorization: роль берём из cookie, которую
      // ставит сама страница после login; каждый /api и WS всё равно за RBAC.
      const cookie = /(?:^|;\s*)enot_op=([^;]+)/.exec(req.headers.cookie ?? '');
      const opUser = user ?? (cookie
        ? authUser({ headers: { authorization: `Bearer ${decodeURIComponent(cookie[1])}` }, socket: { remoteAddress: '' } })
        : null);
      const status = opUser && ['admin', 'operator'].includes(opUser.role) ? 200
        : opUser?.role === 'auditor' ? 403 : 401;
      return operatorPage(res, status, locale, t('web.title', {}, locale), cfg.version);
    }

    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  function distFiles() {
    // Только разрешённые имена файлов из каталога сборок — никакие другие файлы проекта не отдаются
    const allow = [/^EnotDesk.*\.exe$/, /^EnotDesk.*\.zip$/, /^EnotDesk.*\.AppImage$/];
    const dir = cfg.distDir;
    let names;
    try { names = fs.readdirSync(dir); } catch { names = []; }
    return names
      .filter((n) => allow.some((re) => re.test(n)))
      .map((n) => {
        const platform = n.endsWith('.exe') ? 'win32' : n.endsWith('.AppImage') ? 'linux' : 'darwin';
        const arch = /arm64/i.test(n) ? 'arm64' : 'x64';
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = fs.statSync(path.join(dir, n));
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch { /* исчез файл между readdir и stat */ }
        // слабый ETag — файлы большие, считаем по метаданным, не по содержимому
        const etag = crypto.createHash('sha256').update(`${n}:${size}:${Math.floor(mtimeMs)}`).digest('hex').slice(0, 16);
        return { platform, arch, name: n, url: `/api/v1/downloads-files/${encodeURIComponent(n)}`, size, mtimeMs, etag };
      });
  }

  // ---- WS /signal ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/signal') { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin) {
      let same;
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
    let userId = null; // id оператора после успешной аутентификации
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
        participantLost(session.id, rt, 'host');
      } else if (role === 'operator' && rt.opWs === ws) {
        rt.opWs = null;
        participantLost(session.id, rt, 'operator');
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
        const existingRt = live.get(s.id);
        const inGrace = existingRt?.hostLostAt != null && Date.now() - existingRt.hostLostAt <= cfg.graceMs;
        if (s.lease_expires_at <= now && !inGrace) return ws.close(4003, 'invalid-session');
        role = 'host';
      } else if (msg.role === 'operator') {
        const u = authUser({ headers: { authorization: `Bearer ${msg.token}` }, socket: { remoteAddress: '' } });
        if (!u || !['admin', 'operator'].includes(u.role)) return ws.close(4003, 'invalid-session');
        if (msg.claimId !== s.claim_id || s.operator_id !== u.id) return ws.close(4003, 'invalid-session');
        if (!['pending-consent', 'approved'].includes(s.state)) return ws.close(4003, 'invalid-session');
        role = 'operator';
        userId = u.id;
      } else {
        return ws.close(4002, 'auth-first');
      }
      // один сокет на участника
      let rt = live.get(s.id);
      if (rt && (msg.role === 'host' ? rt.hostWs : rt.opWs)) {
        return ws.close(4004, 'duplicate-socket');
      }
      if (!rt && live.size >= cfg.maxSessions) {
        // переподключения своих не блокируем — только новые сеансы при перегрузке
        return ws.close(4005, 'server-busy');
      }
      if (!rt) {
        rt = { hostWs: null, opWs: null, operatorUserId: null, sigCount: 0, sigReset: 0, hostLostAt: null, opLostAt: null, lastBeat: 0, termActive: false };
        live.set(s.id, rt);
      }
      let resumed;
      if (msg.role === 'host') {
        resumed = rt.hostLostAt != null; // переподключение в грейсе
        rt.hostLostAt = null;
        rt.hostWs = ws;
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() + cfg.leaseMs).toISOString(), s.id);
      } else {
        resumed = rt.opLostAt != null;
        rt.opLostAt = null;
        rt.opWs = ws;
        rt.operatorUserId = userId;
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
      if (role === 'host' && fresh.state === 'approved') {
        // replay после переподключения: ворота ввода открывает только реальный approved
        send(ws, { type: 'approved', claimId: s.claim_id });
      }
      if (role === 'operator' && fresh.state === 'approved') {
        send(ws, { type: 'approved', claimId: s.claim_id });
      }
      if (resumed) {
        send(rt.hostWs, { type: 'resumed' });
        send(rt.opWs, { type: 'resumed' });
      }
    });

    function handleMessage(ws, raw) {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return send(ws, { type: 'error', code: 'bad_message', message: 'Некорректное сообщение' }); }
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
      if (!s || s.state === 'ended') return;
      if (msg.type === 'heartbeat') {
        if (role !== 'host') return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        const rtBeat = live.get(s.id);
        const nowMs = Date.now();
        // Аудит терминала (R09): переходы termActive пишутся как term.open/term.close
        // один раз на смену состояния, не на каждый heartbeat. Актёр — машина
        // (unattended) или null при человеке-хосте, как в machine.claim.
        if (rtBeat && (msg.termActive === true || msg.termActive === false) && rtBeat.termActive !== msg.termActive) {
          rtBeat.termActive = msg.termActive;
          auditLog(db, s.machine_id ?? null, msg.termActive ? 'term.open' : 'term.close', s.id, {
            host: !s.machine_id, unattended: !!s.machine_id, ...(s.machine_id ? { machineId: s.machine_id } : {}),
          });
        }
        // частый стук не нагружает БД: lease пишем не чаще половины интервала
        if (rtBeat && rtBeat.lastBeat && nowMs - rtBeat.lastBeat < cfg.heartbeatMs / 2) {
          return send(ws, { type: 'heartbeat' });
        }
        if (rtBeat) rtBeat.lastBeat = nowMs;
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(nowMs + cfg.leaseMs).toISOString(), s.id);
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
      clearInterval(housekeeper);
      for (const rt of live.values()) {
        for (const ws of [rt.hostWs, rt.opWs]) if (ws) ws.terminate();
      }
      live.clear();
      for (const client of wss.clients) client.terminate();
      server.close(() => { db.close(); resolve(); });
    }),
  };
}

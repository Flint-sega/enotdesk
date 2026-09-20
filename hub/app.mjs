import http from 'node:http';
import fs from 'node:fs';
import { openHubDb } from './db.mjs';
import { createAuth } from './auth.mjs';
import { createThreadsStore, sanitizeText, sanitizeEmail, sanitizeTags, sanitizeShortcut } from './threads.mjs';
import { RateLimiter } from '../server/app.mjs';
import { t, pickLocale } from '../client/lib/i18n.mjs';
import { consoleHtml, stubHtml } from './pages.mjs';

const COOKIE = 'enot_hub_sid';
const HEALTH_CACHE_MS = 5000; // кэш пинга апстрима
const HEALTH_TIMEOUT_MS = 2000; // таймаут пинга апстрима
const BODY_MAX = 4096;
// тексты тикетов до 8000 символов — кириллица в JSON раздувается вдвое
const THREADS_BODY_MAX = 20480;
const STATUSES = ['open', 'pending', 'resolved'];
const CHANNELS = ['chat', 'email', 'manual'];

// Копия server/app.mjs (readJson/err/ok): там модуль-приватные и не экспортируются,
// а server/ намеренно не трогаем. Логика совпадает 1:1 — при изменении сервера
// синхронизировать вручную.
function err(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function ok(res, status, body) {
  // no-store: API-ответы (сессии) не должны оседать в кешах
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, res, maxBytes) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.pause();
        req.removeAllListeners('data');
        res.on('finish', () => req.destroy());
        finish(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(undefined); }
    });
    req.on('error', () => finish(null));
  });
}

function cookieSid(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? m[1] : '';
}

function sessionCookie(sid, secure) {
  return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function clearedCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// ---- Доверенные прокси (ENOT_TRUSTED_PROXY): зеркало server/app.mjs ----
// Пусто — никому не доверяем, ip() всегда адрес сокета: X-Forwarded-For
// подделывает любой клиент, без этого лимит логина обходится спуфом.
// IPv6 поддержан точными адресами; IPv6-CIDR честно не поддержан.

function parseTrustedProxyList(value) {
  return String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// '::ffff:1.2.3.4' (двойной стек) → '1.2.3.4'
function ipv4Of(addr) {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  return m ? m[1] : null;
}

function v4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function addrTrusted(addr, entry) {
  const slash = entry.indexOf('/');
  if (slash === -1) return (ipv4Of(addr) ?? addr).toLowerCase() === (ipv4Of(entry) ?? entry);
  const base = ipv4Of(entry.slice(0, slash));
  if (!base) return false; // IPv6-CIDR не поддержан (см. выше)
  const addrV4 = ipv4Of(addr);
  const len = parseInt(entry.slice(slash + 1), 10);
  const ai = addrV4 ? v4ToInt(addrV4) : null;
  const bi = v4ToInt(base);
  if (ai == null || bi == null || !Number.isInteger(len) || len < 0 || len > 32) return false;
  if (len === 0) return true;
  const mask = (0xFFFFFFFF << (32 - len)) >>> 0;
  return (ai & mask) === (bi & mask);
}

// Статика консоли: только разрешённые файлы — traversal исключён.
// lib/i18n.mjs и locales отдаются под /hub/, чтобы относительный импорт
// '../locales/…' внутри i18n.mjs резолвился в тот же префикс за Caddy.
const HUB_ASSETS = {
  'app.mjs': { file: './web/app.mjs', type: 'text/javascript' },
  'lib/i18n.mjs': { file: '../client/lib/i18n.mjs', type: 'text/javascript' },
  'locales/ru.mjs': { file: '../client/locales/ru.mjs', type: 'text/javascript' },
  'locales/en.mjs': { file: '../client/locales/en.mjs', type: 'text/javascript' },
};

export function createHub(opts = {}) {
  const cfg = {
    dbPath: opts.dbPath ?? ':memory:',
    host: opts.host ?? '127.0.0.1',
    port: opts.port ?? 8090,
    enotdeskUrl: opts.enotdeskUrl ?? 'http://127.0.0.1:8080',
    publicUrl: opts.publicUrl ?? '',
    secretKey: opts.secretKey ?? '',
    version: opts.version ?? '',
    trustedProxy: opts.trustedProxy ?? '',
    enotFetch: opts.enotFetch, // инъекция для тестов; undefined — реальный fetch
    now: opts.now ?? Date.now,
  };
  // ip() берёт X-Forwarded-For только от доверенных адресов сокета
  const trustedProxyList = parseTrustedProxyList(cfg.trustedProxy);
  function ip(req) {
    const socketAddr = req.socket.remoteAddress || '';
    for (const entry of trustedProxyList) {
      if (addrTrusted(socketAddr, entry)) {
        const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
        if (fwd) return fwd;
        break;
      }
    }
    return socketAddr;
  }
  const secureCookie = cfg.publicUrl.startsWith('https:');

  const db = openHubDb(cfg.dbPath);
  const auth = createAuth({
    db,
    enotdeskUrl: cfg.enotdeskUrl,
    secretKey: cfg.secretKey,
    enotFetch: cfg.enotFetch,
    now: cfg.now,
  });
  const threads = createThreadsStore(db, { nowMs: cfg.now });
  const limits = { login: new RateLimiter(opts.loginLimit ?? 10, 60_000, { now: cfg.now }) };

  // Гейт консольного API (R02): hub-сессия + роль из EnotDesk; auditor — 403.
  async function hubUser(req, res) {
    const r = await auth.authUser(cookieSid(req));
    if (!r.ok) {
      err(res, r.status, r.code, r.status === 502 ? 'EnotDesk недоступен' : 'Требуется авторизация');
      return null;
    }
    if (r.user.role !== 'operator' && r.user.role !== 'admin') {
      err(res, 403, 'forbidden', 'Консоль недоступна для этой роли');
      return null;
    }
    return r.user;
  }

  // пагинация: REST только парсит query — кламп (1..100, ≥0) живёт в store
  function listParams(url) {
    const q = url.searchParams;
    return {
      limit: q.has('limit') ? parseInt(q.get('limit'), 10) : undefined,
      offset: q.has('offset') ? parseInt(q.get('offset'), 10) : undefined,
    };
  }

  // REST тредов (T02). Маршруты под /api/hub/*, все за RBAC operator/admin.
  async function handleThreadsApi(req, res, url) {
    const p = url.pathname;
    const m = p.match(/^\/api\/hub\/threads(?:\/([A-Za-z0-9-]{1,64})(?:\/(messages|rating))?)?$/);
    // совпал префикс, но не маршрут — обязаны ответить, иначе запрос висит
    if (!m) return err(res, 404, 'not_found', 'Маршрут не найден');
    const [, id, sub] = m;
    const method = req.method;

    if (!id && method === 'GET') {
      const user = await hubUser(req, res);
      if (!user) return true;
      const q = url.searchParams;
      const filters = {};
      const status = q.get('status');
      if (status) {
        if (!STATUSES.includes(status)) return err(res, 400, 'bad_request', 'Неизвестный статус');
        filters.status = status;
      }
      const channel = q.get('channel');
      if (channel) {
        if (!CHANNELS.includes(channel)) return err(res, 400, 'bad_request', 'Неизвестный канал');
        filters.channel = channel;
      }
      const tag = q.get('tag');
      if (tag) filters.tag = sanitizeText(tag, 30);
      const assignee = q.get('assignee');
      if (assignee === 'none') filters.assigneeId = null;
      else if (assignee) filters.assigneeId = String(assignee).slice(0, 120);
      const query = q.get('q');
      if (query) filters.q = String(query).slice(0, 120);
      Object.assign(filters, listParams(url));
      return ok(res, 200, threads.listThreads(filters));
    }

    if (!id && method === 'POST') {
      // Ручной тикет (R09): оператор или админ заводит обращение за клиента.
      const user = await hubUser(req, res);
      if (!user) return true;
      const body = await readJson(req, res, THREADS_BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
      const subject = sanitizeText(body.subject, 200);
      const text = sanitizeText(body.text, 8000);
      if (!subject || !text) return err(res, 400, 'bad_request', 'Нужны тема и текст обращения');
      let contact = null;
      if (body.contact && typeof body.contact === 'object') {
        contact = {};
        if (body.contact.email !== undefined) {
          const email = sanitizeEmail(body.contact.email);
          if (!email) return err(res, 400, 'bad_request', 'Некорректный email контакта');
          contact.email = email;
        }
        if (body.contact.name !== undefined) {
          const name = sanitizeText(body.contact.name, 120);
          if (!name) return err(res, 400, 'bad_request', 'Некорректное имя контакта');
          contact.name = name;
        }
      }
      const thread = threads.createThread({
        channel: 'manual',
        subject,
        contact,
        firstMessage: { author: 'contact', body: text },
      });
      if (!thread) return err(res, 400, 'bad_request', 'Не удалось создать тикет');
      return ok(res, 201, { thread });
    }

    if (id && !sub && method === 'GET') {
      const user = await hubUser(req, res);
      if (!user) return true;
      const found = threads.getThread(id);
      if (!found) return err(res, 404, 'not_found', 'Тред не найден');
      return ok(res, 200, found);
    }

    if (id && !sub && method === 'PATCH') {
      const user = await hubUser(req, res);
      if (!user) return true;
      const body = await readJson(req, res, THREADS_BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
      const patch = {};
      if (body.status !== undefined) patch.status = body.status;
      if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId;
      if (body.tags !== undefined) {
        const tags = sanitizeTags(body.tags);
        if (tags === null) return err(res, 400, 'bad_request', 'Некорректные теги');
        patch.tags = tags;
      }
      const updated = threads.updateThread(id, patch);
      if (updated === null) return err(res, 404, 'not_found', 'Тред не найден');
      if (updated === 'invalid') return err(res, 400, 'bad_request', 'Некорректные поля треда');
      return ok(res, 200, { thread: updated });
    }

    if (id && sub === 'messages' && method === 'POST') {
      const user = await hubUser(req, res);
      if (!user) return true;
      if (!threads.getThread(id)) return err(res, 404, 'not_found', 'Тред не найден');
      const body = await readJson(req, res, THREADS_BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
      const message = threads.appendMessage(id, {
        author: 'agent',
        type: body.type === 'card' ? 'card' : (body.note === true ? 'note' : 'text'),
        body: body.text,
        agentId: user.id,
      });
      if (!message) return err(res, 400, 'bad_request', 'Некорректный текст сообщения');
      return ok(res, 201, { message });
    }

    if (id && sub === 'rating' && method === 'POST') {
      const user = await hubUser(req, res);
      if (!user) return true;
      const body = await readJson(req, res, 512);
      if (!body || typeof body !== 'object') return err(res, 400, 'bad_request', 'Некорректный запрос');
      const rating = body.rating;
      if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
        return err(res, 400, 'bad_request', 'Оценка — целое 1..5 или null');
      }
      const updated = threads.setRating(id, rating);
      if (updated === null) return err(res, 404, 'not_found', 'Тред не найден');
      return ok(res, 200, { thread: updated });
    }

    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  async function handleCannedApi(req, res, url) {
    const m = url.pathname.match(/^\/api\/hub\/canned(?:\/([A-Za-z0-9-]{1,64}))?$/);
    if (!m) return err(res, 404, 'not_found', 'Маршрут не найден');
    const [, id] = m;
    const user = await hubUser(req, res);
    if (!user) return true;
    if (req.method === 'GET') return ok(res, 200, { items: threads.listCanned(user.id) });
    if (req.method === 'POST' && !id) {
      const body = await readJson(req, res, THREADS_BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
      const shortcut = sanitizeShortcut(body.shortcut);
      if (!shortcut) return err(res, 400, 'bad_request', 'Шорткат — латиница/цифры/-/_ (без #)');
      const created = threads.createCanned({
        scope: body.shared === true ? 'shared' : 'private',
        shortcut,
        text: body.text,
        agentId: user.id,
      });
      if (created === 'invalid') return err(res, 400, 'bad_request', 'Некорректный текст ответа');
      if (created === 'duplicate') return err(res, 409, 'duplicate', 'Такой шорткат уже есть в этом скоупе');
      return ok(res, 201, { item: created });
    }
    if (req.method === 'DELETE' && id) {
      return threads.deleteCanned(id, user.id) ? ok(res, 200, { ok: true }) : err(res, 404, 'not_found', 'Ответ не найден');
    }
    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  async function handlePresenceApi(req, res, url) {
    if (url.pathname !== '/api/hub/presence') return err(res, 404, 'not_found', 'Маршрут не найден');
    const user = await hubUser(req, res);
    if (!user) return true;
    if (req.method === 'GET') return ok(res, 200, { items: threads.listPresence() });
    if (req.method === 'PUT') {
      const body = await readJson(req, res, 512);
      if (!body || typeof body !== 'object') return err(res, 400, 'bad_request', 'Некорректный запрос');
      if (!threads.setPresence(user.id, body.status)) return err(res, 400, 'bad_request', 'Статус — online | away | offline');
      return ok(res, 200, { presence: threads.getPresence(user.id) });
    }
    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  // health: honest зависимость от EnotDesk (R01.1) — кэш 5 с, таймаут 2 с
  let healthCache = { at: Number.NEGATIVE_INFINITY, up: false };
  async function enotdeskUp() {
    const nowMs = cfg.now();
    if (nowMs - healthCache.at < HEALTH_CACHE_MS) return healthCache.up;
    let up;
    try {
      const doFetch = cfg.enotFetch ?? ((url, o = {}) => fetch(url, { ...o, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }));
      const res = await doFetch(`${String(cfg.enotdeskUrl).replace(/\/+$/, '')}/api/v1/health`);
      up = res.ok;
    } catch { up = false; }
    healthCache = { at: nowMs, up };
    return up;
  }

  function sendConsole(res, status, locale, state) {
    // CSP консоли — как у браузерного оператора: никакого inline-кода,
    // свои ES-модули и same-origin fetch
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
    });
    res.end(consoleHtml(state, locale, cfg.version));
  }

  function stubPage(res, locale, titleKey, bodyKey) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(stubHtml(t(titleKey, {}, locale), t(bodyKey, {}, locale), locale));
  }

  async function handle(req, res) {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    // локаль — локальная переменная запроса: общая мутабельная была бы гонкой
    const locale = pickLocale(req.headers['accept-language']);

    // ---- API хаба ----
    if (p === '/api/hub/health' && req.method === 'GET') {
      return ok(res, 200, { ok: true, enotdesk: await enotdeskUp() });
    }

    if (p === '/api/hub/auth/login' && req.method === 'POST') {
      if (!limits.login.take(ip(req))) return err(res, 429, 'rate_limited', 'Слишком много попыток входа');
      const body = await readJson(req, res, BODY_MAX);
      const { login, password, totp } = body ?? {};
      if (typeof login !== 'string' || typeof password !== 'string' || login.length > 120 || password.length > 256) {
        return err(res, 400, 'bad_request', 'Некорректный запрос');
      }
      if (totp !== undefined && typeof totp !== 'string') return err(res, 400, 'bad_request', 'Некорректный запрос');
      const r = await auth.login(login.trim(), password, typeof totp === 'string' && totp.trim() ? totp.trim() : undefined);
      if (!r.ok) return err(res, r.status, r.code, r.message);
      res.setHeader('Set-Cookie', sessionCookie(r.sid, secureCookie));
      return ok(res, 200, { user: r.user, expiresAt: r.expiresAt });
    }

    if (p === '/api/hub/auth/logout' && req.method === 'POST') {
      const sid = cookieSid(req);
      const r = await auth.logout(sid);
      res.setHeader('Set-Cookie', clearedCookie(secureCookie));
      if (!r.ok) return err(res, r.status, r.code, 'Требуется авторизация');
      return ok(res, 200, { ok: true });
    }

    if (p === '/api/hub/auth/me' && req.method === 'GET') {
      const r = await auth.authUser(cookieSid(req));
      if (!r.ok) return err(res, r.status, r.code, r.status === 502 ? 'EnotDesk недоступен' : 'Требуется авторизация');
      return ok(res, 200, { user: r.user });
    }

    // ---- тикеты/сообщения/canned/presence (T02) — все за RBAC ----
    if (p.startsWith('/api/hub/threads')) return handleThreadsApi(req, res, u);
    if (p.startsWith('/api/hub/canned')) return handleCannedApi(req, res, u);
    if (p.startsWith('/api/hub/presence')) return handlePresenceApi(req, res, u);

    // ---- статика консоли ----
    let m = p.match(/^\/hub\/([a-z0-9/._-]+)$/);
    if (m && req.method === 'GET') {
      const asset = HUB_ASSETS[m[1]];
      if (!asset) return err(res, 404, 'not_found', 'Файл не найден');
      let data;
      try { data = fs.readFileSync(new URL(asset.file, import.meta.url)); }
      catch { return err(res, 404, 'not_found', 'Файл не найден'); }
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(data);
    }

    if ((p === '/hub' || p === '/hub/') && req.method === 'GET') {
      const r = await auth.authUser(cookieSid(req));
      if (r.ok && r.user.role === 'auditor') return sendConsole(res, 403, locale, 'forbidden');
      if (r.ok) return sendConsole(res, 200, locale, 'console');
      return sendConsole(res, 401, locale, 'login');
    }

    // ---- заглушки до T03/T04 ----
    if (p === '/widget.js' && req.method === 'GET') {
      res.writeHead(501, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('// EnotDesk Hub widget loader: ещё не реализован (тикет T03).\n');
    }
    if (p === '/w' && req.method === 'GET') return stubPage(res, locale, 'hub.w.title', 'hub.w.body');
    if (p === '/join' && req.method === 'GET') return stubPage(res, locale, 'hub.join.title', 'hub.join.body');

    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) err(res, 500, 'internal', 'Внутренняя ошибка');
      else res.destroy();
    });
  });
  server.on('close', () => {
    try { db.close(); } catch { /* уже закрыта */ }
  });

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { server.removeListener('error', reject); resolve(); });
    });
    return server.address().port; // порт 0 → реальный эфемерный
  }

  // graceful close: HTTP-сервер, затем БД (обработчик 'close' закрывает её)
  async function close() {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, db, auth, start, close };
}

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { openHubDb } from './db.mjs';
import { createAuth } from './auth.mjs';
import { createThreadsStore, sanitizeText, sanitizeEmail, sanitizeTags, sanitizeShortcut } from './threads.mjs';
import { createSettingsStore } from './settings.mjs';
import { createEmailChannel } from './email.mjs';
import { createJoinStore, createJoinReporter, SESSION_ID_RE, SYSTEM_LOCALE } from './join.mjs';
import { secretKeyBytes, decryptSecret } from '../server/totp.mjs';
import { RateLimiter } from '../server/app.mjs';
import { t, pickLocale } from '../client/lib/i18n.mjs';
import { consoleHtml, stubHtml, widgetHtml, joinHtml } from './pages.mjs';

const COOKIE = 'enot_hub_sid';
const VISITOR_COOKIE = 'enot_wv';
// visitor_id виджета: только сильные токены 'v-' + base64url(24 байт) —
// предсказуемый/украденный-подбором id открыл бы чужую историю (T03 dosапрос).
// Выдаётся сервером (/w, fallback WS-hello, offline), гостем лишь пересылается.
export const VISITOR_RE = /^v-[A-Za-z0-9_-]{32,128}$/;

function newVisitorId() {
  return `v-${crypto.randomBytes(24).toString('base64url')}`;
}
const HEALTH_CACHE_MS = 5000; // кэш пинга апстрима
const HEALTH_TIMEOUT_MS = 2000; // таймаут пинга апстрима
const BODY_MAX = 4096;
// тексты тикетов до 8000 символов — кириллица в JSON раздувается вдвое
const THREADS_BODY_MAX = 20480;
const STATUSES = ['open', 'pending', 'resolved'];
const CHANNELS = ['chat', 'email', 'manual'];
// виджет: история при подключении и backpressure
const WIDGET_HISTORY_MAX = 50;
const WS_QUEUE_MAX = 100; // сообщений в очереди на сокет
const WS_BUFFERED_MAX = 256 * 1024;
const CLAIM_TIMEOUT_MS = 5000; // авто-claim в EnotDesk
const HOOK_BODY_MAX = 16 * 1024; // тело webhook-события

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

// Зеркало readJson из server/app.mjs (T01-ремонт): там модуль-приватные и не
// экспортируются, а server/ намеренно не трогаем — третья копия паттерна слита
// в один сырой читатель (readRaw), readJson — parse поверх него. Логика
// совпадает 1:1 — при изменении сервера синхронизировать вручную.
// readRaw: строка | null (тело больше maxBytes — 413, соединение рвётся после
// ответа; подпись webhook-ов проверяется по этим точным байтам).
function readRaw(req, res, maxBytes) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        // 413 + Connection: close (зеркалит server/app.mjs, синхронизировать
        // вручную). НЕ destroy сразу: на Windows RST от сокета с непрочитанным
        // телом приходит раньше, чем клиент дочитает 413. Паттерн: discard
        // (resume без data-слушателя), после ответа — FIN (socket.end),
        // страховка от slow-body — destroy через 10 c.
        req.removeAllListeners('data');
        req.resume();
        res.setHeader('Connection', 'close');
        const kill = setTimeout(() => req.destroy(), 10000);
        kill.unref();
        let closed = false;
        const closeAfterResponse = () => {
          if (closed) return;
          closed = true;
          clearTimeout(kill);
          const s = req.socket;
          if (s && !s.destroyed) s.end();
        };
        res.on('finish', closeAfterResponse);
        res.on('close', closeAfterResponse);
        finish(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

// JSON-тело: parsed | undefined (не-JSON → 400 у вызывателя) | null (413)
async function readJson(req, res, maxBytes) {
  const raw = await readRaw(req, res, maxBytes);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function cookieSid(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? m[1] : '';
}

function visitorCookieId(req) {
  const m = new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m && VISITOR_RE.test(m[1]) ? m[1] : '';
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
  'card-url.mjs': { file: './web/card-url.mjs', type: 'text/javascript' },
  'widget/w.mjs': { file: './widget/w.mjs', type: 'text/javascript' },
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
    widgetHelloMs: opts.widgetHelloMs ?? 10_000, // таймаут hello гостя
    wsPingMs: opts.wsPingMs ?? 30_000, // период ping/чистки мёртвых сокетов
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

  // Cookie visitor_id: Path=/ — иначе (Path=/w) она не матчится с /ws/widget
  // (RFC 6265, граница сегмента) и реальный браузер не пошлёт её на WS. Ид —
  // случайный не-секрет (HttpOnly, шлётся только на свой хаб), попадание на
  // прочие пути хаба безвредно. iframe сторонний: SameSite=None+Secure на
  // https, иначе Lax; HttpOnly: JS страницы ид не нужен (WS шлёт cookie сам).
  function visitorSetCookie(id) {
    const base = `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly`;
    return secureCookie ? `${base}; SameSite=None; Secure` : `${base}; SameSite=Lax`;
  }

  const db = openHubDb(cfg.dbPath);
  const auth = createAuth({
    db,
    enotdeskUrl: cfg.enotdeskUrl,
    secretKey: cfg.secretKey,
    enotFetch: cfg.enotFetch,
    now: cfg.now,
  });
  const threads = createThreadsStore(db, { nowMs: cfg.now });
  const settings = createSettingsStore(db, { nowMs: cfg.now, secretKey: cfg.secretKey });
  settings.ensureWebhookSecret(); // секрет приёма /hooks/enotdesk — с первого старта

  // Email-канал (T06): IMAP-поллер → тикеты, SMTP-ответы. Креды — из настроек
  // (AES-256-GCM), сетевые клиенты — инъекцией (в проде imapflow/nodemailer
  // подгружаются лениво внутри email.mjs, тесты кладут фейки).
  const emailChannel = createEmailChannel({
    db,
    store: threads,
    config: () => settings.getEmail(),
    now: cfg.now,
    intervalMs: opts.emailIntervalMs ?? 60_000,
    ImapClient: opts.emailImapClient,
    transporter: opts.emailTransporter,
    log: (m) => console.error(`[hub:email] ${m}`),
    onMessage: (threadId, message) => {
      broadcastConsole({ type: 'new-message', thread: threads.getThread(threadId)?.thread ?? null, message });
      pushToThreadGuests(threadId, { type: 'msg', threadId, message });
    },
  });
  const limits = {
    login: new RateLimiter(opts.loginLimit ?? 10, 60_000, { now: cfg.now }),
    // WS-upgrade до всякой аутентификации: аноним не держит сокеты (как у логина)
    wsUpgrade: opts.wsUpgradeLimit ?? new RateLimiter(30, 10_000, { now: cfg.now }),
    join: new RateLimiter(opts.joinLimit ?? 10, 60_000, { now: cfg.now }),
    joinReport: new RateLimiter(opts.joinReportLimit ?? 30, 60_000, { now: cfg.now }),
    hooks: new RateLimiter(opts.hooksLimit ?? 60, 60_000, { now: cfg.now }),
  };

  // ---- one-click «Подключиться» (T05) ----

  // Публичный origin для join-ссылок: адрес хаба, а без него — адрес EnotDesk
  // (за Caddy это один домен: /api/hub/* → хаб, /api/v1/* и /downloads → сервер).
  function publicOrigin() {
    try { return new URL(cfg.publicUrl).origin; } catch { /* публичный адрес не задан */ }
    return String(cfg.enotdeskUrl).replace(/\/+$/, '');
  }

  function joinUrls(token) {
    const base = publicOrigin();
    return {
      url: `enotdesk://join?server=${encodeURIComponent(base)}&t=${encodeURIComponent(token)}`,
      joinPage: `${base}/join?t=${encodeURIComponent(token)}`,
    };
  }

  // Bearer агента для авто-claim: hub-сессии агента живы в hub_sessions, bearer
  // хранится там же в шифротексте (см. hub/auth.mjs storeBearer/loadBearer —
  // логика повторена, сам auth bearer наружу не отдаёт).
  function bearerForAgent(agentId) {
    if (typeof agentId !== 'string' || !agentId) return null;
    const row = db.prepare(`
      SELECT bearer FROM hub_sessions
      WHERE json_extract(user_json, '$.id') = ? AND expires_at > ?
      ORDER BY created_at DESC, sid_hash DESC LIMIT 1
    `).get(agentId, new Date(cfg.now()).toISOString());
    if (!row) return null;
    if (!cfg.secretKey) return row.bearer;
    try { return decryptSecret(secretKeyBytes(cfg.secretKey), row.bearer); } catch { return null; }
  }

  const joinStore = createJoinStore(db, { nowMs: cfg.now });
  const joinReport = createJoinReporter({
    join: joinStore,
    threads,
    bearerForAgent,
    enotdeskUrl: cfg.enotdeskUrl,
    doFetch: cfg.enotFetch ?? ((url, o = {}) => fetch(url, { ...o, signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS) })),
    nowMs: cfg.now,
    claimTimeoutMs: CLAIM_TIMEOUT_MS,
    onSystem: (threadId, message) => {
      broadcastConsole({ type: 'new-message', thread: threads.getThread(threadId)?.thread ?? null, message });
      pushToThreadGuests(threadId, { type: 'msg', threadId, message });
    },
  });

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
    const m = p.match(/^\/api\/hub\/threads(?:\/([A-Za-z0-9-]{1,64})(?:\/(messages|rating|join))?)?$/);
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
      // resolve доходит до гостя — виджет показывает rating (R11)
      if (patch.status === 'resolved') pushToThreadGuests(id, { type: 'resolved', threadId: id });
      return ok(res, 200, { thread: updated });
    }

    if (id && sub === 'messages' && method === 'POST') {
      const user = await hubUser(req, res);
      if (!user) return true;
      const found = threads.getThread(id);
      if (!found) return err(res, 404, 'not_found', 'Тред не найден');
      const body = await readJson(req, res, THREADS_BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
      const message = threads.appendMessage(id, {
        author: 'agent',
        type: body.type === 'card' ? 'card' : (body.note === true ? 'note' : 'text'),
        body: body.text,
        agentId: user.id,
      });
      if (!message) return err(res, 400, 'bad_request', 'Некорректный текст сообщения');
      // ответ оператора доходит гостю в реальном времени (заметки — не доходят)
      if (message.type === 'text') pushToThreadGuests(id, { type: 'msg', threadId: id, message });
      // Email-канал (T06): текстовый ответ агента уходит клиенту почтой;
      // note/card остаются внутри хаба. Доставка не блокирует ответ REST,
      // её сбой честно ложится в тред system-сообщением (см. sendReply).
      if (message.type === 'text' && found.thread.channel === 'email' && settings.getEmail()) {
        void emailChannel.sendReply(found.thread, user, message.body).catch((e) => {
          // сбой автоответа не должен проходить молча: ответ клиенту не ушёл
          console.error(`[hub:email] автоответ не удался: ${String(e?.message ?? e).slice(0, 200)}`);
        });
      }
      return ok(res, 201, { message });
    }

    if (id && sub === 'join' && method === 'POST') {
      // Карточка «Подключиться» (R07): одноразовый join-токен на тред + карточка
      // гостю (WS, если онлайн) и в тред; email/manual-тредам ссылку в письмо
      // не шлём (v1) — карточка доступна в консоли.
      const user = await hubUser(req, res);
      if (!user) return true;
      if (!limits.join.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
      const created = joinStore.create({ threadId: id, agentId: user.id });
      if (!created) return err(res, 404, 'not_found', 'Тред не найден');
      const urls = joinUrls(created.token);
      const message = threads.appendMessage(id, {
        author: 'agent',
        type: 'card',
        agentId: user.id,
        body: JSON.stringify({ kind: 'remote-offer', url: urls.url, joinPage: urls.joinPage, state: 'pending' }),
      });
      if (message) {
        pushToThreadGuests(id, { type: 'msg', threadId: id, message });
        broadcastConsole({ type: 'agent-message', threadId: id, message });
      }
      return ok(res, 201, { token: created.token, url: urls.url, joinPage: urls.joinPage, expiresAt: created.expiresAt, message });
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

  // ---- виджет: WS-гости (/ws/widget) и агенты консоли (/ws/console) ----

  const wssWidget = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const wssConsole = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const guestMeta = new Map(); // ws → {visitorId, consented, profile, helloed, limiter, typing}
  const guestsByVisitor = new Map(); // visitorId → Set<ws>
  const consoleMeta = new Map(); // ws → {user, limiter}
  const socketsByAgent = new Map(); // agentId → Set<ws>
  let dbClosed = false; // close-обработчики сокетов переживают закрытие БД

  // Backpressure простой: очередь ≤WS_QUEUE_MAX сообщений или переполненный
  // буфер — сокет честно закрывается, гость переподключится с экспонентой.
  function wsSend(ws, obj) {
    const meta = guestMeta.get(ws) ?? consoleMeta.get(ws);
    if (!meta) return;
    meta.pending = (meta.pending ?? 0) + 1;
    if (meta.pending > WS_QUEUE_MAX || ws.bufferedAmount > WS_BUFFERED_MAX) {
      ws.close(1013, 'slow-consumer');
      return;
    }
    ws.send(JSON.stringify(obj), () => { meta.pending = Math.max(0, (meta.pending ?? 1) - 1); });
  }

  function widgetPresence() {
    const items = threads.listPresence();
    if (items.some((p) => p.status === 'online')) return { status: 'online', agentsOnline: items.filter((p) => p.status === 'online').length };
    if (items.some((p) => p.status === 'away')) return { status: 'away', agentsOnline: 0 };
    return { status: 'offline', agentsOnline: 0 };
  }

  function broadcastPresence() {
    if (dbClosed) return; // close-обработчики сокетов переживают закрытие БД
    const payload = { type: 'presence', items: threads.listPresence(), widget: widgetPresence() };
    for (const ws of consoleMeta.keys()) wsSend(ws, payload);
  }

  function pushToVisitor(visitorId, obj) {
    const set = guestsByVisitor.get(visitorId);
    if (set) for (const ws of set) wsSend(ws, obj);
  }

  function pushToThreadGuests(threadId, obj) {
    const t = threads.getThread(threadId);
    if (t?.thread?.contact?.visitorId) pushToVisitor(t.thread.contact.visitorId, obj);
  }

  function broadcastConsole(obj) {
    for (const ws of consoleMeta.keys()) wsSend(ws, obj);
  }

  const nowIso = () => new Date(cfg.now()).toISOString();

  // Контакт гостя: находится/дополняется по visitor_id; согласие — факт GDPR.
  function ensureGuestContact({ visitorId, name, email, consented }) {
    // ensureContact отдаёт сырую строку (visitor_id/email/name) — нормализуем
    // в наружный вид, чтобы швы тредов читали contact.visitorId честно.
    const row = threads.ensureContact({
      visitorId,
      email: email || null,
      name: name || null,
    });
    if (!row) return null;
    if (consented) threads.setConsentAt(row.id, nowIso());
    return { id: row.id, visitorId: row.visitor_id ?? visitorId, email: row.email ?? null, name: row.name ?? null };
  }

  // Тред чата: открытый переиспользуется, resolved открывает новый (rating-цикл).
  function ensureGuestThread(contact, firstText) {
    const latest = threads.latestContactThread(contact.id, 'chat');
    if (latest && latest.status !== 'resolved') return latest;
    const subject = firstText.slice(0, 120) || 'Чат с сайта';
    return threads.createThread({
      channel: 'chat',
      subject,
      contact: { visitorId: contact.visitorId, email: contact.email, name: contact.name },
      firstMessage: { author: 'contact', body: firstText },
    });
  }

  // Общая доля WS и HTTP append: гейт согласия, санитизация, тред, уведомление консоли.
  function guestAppend({ visitorId, profile: p, consented, text }) {
    if (settings.getWidget().consentRequired && !consented) return { error: 'consent_required' };
    const name = p?.name === undefined || p?.name === '' ? '' : sanitizeText(p.name, 120);
    const email = p?.email === undefined || p?.email === '' ? '' : sanitizeEmail(p.email);
    if ((p?.name !== undefined && p?.name !== '' && !name) || (p?.email !== undefined && p?.email !== '' && !email)) {
      return { error: 'bad_profile' };
    }
    const body = sanitizeText(text, 8000);
    if (!body) return { error: 'bad_message' };
    const contact = ensureGuestContact({ visitorId, name, email, consented });
    const existing = threads.latestContactThread(contact.id, 'chat');
    let thread;
    let message;
    if (existing && existing.status !== 'resolved') {
      thread = existing;
      message = threads.appendMessage(existing.id, { author: 'contact', body });
      if (!message) return { error: 'bad_message' };
    } else {
      thread = ensureGuestThread(contact, body);
      if (!thread) return { error: 'bad_message' };
      message = threads.listMessages(thread.id).at(-1);
    }
    broadcastConsole({ type: 'new-message', thread, message });
    // эхо гостю (и его другим вкладкам): без него своё сообщение видно только
    // после перезагрузки страницы — по реплею истории
    pushToThreadGuests(thread.id, { type: 'msg', threadId: thread.id, message });
    return { thread, message };
  }

  function guestReadyPayload(visitorId) {
    const contact = threads.getContactByVisitor(visitorId);
    const latest = contact ? threads.latestContactThread(contact.id, 'chat') : null;
    const messages = latest ? threads.listMessages(latest.id).slice(-WIDGET_HISTORY_MAX) : [];
    const cfgWidget = settings.getWidget();
    return {
      type: 'ready',
      visitorId,
      settings: { consentRequired: cfgWidget.consentRequired, policyUrl: cfgWidget.policyUrl },
      presence: widgetPresence(),
      thread: latest,
      messages,
    };
  }

  function onGuestSocket(ws, req) {
    ws.on('error', () => {});
    ws.on('pong', () => { ws.isAlive = true; });
    const meta = {
      visitorId: null, helloed: false, consented: false, profile: {},
      limiter: new RateLimiter(20, 10_000, { now: cfg.now }),
      typing: new RateLimiter(60, 10_000, { now: cfg.now }),
    };
    guestMeta.set(ws, meta);
    const helloTimer = setTimeout(() => { try { ws.close(4001, 'hello-timeout'); } catch { /* уже закрыт */ } }, cfg.widgetHelloMs);
    helloTimer.unref();
    ws.on('close', () => {
      clearTimeout(helloTimer);
      guestMeta.delete(ws);
      const set = meta.visitorId ? guestsByVisitor.get(meta.visitorId) : null;
      if (set) { set.delete(ws); if (!set.size) guestsByVisitor.delete(meta.visitorId); }
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return ws.close(4002, 'bad-message'); }
      if (!msg || typeof msg !== 'object') return ws.close(4002, 'bad-message');
      if (!meta.helloed || msg.type === 'hello') {
        if (msg.type !== 'hello') return ws.close(4002, 'hello-first');
        // cookie сильнее: localStorage-токен — fallback, когда куки блокированы
        let visitorId = visitorCookieId(req) || '';
        if (!visitorId && typeof msg.visitorId === 'string' && VISITOR_RE.test(msg.visitorId)) visitorId = msg.visitorId;
        if (!visitorId) visitorId = newVisitorId();
        meta.visitorId = visitorId;
        meta.helloed = true;
        clearTimeout(helloTimer);
        if (msg.consent === true) meta.consented = true;
        const name = msg.name === undefined ? '' : sanitizeText(msg.name, 120);
        const email = msg.email === undefined || msg.email === '' ? '' : sanitizeEmail(msg.email);
        if (msg.name !== undefined && msg.name !== '' && !name) return ws.close(4003, 'bad-hello');
        if (msg.email !== undefined && msg.email !== '' && !email) return ws.close(4003, 'bad-hello');
        meta.profile = { name, email };
        let set = guestsByVisitor.get(visitorId);
        if (!set) { set = new Set(); guestsByVisitor.set(visitorId, set); }
        set.add(ws);
        // согласие пришло позже контакта — фиксируем на контакте, если он уже есть
        if (meta.consented) {
          const contact = threads.getContactByVisitor(visitorId);
          if (contact) threads.setConsentAt(contact.id, nowIso());
        }
        return wsSend(ws, guestReadyPayload(visitorId));
      }
      if (msg.type === 'consent') {
        if (msg.accepted !== true) return ws.close(4002, 'bad-message');
        meta.consented = true;
        const contact = threads.getContactByVisitor(meta.visitorId);
        if (contact) threads.setConsentAt(contact.id, nowIso());
        return wsSend(ws, { type: 'ok' });
      }
      if (msg.type === 'msg') {
        if (!meta.limiter.take(ip(req))) return ws.close(1008, 'flood');
        const r = guestAppend({
          visitorId: meta.visitorId,
          profile: meta.profile,
          consented: meta.consented,
          text: typeof msg.text === 'string' ? msg.text : '',
        });
        if (r.error === 'consent_required') return wsSend(ws, { type: 'error', code: 'consent_required' });
        if (r.error) return wsSend(ws, { type: 'error', code: 'bad_message' });
        return wsSend(ws, { type: 'sent', threadId: r.thread.id, message: r.message });
      }
      if (msg.type === 'typing') {
        if (!meta.typing.take(ip(req))) return; // индикатор не критичен — молча глотаем
        const contact = threads.getContactByVisitor(meta.visitorId);
        const thread = contact ? threads.latestContactThread(contact.id, 'chat') : null;
        if (thread) broadcastConsole({ type: 'typing', threadId: thread.id });
        return;
      }
      return ws.close(4002, 'bad-message');
    });
  }

  function onConsoleSocket(ws, user, req) {
    ws.on('error', () => {});
    ws.on('pong', () => { ws.isAlive = true; });
    consoleMeta.set(ws, { user, limiter: new RateLimiter(20, 10_000, { now: cfg.now }) });
    let set = socketsByAgent.get(user.id);
    if (!set) { set = new Set(); socketsByAgent.set(user.id, set); }
    set.add(ws);
    threads.setPresence(user.id, 'online'); // агент за консолью — честный онлай
    wsSend(ws, { type: 'ready', me: { id: user.id, login: user.login, name: user.name, role: user.role }, presence: threads.listPresence() });
    broadcastPresence();
    ws.on('close', () => {
      consoleMeta.delete(ws);
      set.delete(ws);
      if (!set.size) {
        socketsByAgent.delete(user.id);
        if (!dbClosed) {
          // последний сокет агента закрылся — честный offline в presence
          try { threads.setPresence(user.id, 'offline'); } catch { /* БД уже закрыта */ }
        }
      }
      broadcastPresence();
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return ws.close(4002, 'bad-message'); }
      if (!msg || typeof msg !== 'object') return ws.close(4002, 'bad-message');
      if (msg.type === 'reply') {
        if (!consoleMeta.get(ws).limiter.take(ip(req))) return ws.close(1008, 'flood');
        const threadId = typeof msg.threadId === 'string' ? msg.threadId.slice(0, 64) : '';
        const body = sanitizeText(msg.text, 8000);
        if (!threadId || !body || !threads.getThread(threadId)) return wsSend(ws, { type: 'error', code: 'bad_message' });
        const message = threads.appendMessage(threadId, { author: 'agent', body, agentId: user.id });
        if (!message) return wsSend(ws, { type: 'error', code: 'bad_message' });
        pushToThreadGuests(threadId, { type: 'msg', threadId, message });
        broadcastConsole({ type: 'agent-message', threadId, message });
        return wsSend(ws, { type: 'ok' });
      }
      if (msg.type === 'typing') {
        const threadId = typeof msg.threadId === 'string' ? msg.threadId.slice(0, 64) : '';
        if (threadId && threads.getThread(threadId)) pushToThreadGuests(threadId, { type: 'agent-typing' });
        return;
      }
      return ws.close(4002, 'bad-message');
    });
  }

  function denyUpgrade(socket, status, text) {
    if (socket.destroyed) return;
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  // Origin гостя-WS: свой хаб или allowlist настроек; консоль — только свой origin.
  function upgradeOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // не браузер — аутентификация всё равно на сообщениях/cookie
    let host;
    try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
    if (host === String(req.headers.host ?? '').toLowerCase()) return true;
    return settings.getWidget().origins.includes(host);
  }

  function attachUpgrade() {
    server.on('upgrade', (req, socket, head) => {
      let path;
      try { path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; } catch { socket.destroy(); return; }
      if (path !== '/ws/widget' && path !== '/ws/console') { socket.destroy(); return; }
      if (!limits.wsUpgrade.take(ip(req))) return denyUpgrade(socket, 429, 'Too Many Requests');
      if (!upgradeOriginAllowed(req)) return denyUpgrade(socket, 403, 'Forbidden');
      if (path === '/ws/widget') {
        wssWidget.handleUpgrade(req, socket, head, (ws) => onGuestSocket(ws, req));
        return;
      }
      // /ws/console: hub-сессия по cookie до апгрейда (async authUser)
      auth.authUser(cookieSid(req)).then((r) => {
        if (!r.ok || (r.user.role !== 'operator' && r.user.role !== 'admin')) {
          return denyUpgrade(socket, 401, 'Unauthorized');
        }
        wssConsole.handleUpgrade(req, socket, head, (ws) => onConsoleSocket(ws, r.user, req));
      }).catch(() => socket.destroy());
    });
  }

  // CORS гостевых HTTP-эндпоинтов: Origin-эхо только из allowlist (или свой
  // origin); same-origin браузер помечает Sec-Fetch-Site — ему CORS не нужен.
  function widgetCors(req, res) {
    const sec = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
    if (sec === 'same-origin') return true;
    const origin = req.headers.origin;
    if (!origin) return false; // 403 без заголовка — честно, тишина не разрешение
    let host;
    try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
    const same = String(req.headers.host ?? '').toLowerCase() === host;
    if (!same && !settings.getWidget().origins.includes(host)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return true;
  }

  function visitorIdOf(body) {
    const id = typeof body?.visitorId === 'string' ? body.visitorId : '';
    return VISITOR_RE.test(id) ? id : null;
  }

  async function handleWidgetApi(req, res, url) {
    if (!widgetCors(req, res)) return err(res, 403, 'cors_denied', 'Origin не разрешён для виджета');
    const p = url.pathname;
    const method = req.method;

    if (p === '/api/hub/widget/settings' && method === 'GET') {
      const s = settings.getWidget();
      return ok(res, 200, { settings: { consentRequired: s.consentRequired, policyUrl: s.policyUrl } });
    }

    if (p === '/api/hub/widget/presence' && method === 'GET') {
      return ok(res, 200, { presence: widgetPresence() });
    }

    let body = null;
    if (method === 'POST') {
      body = await readJson(req, res, THREADS_BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
    }

    if (p === '/api/hub/widget/create' && method === 'POST') {
      const visitorId = visitorIdOf(body);
      if (!visitorId) return err(res, 400, 'bad_request', 'Некорректный visitorId');
      const name = body.name === undefined || body.name === '' ? '' : sanitizeText(body.name, 120);
      const email = body.email === undefined || body.email === '' ? '' : sanitizeEmail(body.email);
      if (body.name !== undefined && body.name !== '' && !name) return err(res, 400, 'bad_request', 'Некорректное имя');
      if (body.email !== undefined && body.email !== '' && !email) return err(res, 400, 'bad_request', 'Некорректный email');
      ensureGuestContact({ visitorId, name, email, consented: body.consent === true });
      return ok(res, 201, { ok: true, visitorId });
    }

    if (p === '/api/hub/widget/append' && method === 'POST') {
      const visitorId = visitorIdOf(body);
      if (!visitorId) return err(res, 400, 'bad_request', 'Некорректный visitorId');
      const r = guestAppend({
        visitorId,
        profile: { name: body.name, email: body.email },
        consented: body.consent === true,
        text: body.text,
      });
      if (r.error === 'consent_required') return err(res, 403, 'consent_required', 'Нужно согласие на обработку данных');
      if (r.error) return err(res, 400, 'bad_request', 'Некорректное сообщение');
      return ok(res, 201, { thread: r.thread, message: r.message });
    }

    if (p === '/api/hub/widget/list' && method === 'GET') {
      const visitorId = visitorIdOf({ visitorId: url.searchParams.get('visitorId') ?? '' });
      if (!visitorId) return err(res, 400, 'bad_request', 'Некорректный visitorId');
      const contact = threads.getContactByVisitor(visitorId);
      const items = contact ? threads.listContactThreads(contact.id, 20) : [];
      let thread = null;
      let messages = [];
      const wantId = (url.searchParams.get('threadId') ?? '').slice(0, 64);
      const detail = wantId && items.find((th) => th.id === wantId);
      if (detail) {
        thread = detail;
        messages = threads.listMessages(detail.id).slice(-WIDGET_HISTORY_MAX);
      }
      return ok(res, 200, { threads: items, thread, messages });
    }

    if (p === '/api/hub/widget/rating' && method === 'POST') {
      const visitorId = visitorIdOf(body);
      const threadId = typeof body.threadId === 'string' ? body.threadId.slice(0, 64) : '';
      const rating = body.rating;
      if (!visitorId || !threadId) return err(res, 400, 'bad_request', 'Некорректный запрос');
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return err(res, 400, 'bad_request', 'Оценка — целое 1..5');
      const found = threads.getThread(threadId);
      if (!found) return err(res, 404, 'not_found', 'Тред не найден');
      if (found.thread.contact?.visitorId !== visitorId) return err(res, 403, 'forbidden', 'Тред не ваш');
      if (found.thread.status !== 'resolved') return err(res, 409, 'not_resolved', 'Оценить можно завершённый чат');
      const updated = threads.setRating(threadId, rating);
      if (!updated) return err(res, 404, 'not_found', 'Тред не найден');
      return ok(res, 200, { thread: updated });
    }

    if (p === '/api/hub/widget/offline' && method === 'POST') {
      const email = sanitizeEmail(body.email);
      const subject = sanitizeText(body.subject, 200);
      const text = sanitizeText(body.text, 8000);
      if (!email) return err(res, 400, 'bad_request', 'Нужен корректный email');
      if (!subject) return err(res, 400, 'bad_request', 'Нужна тема обращения');
      if (!text) return err(res, 400, 'bad_request', 'Нужно сообщение');
      const name = body.name === undefined || body.name === '' ? '' : sanitizeText(body.name, 120);
      if (body.name !== undefined && body.name !== '' && !name) return err(res, 400, 'bad_request', 'Некорректное имя');
      let visitorId = visitorIdOf(body);
      if (!visitorId) visitorId = newVisitorId();
      ensureGuestContact({ visitorId, name, email, consented: false });
      const thread = threads.createThread({
        channel: 'email',
        subject,
        contact: { visitorId, email, name },
        firstMessage: { author: 'contact', body: text },
      });
      if (!thread) return err(res, 400, 'bad_request', 'Не удалось создать обращение');
      broadcastConsole({ type: 'new-message', thread, message: threads.listMessages(thread.id).at(-1) });
      return ok(res, 201, { thread, visitorId });
    }

    return err(res, 404, 'not_found', 'Маршрут не найден');
  }

  // ---- one-click: репорт клиента и webhook-приём (T05) ----

  async function handleJoinReport(req, res, token) {
    // Клиент Electron шлёт fetch без Origin (не браузер) — CORS не нужен;
    // браузерный Origin проверяем как у гостевых эндпоинтов виджета.
    if (req.headers.origin && !widgetCors(req, res)) return err(res, 403, 'cors_denied', 'Origin не разрешён');
    if (!limits.joinReport.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
    const body = await readJson(req, res, 512);
    if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
    const r = await joinReport(token, { sessionId: body.sessionId, password: body.password });
    if (r.status !== 200) {
      const messages = {
        bad_request: 'Некорректные данные сеанса',
        not_found: 'Токен подключения не найден',
        gone: 'Токен уже использован или истёк',
      };
      return err(res, r.status, r.code, messages[r.code] ?? 'Ошибка репорта');
    }
    return ok(res, 200, {
      ok: r.ok,
      claimed: r.claimed,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    });
  }

  async function handleHooks(req, res) {
    if (!limits.hooks.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
    const secret = settings.getWebhookSecret();
    if (!secret) return err(res, 503, 'not_configured', 'Приём webhooks не настроен');
    const raw = await readRaw(req, res, HOOK_BODY_MAX);
    if (raw === null) return err(res, 413, 'too_large', 'Тело события слишком большое');
    const sig = String(req.headers['x-enot-signature'] ?? '');
    const expect = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expect, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return err(res, 401, 'bad_signature', 'Неверная подпись');
    }
    let body;
    try { body = JSON.parse(raw); } catch { return err(res, 400, 'bad_request', 'Некорректный JSON'); }
    const event = body?.event;
    const sessionId = body?.payload?.sessionId;
    // allowlist событий; неизвестный sessionId — тихо игнор (честный 200)
    if ((event === 'session.started' || event === 'session.ended')
        && typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) {
      const threadId = joinStore.threadIdForSession(sessionId);
      if (threadId) {
        const reason = event === 'session.ended' && typeof body.payload.reason === 'string' && body.payload.reason
          ? body.payload.reason : '';
        // SYSTEM_LOCALE: system-сообщения треда детерминированы (см. hub/join.mjs),
        // а не языком запроса — иначе один тред получает строки на разных языках
        const text = event === 'session.started'
          ? t('hub.join.systemStarted', { id: sessionId }, SYSTEM_LOCALE)
          : (reason ? t('hub.join.systemEndedReason', { id: sessionId, reason }, SYSTEM_LOCALE)
                    : t('hub.join.systemEnded', { id: sessionId }, SYSTEM_LOCALE));
        const message = threads.appendMessage(threadId, { author: 'system', body: text });
        if (message) {
          broadcastConsole({ type: 'new-message', thread: threads.getThread(threadId)?.thread ?? null, message });
          pushToThreadGuests(threadId, { type: 'msg', threadId, message });
        }
      }
    }
    return ok(res, 200, { ok: true });
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

    // ---- one-click (T05): репорт клиента, webhook-приём, секрет в настройках ----
    let jm = p.match(/^\/api\/hub\/join\/([A-Za-z0-9_-]{16,128})\/report$/);
    if (jm) {
      if (req.method === 'OPTIONS') {
        if (!widgetCors(req, res)) return err(res, 403, 'cors_denied', 'Origin не разрешён для виджета');
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== 'POST') return err(res, 404, 'not_found', 'Маршрут не найден');
      return handleJoinReport(req, res, jm[1]);
    }
    if (p === '/hooks/enotdesk' && req.method === 'POST') return handleHooks(req, res);
    if (p === '/api/hub/settings/webhook' && req.method === 'GET') {
      const user = await hubUser(req, res);
      if (!user) return true;
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Настройки webhooks — только для администратора');
      // rotated=true — прежний секрет не расшифрован (сменили ENOT_SECRET_KEY),
      // сгенерирован новый: админ должен обновить его в настройках webhooks EnotDesk
      const { secret, rotated } = settings.ensureWebhookSecret();
      return ok(res, 200, { secret, rotated });
    }

    // ---- настройки виджета (админ) ----
    if (p === '/api/hub/settings/widget' && (req.method === 'GET' || req.method === 'POST')) {
      const user = await hubUser(req, res);
      if (!user) return true;
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Настройки виджета — только для администратора');
      if (req.method === 'GET') return ok(res, 200, { settings: settings.getWidget() });
      const body = await readJson(req, res, BODY_MAX);
      if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
      // частичный патч: копируем только переданные ключи поверх текущих
      const current = settings.getWidget();
      const patch = { ...current };
      if (body.origins !== undefined) patch.origins = body.origins;
      if (body.consentRequired !== undefined) patch.consentRequired = body.consentRequired;
      if (body.policyUrl !== undefined) patch.policyUrl = body.policyUrl;
      const saved = settings.setWidget(patch);
      if (saved === 'invalid') return err(res, 400, 'bad_request', 'Некорректные настройки виджета');
      return ok(res, 200, { settings: saved });
    }

    // ---- настройки email-канала (T06, админ): креды IMAP/SMTP + проверка ----
    if (p === '/api/hub/settings/email' && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
      const user = await hubUser(req, res);
      if (!user) return true;
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Настройки email-канала — только для администратора');
      if (req.method === 'GET') {
        return ok(res, 200, { settings: settings.getEmailSettings(), enabled: Boolean(settings.getEmail()), lastTest: settings.getEmailTest() });
      }
      if (req.method === 'POST') {
        const body = await readJson(req, res, BODY_MAX);
        if (!body || typeof body !== 'object') return err(res, body === null ? 413 : 400, 'bad_request', 'Некорректный запрос');
        const saved = settings.setEmail(body);
        if (saved === 'invalid') return err(res, 400, 'bad_request', 'Некорректные настройки email-канала');
        if (saved === 'secret_key_missing') return err(res, 400, 'secret_key_missing', 'Нужен ENOT_SECRET_KEY: пароли хранятся только в шифротексте');
        emailChannel.start(); // идемпотентен: тик сам видит, включён ли канал
        return ok(res, 200, { settings: settings.getEmailSettings(), enabled: Boolean(settings.getEmail()) });
      }
      // DELETE — выключение канала: креды и последний результат проверки стираются
      settings.clearEmail();
      emailChannel.stop();
      return ok(res, 200, { settings: null, enabled: false });
    }
    if (p === '/api/hub/settings/email/test' && req.method === 'POST') {
      const user = await hubUser(req, res);
      if (!user) return true;
      if (user.role !== 'admin') return err(res, 403, 'forbidden', 'Настройки email-канала — только для администратора');
      if (!settings.getEmail()) return err(res, 400, 'bad_request', 'Email-канал не настроен');
      const result = await emailChannel.testConnection();
      settings.setEmailTest(result);
      return ok(res, 200, { result });
    }

    // ---- гостевые HTTP-эндпоинты виджета (T03): CORS-allowlist, без сессии ----
    if (p.startsWith('/api/hub/widget/')) {
      if (req.method === 'OPTIONS') {
        if (!widgetCors(req, res)) return err(res, 403, 'cors_denied', 'Origin не разрешён для виджета');
        res.writeHead(204);
        return res.end();
      }
      return handleWidgetApi(req, res, u);
    }

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

    // ---- виджет (T03): лоадер и страница iframe ----
    if (p === '/widget.js' && req.method === 'GET') {
      let data;
      try { data = fs.readFileSync(new URL('./widget/loader.js', import.meta.url)); } catch {
        return err(res, 500, 'internal', 'Лоадер виджета недоступен');
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600', // лоадер стабилен — кэш 1ч
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(data);
    }
    if (p === '/w' && req.method === 'GET') {
      let visitor = visitorCookieId(req);
      const fresh = !visitor;
      if (fresh) visitor = newVisitorId();
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        // iframe встраивается на чужих сайтах: встраиваемость — ОТСУТСТВИЕМ
        // frame-ancestors в CSP (умолчание разрешает), X-Frame-Options не ставим
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (fresh) headers['Set-Cookie'] = visitorSetCookie(visitor);
      res.writeHead(200, headers);
      return res.end(widgetHtml(locale));
    }
    if (p === '/join' && req.method === 'GET') {
      // Страница «Подключиться» для гостя (R07): токен обязателен и живой —
      // без него честная 404 (ссылка одноразовая, утекать наружу ей нечем).
      const token = u.searchParams.get('t') ?? '';
      const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (!joinStore.peek(token)) {
        res.writeHead(404, headers);
        return res.end(stubHtml(t('hub.join.missingTitle', {}, locale), t('hub.join.missingBody', {}, locale), locale));
      }
      const base = publicOrigin();
      res.writeHead(200, headers);
      return res.end(joinHtml(locale, {
        protocolUrl: `enotdesk://join?server=${encodeURIComponent(base)}&t=${encodeURIComponent(token)}`,
        downloadUrl: `${base}/downloads`,
      }));
    }

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

  // WS-апгрейд вешается после создания сервера; ping/чистка мёртвых сокетов
  const pingTimer = setInterval(() => {
    for (const ws of [...guestMeta.keys(), ...consoleMeta.keys()]) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, cfg.wsPingMs);
  pingTimer.unref();
  attachUpgrade();

  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => { server.removeListener('error', reject); resolve(); });
    });
    emailChannel.start(); // IMAP-поллер: тики без включённого канала — пустые
    return server.address().port; // порт 0 → реальный эфемерный
  }

  // graceful close: WS-сокеты (и их close-обработчики), затем HTTP-сервер, затем БД
  async function close() {
    clearInterval(pingTimer);
    emailChannel.stop();
    for (const ws of [...guestMeta.keys(), ...consoleMeta.keys()]) {
      try { ws.terminate(); } catch { /* уже мёртв */ }
    }
    wssWidget.close();
    wssConsole.close();
    await new Promise((resolve) => setImmediate(resolve)); // дать доработать close-обработчикам
    dbClosed = true;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, db, auth, start, close };
}

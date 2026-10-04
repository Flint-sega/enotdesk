import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { WebSocketServer } from 'ws';
import { openDb, endLiveSessions, auditLog, runRetention } from './db.mjs';
import { sanitizeFileName } from '../client/lib/file-transfer.mjs';
import { createMachinesStore, sanitizeInventory } from './machines.mjs';
import { createWebhooks } from './webhooks.mjs';
import { page, downloadsHtml, inviteHtml, operatorPage, isInsecurePage } from './pages.mjs';
import { t, pickLocale } from '../client/lib/i18n.mjs';
import {
  hashPassword, verifyPasswordAsync, newToken, sha256,
  sessionPassword, newSessionId, newClaimId,
} from './crypto.mjs';
import {
  generateSecret, verifyCode, matchCounter, backupCodes, normalizeBackupCode,
  secretKeyBytes, encryptSecret, decryptSecret,
} from './totp.mjs';

const ROLES = ['admin', 'operator', 'auditor'];
const SIGNAL_WINDOW_MS = 5000;
const SIGNAL_MAX = 150;

function err(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function ok(res, status, body) {
  // no-store: API-ответы (токены, состояние сеансов) не должны оседать в кешах
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
        // тело больше лимита: отдаём 413, но НЕ рвём сокет сразу — destroy с
        // непрочитанным телом на Windows даёт RST раньше, чем undici дочитает
        // 413 (fetch failed → ECONNRESET). Паттерн: discard-режим (resume без
        // data-слушателя — поток течёт вникула, приёмный буфер пуст), после
        // ответа — FIN (socket.end), страховка от slow-body — destroy через 10 c
        // (DoS-защита). Connection: close остаётся — клиент ждёт конца ответа.
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
    req.on('end', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(undefined); }
    });
    req.on('error', () => finish(null));
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
    // после чистки всё ещё полно живых ключей (флуд в одном окне): вытесняем
    // старейший по reset, иначе карта растёт без предела
    if (this.#hits.size >= this.#maxKeys) {
      let oldest = null;
      for (const [k, h] of this.#hits) if (!oldest || h.reset < oldest.h.reset) oldest = { k, h };
      if (oldest) this.#hits.delete(oldest.k);
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
    files: {
      'operator.mjs': 'text/javascript', 'input-source.mjs': 'text/javascript',
      'team.js': 'text/javascript', 'invite.js': 'text/javascript',
    },
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
    files: { 'ru.mjs': 'text/javascript', 'en.mjs': 'text/javascript' },
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

// ---- Доверенные прокси (ENOT_TRUSTED_PROXY): IP или IPv4-CIDR через запятую ----
// Пусто — никому не доверяем, ip() всегда адрес сокета (заголовок X-Forwarded-For
// подделываем любым клиентом). IPv6 поддержан точными адресами; IPv6-CIDR честно
// не поддержан — за типичным nginx/caddy на той же машине стоят ::1 и 127.0.0.1.

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

// IP-вариант TURN-адреса с кэшем (приёмка 03.10): desktop-клиенты флапают по
// DNS при старте WebRTC (Electron: «Failed to resolve address … -105», STUN
// lookup error) — ICE умирал, пока живы только LAN-кандидаты. Сервер сам
// резолвит hostname и рядом с оригиналом отдаёт turn:<IP>:port; креды одни
// (use-auth-secret не зависит от адреса). Не резолвится — отдаём как есть.
const turnIpCache = new Map(); // host -> { ip, at } | { fail: true, at }
const TURN_IP_TTL_MS = 10 * 60_000;
const TURN_IP_FAIL_TTL_MS = 60_000;
const TURN_LOOKUP_TIMEOUT_MS = 1500;

function lookupIpv4(host) {
  // getaddrinfo (учитывает /etc/hosts — важно для localhost), с потолком времени:
  // подвисший резолв не должен задерживать ответ /rtc-config
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), TURN_LOOKUP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
  return Promise.race([
    dns.promises.lookup(host, { family: 4 }).then((r) => r?.address ?? null).catch(() => null),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

async function turnUrlVariants(url) {
  try {
    const m = /^(turns?):([^:/?]+)(:\d+)?(\?.*)?$/.exec(url);
    if (!m) return [url];
    const host = m[2];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [url]; // уже IP-литерал
    const cached = turnIpCache.get(host);
    let ip = null;
    if (cached) {
      const ttl = cached.fail ? TURN_IP_FAIL_TTL_MS : TURN_IP_TTL_MS;
      if (Date.now() - cached.at < ttl) ip = cached.ip ?? null;
    }
    if (!cached || (ip === null && Date.now() - cached.at >= (cached.fail ? TURN_IP_FAIL_TTL_MS : TURN_IP_TTL_MS))) {
      ip = await lookupIpv4(host);
      turnIpCache.set(host, ip ? { ip, at: Date.now() } : { fail: true, at: Date.now() });
    }
    if (!ip) return [url];
    const variant = `${m[1]}:${ip}${m[3] ?? ''}${m[4] ?? ''}`;
    return variant === url ? [url] : [url, variant];
  } catch {
    return [url];
  }
}

const CONTACT_LIMITS = { name: 120, notes: 2000, tags: 10, tag: 30 };
const MACHINE_LIMITS = { name: 120, group: 60, reason: 500, pin: 128, toast: 500 };

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
    // секрет TURN (coturn use-auth-secret): задан — /rtc-config раздаёт
    // эфемерные HMAC-креды вместо статического пароля
    turnSecret: opts.turnSecret ?? process.env.ENOT_TURN_SECRET ?? '',
    trustedProxy: opts.trustedProxy ?? process.env.ENOT_TRUSTED_PROXY ?? '',
    // ключ шифрования секретов (2FA и др.): значение никогда не попадает в ответы и журнал
    secretKey: opts.secretKey ?? process.env.ENOT_SECRET_KEY ?? '',
    leaseMs: opts.leaseMs ?? 20000,
    heartbeatMs: opts.heartbeatMs ?? 5000,
    // грейс на переподключение участника в состоянии approved; 0 — старое fail-closed
    graceMs: opts.graceMs ?? 30_000,
    // сколько свипер ждёт pong после пробного пинга «тихо мёртвому» хосту.
    // Не env: внутренняя деталь свипера; опция — только для быстрых тестов
    hostPingGraceMs: opts.hostPingGraceMs ?? 5000,
    // шаг свипера; опция — только для быстрых тестов (HOST_PING_MAX за секунды)
    sweeperMs: opts.sweeperMs ?? 1000,
    // toast на экран машины (R08): сколько ждать подтверждения агента и сколько
    // живёт не забранный агентом запрос (агент ходит heartbeat-ом раз в 5с)
    toastWaitMs: opts.toastWaitMs ?? 12_000,
    toastTtlMs: opts.toastTtlMs ?? 60_000,
    // инъекция времени для тестов (паттерн runRetention/RateLimiter):
    // по умолчанию Date.now — поведение продакшена не меняется
    nowMs: opts.nowMs ?? Date.now,
    // сколько дней хранить завершённые сеансы; 0 — хранить вечно
    retentionDays: opts.retentionDays ?? 90,
    // файловый релей (v0.4.0, резервный канал при мёртвом P2P): TTL дней (0 — без
    // истечения) и каталог внутри каталога БД; сервер хранит только файлы релея
    relayTtlDays: opts.relayTtlDays ?? Number(process.env.ENOT_RELAY_TTL_DAYS ?? 3),
    relayDir: opts.relayDir ?? process.env.ENOT_RELAY_DIR ?? null, // null = <db dir>/relay
    relayMax: opts.relayMax ?? 200 * 1024 * 1024,
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
      // файловый релей (v0.4.0): загрузки и скачивания по ссылкам
      relayUpload: opts.limits?.relayUpload ?? new RateLimiter(10, 60_000),
      relayDownload: opts.limits?.relayDownload ?? new RateLimiter(30, 60_000),
      accept: opts.limits?.accept ?? new RateLimiter(10, 60_000),
      // unattended-машины: попытки claim с одного IP и порог неудачных политик
      // на конкретную машину (подбор PIN/причины), регистрация агента по коду
      machineClaim: opts.limits?.machineClaim ?? new RateLimiter(10, 60_000),
      machineClaimId: opts.limits?.machineClaimId ?? new RateLimiter(5, 15 * 60_000),
      agentRegister: opts.limits?.agentRegister ?? new RateLimiter(10, 60_000),
      // toast на экран машины: нечастая операция, лимит на всякий случай
      machineToast: opts.limits?.machineToast ?? new RateLimiter(10, 60_000),
      // Wake-on-LAN (R10): разбудить офлайн-машину через онлайн-соседа — тоже
      // нечастая операция поддержки
      wol: opts.limits?.wol ?? new RateLimiter(10, 60_000),
      // WS-upgrade до всякой аутентификации: аноним не держит сокеты и TLS-рукопожатия
      wsUpgrade: opts.limits?.wsUpgrade ?? new RateLimiter(30, 10_000),
      // включение/выключение 2FA: маршрут проверяет пароль (scrypt) —
      // аутентифицированный держатель токена не должен уметь крутить им event loop
      // (ревью v0.4.6: sync-проверка + отсутствие лимита)
      totp: opts.limits?.totp ?? new RateLimiter(10, 60_000),
    },
  };
  const db = openDb(cfg.dbPath);
  endLiveSessions(db, 'server-restart'); // рестарт инвалидирует живые регистрации
  const machinesStore = createMachinesStore(db);
  const webhooks = createWebhooks(db, { secretKey: cfg.secretKey });
  // байты ключа шифрования секретов; null — ключ не задан (включение 2FA честно отказывает)
  const secretKey = secretKeyBytes(cfg.secretKey);
  // Фиктивный хеш anti-enumeration (P2-5): ленивая генерация при первом
  // входе с несуществующим логином — стоимость равна обычной проверке пароля.
  let dummyHash = null;

  // Коды ошибок настройки webhooks → честные тексты маршрута
  const WEBHOOK_ERR_TEXT = {
    bad_url: 'URL должен быть http(s)-адресом',
    url_too_long: 'URL слишком длинный (до 2048 символов)',
    bad_key: 'Не задан ENOT_SECRET_KEY (например, в .env сервера) — им шифруется секрет webhooks',
    secret_required: 'Укажите секрет подписи',
    secret_too_long: 'Секрет слишком длинный (до 256 символов)',
  };

  const live = new Map(); // sessionId -> {hostWs, opSockets:Map(ws->{userId,claimId}), operatorUserId, sigCount, sigReset, hostLostAt, opLostAt, lastBeat, termActive, hostPingAt, hostPingCount}
  let closed = false;

  // Toast на экран машины (R08): память процесса, не БД — состояние одноразовое.
  // Один ожидающий toast на машину (новый заменяет старый); выдаётся агенту
  // один раз (машинный heartbeat, поле toast), результат приходит toastResult'ом
  // в следующем heartbeat — ожидавшие HTTP-запросы операторов разрешаются им.
  // Каждый оператор ждёт свой id: замена toast не разрешает чужое ожидание.
  const pendingToasts = new Map(); // machineId -> {id, text, at, issued}
  const toastWaiters = new Map(); // machineId -> [{id, done, resolve}]
  // Wake-on-LAN (R10): тот же одноразовый паттерн в памяти, что у toast, но с
  // курьером. Ключ — ЦЕЛЬ (машина, которую будят); выдача уходит ОНЛАЙН-машине-
  // курьеру её heartbeat-ом (поле wake), подтверждение курьера (wakeResult) в
  // следующем heartbeat разрешает ожидавших операторов. Один ожидающий wake на
  // цель (новый заменяет не забранный старый); вместо одного `mac` — массив
  // `macs`: у цели может быть несколько NIC, и сервер не знает, какой из них
  // поддерживает WOL, — курьер честно шлёт magic packet на все MAC инвентаря.
  // `couriers` — машины, выбраные маршрутом по подсети /24; выдать wake может
  // любая из них (первая, кто забрал).
  const pendingWakes = new Map(); // machineId (цель) -> {id, macs, targetMachineId, couriers, queuedAt, issued}
  const wakeWaiters = new Map(); // machineId (цель) -> [{id, done, resolve}]

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

  // ---- файловый релей (v0.4.x): резервный канал, файлы хранятся TTL дней ----
  const relayDir = cfg.relayDir ?? path.join(path.dirname(cfg.dbPath), 'relay');
  fs.mkdirSync(relayDir, { recursive: true });

  function relayTotalBytes() {
    return db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM relay_files').get().total;
  }

  // Загрузка в релей: оператор (Bearer) или хост сеанса (hostToken). Тело — сырые
  // байты стримом в файл (лимит relayMax); в ответе одноразовая ссылка с токеном.
  async function handleRelayUpload(req, res) {
    const token = bearer(req);
    if (!token) return err(res, 401, 'unauthorized', 'Требуется авторизация');
    let actor = null;
    const u = authUser(req);
    if (u && ['admin', 'operator'].includes(u.role)) actor = u.id;
    if (!actor) {
      const hs = db.prepare('SELECT id FROM sessions WHERE host_token_hash = ? AND state != ?')
        .get(sha256(token), 'ended');
      if (!hs) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      actor = `host:${hs.id}`;
    }
    if (!cfg.limits.relayUpload.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много загрузок');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > cfg.relayMax) return err(res, 413, 'too_large', `Файл больше ${Math.round(cfg.relayMax / 1048576)} МБ`);
    if (relayTotalBytes() + declared > cfg.relayMax * 10) {
      return err(res, 507, 'insufficient_storage', 'Хранилище релея переполнено — повторите позже');
    }
    let name;
    try { name = sanitizeFileName(decodeURIComponent(String(req.headers['x-file-name'] ?? 'file'))) || 'file'; }
    catch { name = 'file'; }
    const id = `r-${crypto.randomBytes(12).toString('base64url')}`;
    const dlToken = crypto.randomBytes(24).toString('base64url');
    const filePath = path.join(relayDir, `${id}.bin`);
    const out = fs.createWriteStream(filePath);
    let total = 0;
    let aborted = false;
    let failed = false;
    await new Promise((resolve) => {
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > cfg.relayMax) {
          aborted = true;
          out.destroy();
          req.removeAllListeners('data');
          try { fs.unlinkSync(filePath); } catch { /* ещё не создан */ }
          resolve();
          return;
        }
        out.write(chunk);
      });
      // 201 отдаём только когда данные ДОШЛИ до диска: resolve по 'end' запроса
      // гонял флаш стрима с ответом — мгновенный download ловил 410/частичный
      // файл (флейк relay-теста, найден 30.09); честная точка — 'close' стрима
      req.on('end', () => out.end());
      req.on('error', () => { failed = true; out.destroy(); });
      out.on('close', () => resolve());
    });
    if (aborted || failed || total === 0) {
      try { fs.unlinkSync(filePath); } catch { /* уже удалён */ }
      return err(res, aborted ? 413 : 400, aborted ? 'too_large' : 'bad_request', aborted ? `Файл больше ${Math.round(cfg.relayMax / 1024 / 1024)} МБ` : 'Пустой файл');
    }
    const expiresAt = new Date(cfg.nowMs() + cfg.relayTtlDays * 86_400_000).toISOString();
    db.prepare(`INSERT INTO relay_files (id, name, size, path, token_hash, created_by, created_at, expires_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, name, total, filePath, sha256(dlToken), actor, new Date(cfg.nowMs()).toISOString(), expiresAt);
    return ok(res, 201, { id, name, size: total, token: dlToken, expiresAt, url: `/api/v1/relay/${id}?token=${dlToken}` });
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
      for (const opWs of rt.opSockets.keys()) send(opWs, { type: 'ended', reason });
      for (const ws of [rt.hostWs, ...rt.opSockets.keys()]) if (ws) ws.close(1000, 'ended');
      live.delete(sessionId);
    }
    return true;
  }

  function endOperatorSessions(userId, reason) {
    for (const [sid, rt] of live) {
      const joined = [...(rt.opSockets?.values() ?? [])].some((m) => m.userId === userId);
      if (rt.operatorUserId === userId || joined) endSession(sid, reason);
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
    // №13b (ретест 28–29.09): грейс уже мог быть объявлен свипером при истечении
    // лизинга — тогда close «мёртвого» сокета не сдвигает его (иначе грейс
    // продлевался бы каждым terminate и сеанс жил бы бессрочно)
    if (who === 'host') rt.hostLostAt ??= Date.now();
    else rt.opLostAt ??= Date.now();
    if (who === 'host') {
      for (const opWs of rt.opSockets.keys()) send(opWs, { type: 'peer-reconnecting', role: who });
    } else {
      send(rt.hostWs, { type: 'peer-reconnecting', role: who });
    }
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
    // Сколько циклов пинга переживает «понгующий, но не бьющийся heartbeat'ом»
    // хост. Не env: внутренние детали свипера, к настройке разворачивания
    // отношения не имеют.
    const HOST_PING_MAX = 8;
    for (const row of rows) {
      const rt = live.get(row.id);
      const stateRow = db.prepare('SELECT state FROM sessions WHERE id = ?').get(row.id);
      // «Тихо мёртвый» хост в approved (лизинг истёк, close-события нет — живой
      // сеанс 28.09, W-A9). №13b (ретест 28–29.09): грейс объявляем СРАЗУ при
      // истечении лизинга, а не после terminate — раньше gate 4003 смотрел
      // только на hostLostAt и отбивал ретраи клиента во всём пинг-окне
      // (~10-15 с), хотя сеанс формально жив и клиент по контракту честно
      // завершался («сеанс завершён» у владельца ровно об этом).
      if (rt && stateRow?.state === 'approved' && rt.hostWs != null) {
        if (rt.hostLostAt == null) {
          if ((rt.hostPingCount ?? 0) >= HOST_PING_MAX) {
            endSession(row.id, 'lease-expired');
            continue;
          }
          if (cfg.graceMs > 0) {
            // Объявляем грейс: ретраи принимаются (gate по hostLostAt), операторы
            // предупреждены, хосту — пробный пинг. Ответил pong → сокет жив,
            // terminate не нужен: хост продолжит heartbeat'ы (сбросят hostLostAt
            // с «resumed» операторам) или переподключится. Лимит циклов: сокет,
            // понгующий на уровне стека, но с мёртвой heartbeat-логикой клиента,
            // не держит сеанс вечно — после HOST_PING_MAX честный lease-expired
            // (ревью 28.09: иначе слот live/maxSessions занят бессрочно).
            // В fail-closed (graceMs=0) грейс не объявляем и операторам ничего
            // не шлём — как до волны (ревью v0.4.4); пинг и лимит циклов работают.
            rt.hostLostAt = nowMs;
            for (const opWs of rt.opSockets.keys()) send(opWs, { type: 'peer-reconnecting', role: 'host' });
          }
          rt.hostPingAt = nowMs;
          rt.hostPingCount = (rt.hostPingCount ?? 0) + 1;
          try { rt.hostWs.ping(); } catch { try { rt.hostWs.terminate(); } catch { /* уже мёртв */ } }
          continue;
        }
        // Грейс уже объявлен: pong не пришёл за hostPingGraceMs — сокет «тихо
        // мёртв» (физический обрыв сети не даёт TCP-закрытия), закрываем
        // серверно. close-обработчик запустит participantLost — он НЕ сдвинет
        // объявленный hostLostAt, грейс тикает от истечения лизинга (ADR 0013).
        if (rt.hostPingAt != null && nowMs - rt.hostPingAt > cfg.hostPingGraceMs) {
          try { rt.hostWs.terminate(); } catch { /* уже мёртв */ }
          rt.hostPingAt = null;
        }
        continue; // ждём heartbeat/переподключения; конец — по истечении graceMs
      }
      if (rt && gracePending(rt, nowMs).any) continue; // ждём переподключения
      endSession(row.id, 'lease-expired');
    }
  }, cfg.sweeperMs);
  sweeper.unref();

  // Релей: разовая зачистка просроченных файлов при старте (и далее в housekeeper).
  function sweepRelayFiles() {
    if (cfg.relayTtlDays <= 0) return; // 0 — без истечения
    const cutoff = new Date(cfg.nowMs() - cfg.relayTtlDays * 86_400_000).toISOString();
    const rows = db.prepare('SELECT id, path FROM relay_files WHERE expires_at < ?').all(cutoff);
    for (const row of rows) {
      try { fs.unlinkSync(row.path); } catch { /* уже удалён */ }
      db.prepare('DELETE FROM relay_files WHERE id = ?').run(row.id);
    }
  }
  sweepRelayFiles();

  // Дом-уборщик: истёкшие токены, завершённые приглашения, старые сеансы (раз в час)
  // + просроченные файлы релея (TTL 3 суток по умолчанию, 0 — без истечения).
  const housekeeper = setInterval(() => {
    runRetention(db, { retentionDays: cfg.retentionDays });
    sweepRelayFiles();
  }, 3_600_000);
  housekeeper.unref();

  function authUser(req) {
    const token = bearer(req);
    if (!token) return null;
    const now = new Date().toISOString();
    const row = db.prepare(`
      SELECT u.id, u.login, u.name, u.role, u.active, u.totp_enabled
      FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.expires_at > ? AND u.active = 1
    `).get(sha256(token), now);
    return row
      ? { id: row.id, login: row.login, name: row.name, role: row.role, active: !!row.active, totpEnabled: !!row.totp_enabled }
      : null;
  }

  function hostTokenSession(req) {
    const token = bearer(req);
    if (!token) return null;
    return db.prepare(
      "SELECT * FROM sessions WHERE host_token_hash = ? AND state != 'ended'"
    ).get(sha256(token)) || null;
  }

  // Доверенные прокси парсятся один раз на сервер; пустой список — не доверять никому
  const trustedProxies = parseTrustedProxyList(cfg.trustedProxy);
  const isTrustedProxy = (addr) => trustedProxies.some((entry) => addrTrusted(String(addr), entry));

  function ip(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    if (!trustedProxies.length || !isTrustedProxy(remote)) return remote;
    // сокет держит доверенный прокси: берём из X-Forwarded-For последний
    // незнакомый hop справа налево (доверенные прокси пропускаем)
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(hops[i])) return hops[i];
    }
    return remote;
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
    handle(req, res).catch((e) => {
      console.error('[enot] handle error:', req.method, req.url, e);
      if (!res.headersSent) err(res, 500, 'internal', 'Внутренняя ошибка сервера');
      else res.end();
    });
  });

  async function handle(req, res) {
    let m; // общий скан-маршрутизатор: объявлен до relay-вставок (TDZ)
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
    // Файловый релей (v0.4.x): raw-тело обрабатывается ДО общего readJson —
    // тела >64КБ (лимит JSON) иначе никогда не дошли бы до маршрута.
    if (req.method === 'POST' && p === '/relay') {
      return handleRelayUpload(req, res);
    }
    if (req.method !== 'GET') {
      var body = await readJson(req, res, cfg.bodyLimit);
      if (body === null) return err(res, 413, 'too_large', 'Слишком большой запрос');
    }
    m = p.match(/^\/relay\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      if (!cfg.limits.relayDownload.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много запросов');
      const row = db.prepare('SELECT * FROM relay_files WHERE id = ?').get(m[1]);
      const dlToken = String(url.searchParams.get('token') ?? '');
      if (!row) return err(res, 404, 'not_found', 'Файл не найден или срок хранения истёк');
      const given = Buffer.from(sha256(dlToken));
      const expected = Buffer.from(row.token_hash);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return err(res, 403, 'bad_token', 'Неверная ссылка');
      }
      if (!fs.existsSync(row.path)) return err(res, 410, 'gone', 'Срок хранения файла истёк');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': row.size,
        'content-disposition': `attachment; filename="${row.name.replace(/[^\w.-]/g, '_')}"`,
      });
      const stream = fs.createReadStream(row.path);
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
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
      const locale = pickLocale(req.headers['accept-language']);
      const twoFactor = !!(user && user.active && user.totp_enabled);
      const fail = () => {
        cfg.limits.loginId.take(loginKey);
        auditLog(db, null, 'login.failure', null, { login: String(login).slice(0, 120) });
        return err(res, 401, 'invalid_credentials',
          twoFactor ? t('totp.invalidCredentials', {}, locale) : 'Неверный логин или пароль');
      };
      // Anti-enumeration (P2-5): пароль проверяется ПЕРВЫМ, до totp_required.
      // Неизвестный логин/выключенный аккаунт — dummy-scrypt той же стоимости,
      // чтобы время ответа не отличалось. Контракт totp_required сохранён, но
      // теперь он приходит только после верного пароля (честно: пароль ок,
      // нужен второй фактор). Порядок изменён относительно прежней версии —
      // раньше totp_required отдавался до проверки пароля.
      let pwOk = false;
      if (user && user.active) {
        pwOk = await verifyPasswordAsync(password, user.password);
      } else {
        // фиктивная проверка: одноразово сгенерированный хеш, стоимость та же
        dummyHash ??= hashPassword(`enotdesk-dummy-${crypto.randomUUID()}`);
        await verifyPasswordAsync(password, dummyHash);
      }
      if (!pwOk) return fail();
      // 2FA (R11): без кода — totp_required, но только после верного пароля
      if (twoFactor && (typeof body?.totp !== 'string' || !body.totp.trim())) {
        return err(res, 401, 'totp_required', t('totp.loginRequired', {}, locale));
      }
      if (twoFactor) {
        // код из аутентификатора с replay-защитой (P2-7): шаг 30 с принимается
        // один раз, повтор (counter <= totp_last_counter) — отказ
        const given = body.totp.trim();
        const secret = user.totp_secret_enc ? decryptSecret(secretKey, user.totp_secret_enc) : null;
        let codeOk = false;
        if (secret) {
          const counter = matchCounter(secret, given);
          if (counter != null) {
            if (user.totp_last_counter != null && counter <= user.totp_last_counter) return fail();
            db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, user.id);
            codeOk = true;
          }
        }
        if (!codeOk) {
          // иначе — одноразовый резервный код: потребляется только при верном
          // пароле; хеши — scrypt (P2-6), проверка перебором кодов пользователя
          const normalized = normalizeBackupCode(given);
          if (normalized) {
            const rows = db.prepare(
              'SELECT code_hash FROM totp_backup_codes WHERE user_id = ?'
            ).all(user.id);
            let matchedHash = null;
            let legacy = false;
            for (const { code_hash: h } of rows) {
              if (h.startsWith('s1$')) {
                if (await verifyPasswordAsync(normalized, h)) { matchedHash = h; break; }
              } else if (h === sha256(normalized)) {
                legacy = true; // хеш старого (до scrypt) формата
              }
            }
            if (matchedHash) {
              db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ? AND code_hash = ?')
                .run(user.id, matchedHash);
              codeOk = true;
            } else if (legacy) {
              // честный отказ: старые несолёные коды обесценены; вход по TOTP-коду
              // и перевыпуск (disable → enable) восстанавливают резервные коды
              return err(res, 401, 'backup_codes_legacy_reset',
                'Резервные коды устаревшего формата отклонены: войдите с кодом из приложения и перевыпустите резервные коды (отключите и заново включите 2FA)');
            }
          }
        }
        if (!codeOk) return fail();
      }
      const token = newToken();
      const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
        .run(sha256(token), user.id, expiresAt, new Date().toISOString());
      auditLog(db, user.id, 'login.success', user.id, {});
      return ok(res, 200, {
        token,
        user: { id: user.id, login: user.login, name: user.name, role: user.role, active: !!user.active, totpEnabled: !!user.totp_enabled },
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
      const locale = pickLocale(req.headers['accept-language']);
      const { oldPassword, newPassword } = body || {};
      if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
        return err(res, 400, 'bad_request', 'Проверьте данные: новый пароль — от 8 символов');
      }
      const row = db.prepare('SELECT password FROM users WHERE id = ?').get(user.id);
      if (!row || !(await verifyPasswordAsync(oldPassword, row.password))) {
        return err(res, 403, 'wrong_password', t('err.wrong_password', {}, locale));
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

    // ---- 2FA (D2, R11): включение/выключение TOTP. Секрет хранится только
    // шифротекстом AES-256-GCM от ENOT_SECRET_KEY; без ключа включение честно
    // отказывает. Резервные коды уходят в ответ один раз, в БД — только хеши.
    if (p === '/auth/totp/enable' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const locale = pickLocale(req.headers['accept-language']);
      const password = body?.password;
      if (typeof password !== 'string' || !password) {
        return err(res, 400, 'bad_request', t('totp.passwordRequired', {}, locale));
      }
      // асинхронный scrypt + лимит: sync-проверка (~30 мс) без лимита позволяла
      // держателю любого токена забивать event loop (ревью v0.4.6)
      if (!cfg.limits.totp.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много попыток');
      const row = db.prepare('SELECT password, totp_enabled, totp_secret_enc FROM users WHERE id = ?').get(user.id);
      if (!row || !(await verifyPasswordAsync(password, row.password))) {
        return err(res, 403, 'wrong_password', t('err.wrong_password', {}, locale));
      }
      if (row.totp_enabled) return err(res, 409, 'totp_already', t('err.totp_already', {}, locale));
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      if (code) {
        // подтверждение включения первым успешным кодом из аутентификатора
        const secret = row.totp_secret_enc ? decryptSecret(secretKey, row.totp_secret_enc) : null;
        if (!secret || !verifyCode(secret, code)) {
          return err(res, 400, 'bad_code', t('err.bad_code', {}, locale));
        }
        db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
        auditLog(db, user.id, 'totp.enable', user.id, {});
        return ok(res, 200, { ok: true, enabled: true });
      }
      if (!secretKey) {
        return err(res, 400, 'secret_key_missing', t('err.secret_key_missing', {}, locale));
      }
      const secret = generateSecret();
      db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_counter = NULL WHERE id = ?').run(encryptSecret(secretKey, secret), user.id);
      const codes = backupCodes();
      db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);
      const nowIso = new Date().toISOString();
      for (const c of codes) {
        // хеш нормализованного кода как пароль (scrypt, P2-6): при вводе регистр
        // и разделители не важны; несолёный sha256 больше не используется
        db.prepare('INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?,?,?)')
          .run(user.id, hashPassword(normalizeBackupCode(c)), nowIso);
      }
      auditLog(db, user.id, 'totp.setup', user.id, {});
      const otpauth = `otpauth://totp/EnotDesk%3A${encodeURIComponent(user.login)}?secret=${secret}&issuer=EnotDesk&algorithm=SHA1&digits=6&period=30`;
      return ok(res, 200, { ok: true, enabled: false, secret, otpauth, backupCodes: codes });
    }
    if (p === '/auth/totp/disable' && req.method === 'POST') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const locale = pickLocale(req.headers['accept-language']);
      const password = body?.password;
      if (typeof password !== 'string' || !password) {
        return err(res, 400, 'bad_request', t('totp.passwordRequired', {}, locale));
      }
      if (!cfg.limits.totp.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', 'Слишком много попыток');
      const row = db.prepare('SELECT password, totp_enabled FROM users WHERE id = ?').get(user.id);
      if (!row || !(await verifyPasswordAsync(password, row.password))) {
        return err(res, 403, 'wrong_password', t('err.wrong_password', {}, locale));
      }
      if (!row.totp_enabled) return err(res, 409, 'totp_not_enabled', t('err.totp_not_enabled', {}, locale));
      db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0, totp_last_counter = NULL WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id);
      // второй фактор снят: прочие токены умирают (как при смене пароля), текущий остаётся
      const current = sha256(bearer(req) ?? '');
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash != ?').run(user.id, current);
      endOperatorSessions(user.id, 'totp-disabled');
      auditLog(db, user.id, 'totp.disable', user.id, {});
      return ok(res, 200, { ok: true, enabled: false });
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
    m = p.match(/^\/members\/([^/]+)$/);
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
      // контакты — рабочие данные поддержки: auditor (только журналы) их не читает
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
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
      // Закреплённый ID ПК (просьба владельца, приёмка 02.10): клиент один раз
      // генерирует 9-значный hostId (settings.json) и шлёт его с каждым сеансом;
      // пароль клиент тоже генерирует сам — на запуск приложения (ротация при
      // перезапуске). Без hostId — прежнее поведение (серверные генерации).
      const hostIdRaw = typeof body?.hostId === 'string' ? body.hostId.trim() : '';
      const hostId = /^\d{9}$/.test(hostIdRaw) ? hostIdRaw : null;
      if (hostIdRaw && !hostId) return err(res, 400, 'bad_host_id', 'hostId должен быть 9-значным числом');
      const clientPassword = typeof body?.password === 'string' ? body.password : '';
      if (clientPassword && (clientPassword.length < 8 || clientPassword.length > 128)) {
        return err(res, 400, 'bad_password', 'Пароль должен быть от 8 до 128 символов');
      }
      const password = clientPassword || sessionPassword(8);
      // Живой сеанс этого же ПК (прошлый запуск без корректного завершения):
      // честно завершаем с причиной superseded — закреплённый ID один, сеанс один.
      const stale = db.prepare("SELECT id FROM sessions WHERE host_id = ? AND state != 'ended' ORDER BY created_at DESC").all(hostId ?? '\u0000');
      for (const row of stale) endSession(row.id, 'superseded');
      const id = newSessionId(db);
      const hostToken = newToken();
      const now = new Date().toISOString();
      const lease = new Date(Date.now() + cfg.leaseMs).toISOString();
      db.prepare(`INSERT INTO sessions (id, password_hash, host_token_hash, state, created_at, lease_expires_at, created_ip, host_id)
                  VALUES (?,?,?,'waiting',?,?,?,?)`)
        .run(id, hashPassword(password), sha256(hostToken), now, lease, clientIp, hostId);
      auditLog(db, null, 'session.create', id, hostId ? { hostId } : {});
      return ok(res, 201, { sessionId: id, password, hostToken, expiresAt: lease, ...(hostId ? { hostId } : {}) });
    }
    m = p.match(/^\/sessions\/([^/]+)\/claim$/);
    if (m && req.method === 'POST') {
      // лимиты ПОСЛЕ auth (P1-1): аноним без токена не выжигает ни IP-лимит
      // операторов, ни порог известного sessionId
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      if (!cfg.limits.claim.take(`ip:${ip(req)}`) || !cfg.limits.claimId.take(`id:${m[1]}`)) {
        return err(res, 429, 'rate_limited', 'Слишком много попыток подключения');
      }
      const generic = () => err(res, 400, 'bad_request', 'Не удалось подключиться: проверьте идентификатор и пароль');
      // ID оператора — либо sessionId, либо закреплённый hostId ПК (v8): живой
      // сеанс по host_id, свежий первым (superseded-хвосты не выбираем).
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(m[1])
        ?? db.prepare("SELECT * FROM sessions WHERE host_id = ? AND state != 'ended' ORDER BY created_at DESC LIMIT 1")
          .get(/^\d{9}$/.test(m[1]) ? m[1] : '\u0000');
      if (!s || !(await verifyPasswordAsync(String(body?.password ?? ''), s.password_hash))) return generic();
      const op = { id: user.id, login: user.login, name: user.name };
      // multi-operator (v0.4.0): сеанс уже занят другим оператором → ПРИСОЕДИНЕНИЕ
      // с тем же доступом (ID+пароль = авторизация); новый claimId на оператора
      if (s.state !== 'waiting') {
        if (s.state === 'ended') return generic();
        const claimId = newClaimId();
        db.prepare('INSERT OR REPLACE INTO session_operators (session_id, user_id, claim_id, joined_at) VALUES (?,?,?,?)')
          .run(s.id, user.id, claimId, new Date().toISOString());
        auditLog(db, user.id, 'session.join', s.id, {});
        const rt = live.get(s.id);
        if (rt?.hostWs) send(rt.hostWs, { type: 'operator-joined', claimId, operator: op });
        return ok(res, 201, { sessionId: s.id, claimId, operator: op, state: s.state, joined: true });
      }
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
      if (rt?.hostWs) send(rt.hostWs, { type: 'claim', claimId, operator: { id: user.id, login: user.login, name: user.name } });
      return ok(res, 201, {
        sessionId: s.id, claimId,
        operator: { id: user.id, login: user.login, name: user.name },
        state: 'pending-consent',
      });
    }
    // One-click (ADR 0024): сеанс уже авто-claim'нут хабом от имени оператора —
    // свой claimId оператор получает без пароля (вход в /operator по ID сеанса).
    // claimId бесполезен чужому: WS /signal проверяет и claimId, и operator_id.
    m = p.match(/^\/sessions\/([^/]+)\/connect$/);
    if (m && req.method === 'GET') {
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(m[1]);
      const joinedRow = user
        ? db.prepare('SELECT claim_id FROM session_operators WHERE session_id = ? AND user_id = ?').get(s?.id ?? '', user.id)
        : null;
      const own = s && s.operator_id === user.id;
      if (!s || s.state === 'ended' || (!own && !joinedRow)) {
        return err(res, 404, 'not_found', 'Сеанс не найден или не закреплён за вами');
      }
      // multi-operator: присоединённый получает свой claimId, основной — сеансовый
      return ok(res, 200, {
        sessionId: s.id,
        claimId: own ? s.claim_id : joinedRow.claim_id,
        state: s.state,
        machineId: s.machine_id ?? null,
      });
    }

    // ---- файловый релей (v0.4.0) ----
    // Живые маршруты: POST /relay и GET /relay/:id обработаны ВЫШЕ (стриминговый
    // handleRelayUpload и контролируемое скачивание). Дублирующий буферизующий
    // блок здесь был мёртвым кодом (до него всё перехватывали ранние return) —
    // и делал синхронный mkdirSync на каждый дошедший запрос (ревью 28.09).

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
          if (rt?.opSockets) for (const opWs of rt.opSockets.keys()) send(opWs, { type: 'approved', claimId });
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
      // reason idle — только хосту (таймаут бездействия v0.4.0); остальным 'ended'
      const reason = isHost && body?.reason === 'idle' ? 'idle' : 'ended';
      const changed = endSession(s.id, reason);
      if (changed) auditLog(db, isHost ? null : operator.id, 'session.end', s.id, isHost ? { host: true, reason } : {});
      return ok(res, 200, { ok: true });
    }
    if (p === '/rtc-config' && req.method === 'GET') {
      const s = hostTokenSession(req);
      const u = s ? null : authUser(req);
      if (!s && !u) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      // Аудитор — наблюдатель журналов, в WebRTC-сеансах не участвует; отказ 403
      // консистентен с прочими «поддерживающими» маршрутами (claim, machines),
      // куда auditor тоже не допущен, и не раздаёт ему TURN-креденшелы.
      if (u && u.role === 'auditor') return err(res, 403, 'forbidden', 'Недостаточно прав');
      const iceServers = [];
      if (cfg.turnUrls) {
        // + IP-вариант каждого hostname-адреса (см. turnUrlVariants): клиентский
        // DNS при старте WebRTC флапает — ICE не должен зависеть от резолва
        const urls = (await Promise.all(
          cfg.turnUrls.split(',').map((x) => x.trim()).filter(Boolean).map(turnUrlVariants),
        )).flat();
        if (cfg.turnSecret) {
          // Эфемерный кред coturn REST API (use-auth-secret): username — метка
          // истечения (unix-секунды), credential — base64(HMAC-SHA1(секрет,
          // username)); живой coturn ждёт именно SHA1, SHA256 отвергает.
          // Статический пароль из конфига клиентам больше не раздаётся (P1-2).
          const username = String(Math.floor(Date.now() / 1000) + 3600);
          const credential = crypto.createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
          iceServers.push({ urls, username, credential });
        } else {
          // без ENOT_TURN_SECRET — прежнее статическое поведение
          iceServers.push({ urls, username: cfg.turnUsername, credential: cfg.turnPassword });
        }
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
      // лимиты ПОСЛЕ auth (P1-1): аноним не выжигает IP-лимит операторов и не
      // подбирает PIN известной машины через неавторизованный флуд
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      if (!cfg.limits.machineClaim.take(`ip:${ip(req)}`) || cfg.limits.machineClaimId.exceeded(`id:${m[1]}`)) {
        return err(res, 429, 'rate_limited', t('machines.claimLimited', {}, locale));
      }
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
        if (!(await machinesStore.verifyPinAsync(machine, pin))) {
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
    m = p.match(/^\/machines\/([^/]+)\/toast$/);
    if (m && req.method === 'POST') {
      const locale = pickLocale(req.headers['accept-language']);
      if (!cfg.limits.machineToast.take(`ip:${ip(req)}`)) {
        return err(res, 429, 'rate_limited', t('machines.toastLimited', {}, locale));
      }
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      // операция поддержки, как claim: admin+operator; аудитор — нет
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const machine = machinesStore.get(m[1]);
      if (!machine) return err(res, 404, 'not_found', t('machines.notFound', {}, locale));
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (text.length < 1 || text.length > MACHINE_LIMITS.toast) {
        return err(res, 400, 'bad_request', t('machines.toastLength', {}, locale));
      }
      if (machine.revoked_at) return err(res, 409, 'machine_revoked', t('machines.revoked', {}, locale));
      if (!machine.agent_token_hash) return err(res, 409, 'not_registered', t('machines.notRegistered', {}, locale));
      if (!machinesStore.out(machine).online) return err(res, 409, 'machine_offline', t('machines.machineOffline', {}, locale));
      // один ожидающий toast на машину: новый заменяет не забранный старый
      const id = crypto.randomUUID();
      pendingToasts.set(machine.id, { id, text, at: cfg.nowMs(), issued: false });
      auditLog(db, user.id, 'machine.toast', machine.id, { length: text.length });
      // ожидаем подтверждения агента (придёт машинным heartbeat-ом) ограниченное время;
      // по чужому id не разрешаемся — ждём свой или истечение срока
      const result = await new Promise((resolve) => {
        const list = toastWaiters.get(machine.id) ?? [];
        const waiter = { id, done: false, resolve };
        list.push(waiter);
        toastWaiters.set(machine.id, list);
        setTimeout(() => {
          waiter.done = true;
          const rest = toastWaiters.get(machine.id);
          if (rest) toastWaiters.set(machine.id, rest.filter((w) => !w.done));
          resolve(null);
        }, cfg.toastWaitMs);
      });
      return ok(res, 200, { ok: true, result });
    }
    m = p.match(/^\/machines\/([^/]+)\/wol$/);
    if (m && req.method === 'POST') {
      const locale = pickLocale(req.headers['accept-language']);
      // лимиты ПОСЛЕ auth (как claim, P1-1): аноним не выжигает лимит операторов
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      // операция поддержки, как claim и toast: admin+operator; аудитор — нет
      if (!['admin', 'operator'].includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      if (!cfg.limits.wol.take(`ip:${ip(req)}`)) return err(res, 429, 'rate_limited', t('machines.wolLimited', {}, locale));
      const machine = machinesStore.get(m[1]);
      if (!machine) return err(res, 404, 'not_found', t('machines.notFound', {}, locale));
      if (machine.revoked_at) return err(res, 409, 'machine_revoked', t('machines.revoked', {}, locale));
      if (!machine.agent_token_hash) return err(res, 409, 'not_registered', t('machines.notRegistered', {}, locale));
      // инвертированный онлайн-гейт: WOL нужен именно офлайн-машине; живая
      // машина в пробуждении не нуждается — честный отказ вместо фейка
      if (machinesStore.out(machine).online) return err(res, 409, 'machine_online', t('machines.machineOnline', {}, locale));
      const inventory = machinesStore.out(machine).inventory;
      const macs = Array.isArray(inventory?.macs) ? inventory.macs : [];
      if (!macs.length) return err(res, 409, 'wol_no_mac', t('machines.wolNoMac', {}, locale));

      // Курьеры — ОНЛАЙН машины той же подсети /24 (первые 3 октета любого
      // localIp): magic packet ходит только внутри своего L2, сервер сам в
      // чужую подсеть не шлёт — нет соседей, честный отказ
      const subnets = new Set((Array.isArray(inventory?.localIps) ? inventory.localIps : [])
        .map((ipStr) => String(ipStr).split('.').slice(0, 3).join('.')));
      const couriers = subnets.size
        ? machinesStore.list({ limit: 10_000 }).items.filter((cand) => cand.id !== machine.id
          && cand.online && !cand.revokedAt
          && (Array.isArray(cand.inventory?.localIps) ? cand.inventory.localIps : [])
            .some((ipStr) => subnets.has(String(ipStr).split('.').slice(0, 3).join('.'))))
        : [];
      if (!couriers.length) return err(res, 409, 'wol_no_neighbor', t('machines.wolNoNeighbor', {}, locale));

      // один ожидающий wake на цель: новый заменяет не забранный старый
      const id = crypto.randomUUID();
      pendingWakes.set(machine.id, {
        id, macs, targetMachineId: machine.id,
        couriers: couriers.map((c) => c.id), queuedAt: cfg.nowMs(), issued: false,
      });
      auditLog(db, user.id, 'machine.wol', machine.id, { macs, couriers: couriers.map((c) => c.id) });
      // ожидаем подтверждения курьера (придёт его машинным heartbeat-ом)
      // ограниченное время; по чужому id не разрешаемся
      const result = await new Promise((resolve) => {
        const list = wakeWaiters.get(machine.id) ?? [];
        const waiter = { id, done: false, resolve };
        list.push(waiter);
        wakeWaiters.set(machine.id, list);
        setTimeout(() => {
          waiter.done = true;
          const rest = wakeWaiters.get(machine.id);
          if (rest) wakeWaiters.set(machine.id, rest.filter((w) => !w.done));
          resolve(null);
        }, cfg.toastWaitMs);
      });
      if (result === null) return ok(res, 504, { delivered: false, reason: 'no_confirm' });
      if (result.ok === true) return ok(res, 200, { delivered: true });
      // курьер ответил отказом — доносим его причину честно
      return ok(res, 200, { delivered: false, reason: result.reason || 'courier_failed' });
    }
    m = p.match(/^\/machines\/([^/]+)$/);
    if (m && (req.method === 'GET' || req.method === 'DELETE')) {
      // одна машина: GET — наружный объект с инвентарём (R06), DELETE — удаление.
      // 401/404 общие; права по методу: GET — admin+operator (как список),
      // DELETE — только admin.
      if (!user) return err(res, 401, 'unauthorized', 'Требуется авторизация');
      const locale = pickLocale(req.headers['accept-language']);
      const allowed = req.method === 'GET' ? ['admin', 'operator'] : ['admin'];
      if (!allowed.includes(user.role)) return err(res, 403, 'forbidden', 'Недостаточно прав');
      const machine = machinesStore.get(m[1]);
      if (!machine) return err(res, 404, 'not_found', t('machines.notFound', {}, locale));
      if (req.method === 'GET') return ok(res, 200, machinesStore.out(machine));
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
      // Инвентарь (R06): если поле пришло — валидируем (allowlist, ≤4 КБ);
      // мусор отбрасывается, прошлый инвентарь остаётся.
      const inventory = body && Object.hasOwn(body, 'inventory') ? sanitizeInventory(body.inventory) : undefined;
      machinesStore.touch(machine.id, { inventory });

      // Toast (R08): ответ агента по забранному ранее запросу. Результат
      // принимаем только по актуальному id и в allowlist-форме; мусор молча
      // игнорируется — heartbeat не ломается.
      const pendingToast = pendingToasts.get(machine.id);
      const tr = body && typeof body.toastResult === 'object' && body.toastResult !== null ? body.toastResult : null;
      if (pendingToast && tr && tr.id === pendingToast.id) {
        pendingToasts.delete(machine.id);
        const result = { ok: tr.ok === true };
        if (typeof tr.reason === 'string' && tr.reason) result.reason = tr.reason.slice(0, 60);
        const waiters = toastWaiters.get(machine.id) ?? [];
        toastWaiters.set(machine.id, waiters.filter((w) => {
          if (w.done) return false; // истёкшие ожидания выбрасываются
          if (w.id !== pendingToast.id) return true; // чужой id — оператор ждёт свой результат
          w.done = true;
          w.resolve(result);
          return false;
        }));
      }

      // выдача ожидающего toast этому агенту: один раз и пока не истёк TTL
      let toast = null;
      const queued = pendingToasts.get(machine.id);
      if (queued && !queued.issued) {
        if (cfg.nowMs() - queued.at <= cfg.toastTtlMs) {
          queued.issued = true;
          toast = { id: queued.id, text: queued.text };
        } else {
          pendingToasts.delete(machine.id);
        }
      }

      // Wake-on-LAN (R10): результат курьера по забранному ранее wake — клон
      // toastResult по форме, но с поиском по id: wake ждёт под id ЦЕЛИ, а
      // репортит КУРЬЕР. Только актуальный id и allowlist-форма; мусор молча
      // игнорируется, heartbeat не ломается.
      const wr = body && typeof body.wakeResult === 'object' && body.wakeResult !== null ? body.wakeResult : null;
      if (wr && typeof wr.id === 'string') {
        for (const [targetId, pendingWake] of pendingWakes) {
          if (pendingWake.id !== wr.id) continue;
          pendingWakes.delete(targetId);
          const result = { ok: wr.ok === true };
          if (typeof wr.reason === 'string' && wr.reason) result.reason = wr.reason.slice(0, 60);
          const waiters = wakeWaiters.get(targetId) ?? [];
          wakeWaiters.set(targetId, waiters.filter((w) => {
            if (w.done) return false; // истёкшие ожидания выбрасываются
            if (w.id !== pendingWake.id) return true; // чужой id — оператор ждёт свой результат
            w.done = true;
            w.resolve(result);
            return false;
          }));
          break;
        }
      }

      // выдача ожидающего wake: этот агент может быть курьером офлайн-цели —
      // один wake за heartbeat, только пока не истёк TTL
      let wake = null;
      if (pendingWakes.size > 0) {
        for (const [targetId, queuedWake] of pendingWakes) {
          if (queuedWake.issued) continue;
          if (!Array.isArray(queuedWake.couriers) || !queuedWake.couriers.includes(machine.id)) continue;
          if (cfg.nowMs() - queuedWake.queuedAt > cfg.toastTtlMs) {
            pendingWakes.delete(targetId);
            continue;
          }
          queuedWake.issued = true;
          wake = { id: queuedWake.id, macs: queuedWake.macs, targetMachineId: targetId };
          break;
        }
      }
      return ok(res, 200, { ok: true, ...(toast ? { toast } : {}), ...(wake ? { wake } : {}) });
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
      res.writeHead(200, {
        'Content-Type': BRAND_FILES[name],
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
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
        'X-Content-Type-Options': 'nosniff',
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
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(data);
    }
    if (p === '/operator' && req.method === 'GET' && !req.url.startsWith('/api')) {
      const locale = pickLocale(req.headers['accept-language']);
      // Навигация браузера не шлёт Authorization: cookie выбирает только вариант
      // страницы и хранит РОЛЬ, не токен (SEC-008) — bearer живёт в памяти страницы,
      // а каждый /api и WS всё равно за RBAC.
      const cookie = /(?:^|;\s*)enot_op=([^;]+)/.exec(req.headers.cookie ?? '');
      let cookieRole = null;
      if (cookie) { try { cookieRole = decodeURIComponent(cookie[1]); } catch { cookieRole = cookie[1]; } }
      const opRole = user?.role ?? (['admin', 'operator', 'auditor'].includes(cookieRole) ? cookieRole : null);
      const status = opRole === 'admin' || opRole === 'operator' ? 200
        : opRole === 'auditor' ? 403 : 401;
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
    // лимит до всякой аутентификации: анонимный стук в /signal не держит
    // сокеты и рукопожатия (P2-3)
    if (!cfg.limits.wsUpgrade.take(ip(req))) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
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
    authTimer.unref(); // не держим процесс ради таймера аутентификации

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!authed || !session) return;
      const rt = live.get(session.id);
      if (!rt) return;
      if (role === 'host' && rt.hostWs === ws) {
        rt.hostWs = null;
        participantLost(session.id, rt, 'host');
      } else if (role === 'operator' && rt.opSockets?.has(ws)) {
        const ent = rt.opSockets.get(ws);
        rt.opSockets.delete(ws);
        // Хосту — уход оператора: он снимет персональный pc (мультиоператор)
        if (rt.hostWs) send(rt.hostWs, { type: 'operator-left', claimId: ent?.claimId ?? null });
        if (rt.opSockets.size === 0) {
          // ЧЬЯ утрата: fresh-оператор другого пользователя в грейсе — не
          // «вернувшийся» (ревью 04.10 F2: иначе он лишался реплея offer и
          // получал чужой 'resumed')
          rt.opLostUser = ent?.userId ?? null;
          participantLost(session.id, rt, 'operator');
        }
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
        // №13b (ревью GLM-5.3 v0.4.4): в approved лизинг — не судья входа, ПОКА
        // сеанс жив: и в объявленном грейсе, и в зазоре «лизинг истёк, свипер
        // ещё не объявил» (≥heartbeatMs + тик) ретрай принимается — иначе
        // вернувшийся клиент получал здесь 4003 («сеанса нет») и по контракту
        // сдавался навсегда при живом сеансе. Fail-closed (graceMs=0) и
        // не-approved — как раньше.
        const inGrace = cfg.graceMs > 0 && (
          s.state === 'approved' ||
          (existingRt?.hostLostAt != null && Date.now() - existingRt.hostLostAt <= cfg.graceMs)
        );
        if (s.lease_expires_at <= now && !inGrace) return ws.close(4003, 'invalid-session');
        role = 'host';
      } else if (msg.role === 'operator') {
        const u = authUser({ headers: { authorization: `Bearer ${msg.token}` }, socket: { remoteAddress: '' } });
        if (!u || !['admin', 'operator'].includes(u.role)) return ws.close(4003, 'invalid-session');
        // multi-operator (v0.4.0): основной оператор ИЛИ присоединённый (session_operators)
        const joinedOp = db.prepare(
          'SELECT 1 FROM session_operators WHERE session_id = ? AND user_id = ? AND claim_id = ?'
        ).get(s.id, u.id, String(msg.claimId ?? ''));
        const isPrimaryOp = msg.claimId === s.claim_id && s.operator_id === u.id;
        if (!isPrimaryOp && !joinedOp) return ws.close(4003, 'invalid-session');
        if (!['pending-consent', 'approved'].includes(s.state)) return ws.close(4003, 'invalid-session');
        role = 'operator';
        userId = u.id;
      } else {
        return ws.close(4002, 'auth-first');
      }
      // один сокет на хоста; операторов может быть несколько (v0.4.0) —
      // повторный вход того же пользователя заменяет его старый сокет
      let rt = live.get(s.id);
      if (rt && msg.role === 'host' && rt.hostWs) {
        return ws.close(4004, 'duplicate-socket');
      }
      if (rt && msg.role === 'operator') {
        for (const [oldWs, meta] of rt.opSockets) {
          if (meta.userId === userId) { try { oldWs.close(4000, 'replaced'); } catch { /* уже закрыт */ } rt.opSockets.delete(oldWs); }
        }
      }
      if (!rt && live.size >= cfg.maxSessions) {
        // переподключения своих не блокируем — только новые сеансы при перегрузке
        return ws.close(4005, 'server-busy');
      }
      if (!rt) {
        rt = { hostWs: null, opSockets: new Map(), operatorUserId: null, sigCount: 0, sigReset: 0, hostLostAt: null, opLostAt: null, opLostUser: null, lastBeat: 0, termActive: false, hostPingAt: null, hostPingCount: 0 };
        live.set(s.id, rt);
      }
      let resumed;
      if (msg.role === 'host') {
        resumed = rt.hostLostAt != null; // переподключение в грейсе
        rt.hostLostAt = null;
        rt.hostPingAt = null;
        rt.hostWs = ws;
        // живой хост отвечает на пинги автоматически (ws делает это сам):
        // не ответил — сокет «тихо мёртв» (обрыв сети без close), свипер закроет.
        // Guard по hostWs: pong заменённого сокета не должен трогать состояние
        ws.on('pong', () => { if (rt.hostWs === ws) rt.hostPingAt = null; });
        db.prepare('UPDATE sessions SET lease_expires_at = ? WHERE id = ?')
          .run(new Date(Date.now() + cfg.leaseMs).toISOString(), s.id);
      } else {
        // «Вернулся» = в грейсе потерян ИМЕННО ЭТОТ пользователь (ревью 04.10
        // F2: глобальный opLostAt от чужой утраты делал fresh-оператора B
        // «вернувшимся» без реплея offer — видео у B не появлялось никогда)
        resumed = rt.opLostAt != null && rt.opLostUser === userId;
        rt.opLostAt = null;
        rt.opSockets.set(ws, { userId, claimId: msg.claimId });
        // Мультиоператор: хост поднимает ПЕРСОНАЛЬНЫЙ pc на каждое присоединение
        // (offer адресуется по claimId). Сообщаем и при WS-(пере)подключении, не
        // только при claim-approve: reconnect оператора = новый attach.
        if (rt.hostWs) {
          const op = db.prepare('SELECT id, name, login FROM users WHERE id = ?').get(userId);
          if (op) send(rt.hostWs, { type: 'operator-joined', claimId: msg.claimId, operator: op });
        }
      }
      session = s;
      authed = true;
      clearTimeout(authTimer);
      const fresh = db.prepare('SELECT state FROM sessions WHERE id = ?').get(s.id);
      // graceMs наружу: клиенты держат своё грейс-окно равным серверному
      // (ENOT_GRACE_MS), вместо захардкоженных 30 с (ревью 28.09)
      send(ws, { type: 'ready', sessionId: s.id, role, state: fresh.state, graceMs: cfg.graceMs });
      if (role === 'host' && fresh.state === 'pending-consent' && s.claim_id) {
        const op = db.prepare('SELECT id, name FROM users WHERE id = ?').get(s.operator_id);
        send(ws, { type: 'claim', claimId: s.claim_id, operator: op });
      }
      if (role === 'host' && fresh.state === 'approved') {
        // replay после переподключения: ворота ввода открывает только реальный approved
        send(ws, { type: 'approved', claimId: s.claim_id });
        // Мультиоператор (модель RustDesk): хост после обрыва сигналинга должен
        // знать ВСЕХ присоединённых операторов — каждому он поднимет свой pc
        // (offer адресуется). Без этого оператор, зацепившийся в окно обрыва,
        // оставался бы без видео навсегда.
        for (const ent of rt.opSockets.values()) {
          const op = db.prepare('SELECT id, name, login FROM users WHERE id = ?').get(ent.userId);
          if (op) send(ws, { type: 'operator-joined', claimId: ent.claimId, operator: op });
        }
      }
      if (role === 'operator' && fresh.state === 'approved') {
        send(ws, { type: 'approved', claimId: s.claim_id });
        // offer приходит АДРЕСОВАННО от хоста (host → attachOperator → offer c
        // to:claimId): реплей не нужен и невозможен — у каждого оператора свой pc
      }
      if (resumed) {
        send(rt.hostWs, { type: 'resumed' });
        for (const opWs of rt.opSockets.keys()) {
          // №15 (ревью v0.4.4): оператор, вернувшийся в грейсе, не должен видеть
          // «Подключено», пока хост ещё потерян, — ему peer-reconnecting (взводит
          // rtc-hold оператора), а не resumed
          send(opWs, rt.hostLostAt != null ? { type: 'peer-reconnecting', role: 'host' } : { type: 'resumed' });
        }
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
        if (rtBeat) rtBeat.hostPingCount = 0; // живой heartbeat — лимит ping-циклов свипера не копится
        // №13b: лизинг истёк, грейс объявлен свипером, но хост оказался жив —
        // heartbeat снимает объявленный грейс и снимает баннер операторам.
        // В ГРЕЙСЕ от close'а (hostLostAt от participantLost) сюда не доходим:
        // мёртвый сокет heartbeat не шлёт
        if (rtBeat && rtBeat.hostLostAt != null) {
          rtBeat.hostLostAt = null;
          for (const opWs of rtBeat.opSockets.keys()) send(opWs, { type: 'resumed' });
        }
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
      // file-link (v0.4.0): ссылка на файл в резервном релее — allowlist-поля,
      // релей counterpart-стороне; URL только внутрь /api/v1/relay/
      if (msg.type === 'file-link') {
        if (role !== 'host' && role !== 'operator') return ws.close(4002, 'bad-message');
        const rt = live.get(s.id);
        if (!rt) return;
        const nowFl = Date.now();
        if (nowFl > rt.sigReset) { rt.sigReset = nowFl + SIGNAL_WINDOW_MS; rt.sigCount = 0; }
        rt.sigCount += 1;
        if (rt.sigCount > SIGNAL_MAX) return ws.close(1008, 'slow-consumer');
        const isHost = role === 'host' && rt.hostWs === ws;
        if (!isHost && !rt.opSockets?.has(ws)) return ws.close(4002, 'bad-message');
        const name = typeof msg.name === 'string' ? msg.name.slice(0, 120) : '';
        const size = Number.isInteger(msg.size) && msg.size > 0 && msg.size <= 200 * 1024 * 1024 ? msg.size : 0;
        const url = typeof msg.url === 'string' && msg.url.startsWith('/api/v1/relay/') && msg.url.length <= 500 ? msg.url : '';
        if (!name || !size || !url) return;
        const out = { type: 'file-link', name, size, url };
        if (isHost) { for (const opWs of rt.opSockets.keys()) send(opWs, out); }
        else send(rt.hostWs, out);
        return;
      }
      // idle-warning/clear (v0.5): хост предупреждает операторов о скором
      // завершении по таймауту бездействия ввода и снимает баннер при
      // возобновлении. Только хост, только approved, rate-limit общий с
      // сигнальными сообщениями (SIGNAL_MAX).
      if (msg.type === 'idle-clear') {
        if (role !== 'host') return ws.close(4002, 'bad-message');
        const rt = live.get(s.id);
        const isHost = role === 'host' && rt?.hostWs === ws;
        if (!isHost || s.state !== 'approved') return;
        const nowIc = Date.now();
        if (nowIc > rt.sigReset) { rt.sigReset = nowIc + SIGNAL_WINDOW_MS; rt.sigCount = 0; }
        rt.sigCount += 1;
        if (rt.sigCount > SIGNAL_MAX) return ws.close(1008, 'slow-consumer');
        const out = { type: 'idle-clear' };
        for (const opWs of rt.opSockets.keys()) send(opWs, out);
        return;
      }
      if (msg.type === 'idle-warning') {
        if (role !== 'host') return ws.close(4002, 'bad-message');
        const rt = live.get(s.id);
        const isHost = role === 'host' && rt?.hostWs === ws;
        if (!isHost || s.state !== 'approved') return;
        const nowIw = Date.now();
        if (nowIw > rt.sigReset) { rt.sigReset = nowIw + SIGNAL_WINDOW_MS; rt.sigCount = 0; }
        rt.sigCount += 1;
        if (rt.sigCount > SIGNAL_MAX) return ws.close(1008, 'slow-consumer');
        const remainingSec = Number.isInteger(msg.remainingSec) && msg.remainingSec > 0 && msg.remainingSec <= 3600
          ? msg.remainingSec : 60;
        const out = { type: 'idle-warning', remainingSec };
        for (const opWs of rt.opSockets.keys()) send(opWs, out);
        return;
      }
      // machine-video (v0.6, ADR 0027): статус видео-хелпера host→операторам
      // (running/error/off + причина). Гейт и rate-limit — как у idle-*.
      if (msg.type === 'machine-video') {
        if (role !== 'host') return ws.close(4002, 'bad-message');
        const rt = live.get(s.id);
        const isHost = role === 'host' && rt?.hostWs === ws;
        if (!isHost || s.state !== 'approved') return;
        const nowMv = Date.now();
        if (nowMv > rt.sigReset) { rt.sigReset = nowMv + SIGNAL_WINDOW_MS; rt.sigCount = 0; }
        rt.sigCount += 1;
        if (rt.sigCount > SIGNAL_MAX) return ws.close(1008, 'slow-consumer');
        const state = ['spawning', 'connecting', 'running', 'error', 'off'].includes(msg.state) ? msg.state : 'error';
        const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 60) : '';
        const helperState = typeof msg.helper?.state === 'string' ? msg.helper.state.slice(0, 30) : '';
        const helperDisplayOff = typeof msg.helper?.displayOff === 'boolean' ? msg.helper.displayOff : null;
        const out = {
          type: 'machine-video',
          state,
          ...(reason ? { reason } : {}),
          ...(helperState ? { helperState } : {}),
          ...(helperDisplayOff !== null ? { helperDisplayOff } : {}),
        };
        for (const opWs of rt.opSockets.keys()) send(opWs, out);
        return;
      }
      if (msg.type === 'signal') {
        if (role !== 'host' && role !== 'operator') return send(ws, { type: 'error', code: 'forbidden', message: 'Недопустимое сообщение' });
        const rt = live.get(s.id);
        const isHost = role === 'host' && rt?.hostWs === ws;
        const isOp = role === 'operator' && rt?.opSockets?.has(ws);
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
        const clean = msg.data.description
          ? { type: 'signal', data: { description: { type: msg.data.description.type, sdp: msg.data.description.sdp } } }
          : { type: 'signal', data: { candidate: msg.data.candidate } };
        if (isHost) {
          // Мультиоператор (модель RustDesk, N подписчиков на один поток):
          // to=claimId — адресованный offer/ICE ПЕРСОНАЛЬНОМУ pc оператора;
          // без to — fan-out всем (машина-хост: прежний поток, первый answer
          // выигрывает). Валидный `to` без сокета (оператор ушёл) — сигнал дропается.
          const to = typeof msg.to === 'string' && msg.to.length <= 128 ? msg.to : null;
          if (to) {
            let delivered = false;
            for (const [opWs, ent] of rt.opSockets) {
              if (ent.claimId !== to) continue;
              send(opWs, clean);
              delivered = true;
              break;
            }
            return delivered ? send(ws, clean) : undefined;
          }
          for (const opWs of rt.opSockets.keys()) send(opWs, clean);
          return send(ws, clean);
        }
        // op→host: тегируем источником claimId — хост роутит answer/ICE
        // в персональный pc этого оператора (ревью волны v0.6.2)
        const opEnt = rt.opSockets.get(ws);
        return send(rt.hostWs, { type: 'signal', from: opEnt.claimId, data: clean.data });
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
        for (const ws of [rt.hostWs, ...rt.opSockets.keys()]) if (ws) ws.terminate();
      }
      live.clear();
      for (const client of wss.clients) client.terminate();
      server.close(() => { db.close(); resolve(); });
    }),
  };
}

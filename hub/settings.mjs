// Настройки хаба (T03/T05): виджет (allowlist origins, consent-гейт, ссылка
// на политику) и webhook-секрет приёма /hooks/enotdesk. Ключи — строки в
// hub_settings с JSON. Секрет по правилу «токены/секреты — хеши или
// AES-256-GCM»: есть ENOT_SECRET_KEY — шифротекст (как bearer в hub/auth.mjs),
// нет — хранится как есть, но наружу отдаётся только админу консоли.
import { secretKeyBytes, encryptSecret, decryptSecret } from '../server/totp.mjs';
import { sanitizeEmail } from './threads.mjs';
import crypto from 'node:crypto';

export const WIDGET_SETTINGS_LIMITS = { origins: 20, origin: 253, policyUrl: 500 };
// Email-канал (T06): пределы полей кредов IMAP/SMTP.
export const EMAIL_SETTINGS_LIMITS = { user: 320, pass: 512 };

// hostname (минимум одна точка) с необязательным портом; дефисы не по краям
// меток; только lowercase после санитизации. Порт 1..65535 без ведущих нулей —
// допускаем любые цифры, порт > 65535 отвергается отдельной проверкой.
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:[0-9]{1,5})?$/;

// 'https://Site.example:8443/path' → 'site.example:8443' | null
export function sanitizeOriginHost(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;
  let host;
  try { host = new URL(s.includes('://') ? s : `https://${s}`).host; } catch { return null; }
  if (!HOST_RE.test(host)) return null;
  const port = Number.parseInt(host.slice(host.indexOf(':') + 1), 10);
  if (host.includes(':') && (port < 1 || port > 65535)) return null;
  return host;
}

export function sanitizePolicyUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, WIDGET_SETTINGS_LIMITS.policyUrl);
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return s;
  } catch { return null; }
}

// raw → null (мусор) | {origins:[host...], consentRequired:bool, policyUrl:string}
export function sanitizeWidgetSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let origins = [];
  if (raw.origins !== undefined) {
    if (!Array.isArray(raw.origins) || raw.origins.length > WIDGET_SETTINGS_LIMITS.origins) return null;
    for (const o of raw.origins) {
      const host = sanitizeOriginHost(o);
      if (!host) return null;
      if (!origins.includes(host)) origins.push(host);
    }
  }
  const consentRequired = raw.consentRequired === undefined ? false : raw.consentRequired === true;
  const policyUrl = sanitizePolicyUrl(raw.policyUrl);
  if (policyUrl === null) return null;
  return { origins, consentRequired, policyUrl };
}

export const DEFAULT_WIDGET_SETTINGS = { origins: [], consentRequired: false, policyUrl: '' };

export function createSettingsStore(db, { nowMs = Date.now, secretKey = '' } = {}) {
  const KEY = 'widget';
  const HOOK_KEY = 'webhook_secret';
  const keyBytes = secretKey ? secretKeyBytes(secretKey) : null;

  function getWidget() {
    const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(KEY);
    if (!row) return { ...DEFAULT_WIDGET_SETTINGS };
    try {
      const parsed = sanitizeWidgetSettings(JSON.parse(row.value));
      return parsed ?? { ...DEFAULT_WIDGET_SETTINGS };
    } catch { return { ...DEFAULT_WIDGET_SETTINGS }; }
  }

  // Слитченный патч (передаётся полный объект) → 'invalid' | сохранённые настройки.
  function setWidget(next) {
    const clean = sanitizeWidgetSettings(next);
    if (!clean) return 'invalid';
    db.prepare(`
      INSERT INTO hub_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(KEY, JSON.stringify(clean), new Date(nowMs()).toISOString());
    return clean;
  }

  // Секрет приёма webhooks EnotDesk (/hooks/enotdesk): генерируется при первом
  // старте хаба и живёт в hub_settings; EnotDesk подписывает им события, админ
  // копирует его в настройках webhooks сервера.
  // Возврат {secret, rotated}: rotated=true — прежний секрет не расшифрован
  // (сменили/убрали ENOT_SECRET_KEY) и сгенерирован новый — админ обязан
  // обновить его в настройках webhooks EnotDesk. Первое создание — не ротация.
  function ensureWebhookSecret() {
    const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(HOOK_KEY);
    if (row) {
      if (!keyBytes) return { secret: row.value, rotated: false };
      // decryptSecret возвращает null при неудаче (чужой ключ/порча) — не бросает
      const secret = decryptSecret(keyBytes, row.value);
      if (secret) return { secret, rotated: false };
    }
    const generated = crypto.randomBytes(24).toString('base64url');
    const stored = keyBytes ? encryptSecret(keyBytes, generated) : generated;
    db.prepare(`
      INSERT INTO hub_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(HOOK_KEY, stored, new Date(nowMs()).toISOString());
    return { secret: generated, rotated: Boolean(row) };
  }

  function getWebhookSecret() {
    const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(HOOK_KEY);
    if (!row) return '';
    if (!keyBytes) return row.value;
    try { return decryptSecret(keyBytes, row.value); } catch { return ''; }
  }

  // ---- Email-канал (T06): креды IMAP/SMTP ----
  // Пароли — только шифротекст AES-256-GCM (как bearer/2FA); нет ENOT_SECRET_KEY —
  // включение честно отказывает 'secret_key_missing' (симметрично включению 2FA).
  // Наружу отдаётся маска getEmailSettings(): без паролей, вместо них hasPass.

  const EMAIL_KEY = 'email';
  const EMAIL_TEST_KEY = 'email_test';

  // Хост почтового сервера: одна метка ('localhost') или домен; порт — отдельное
  // поле. IPv6-литералы не поддержаны (v1, честно отвергаются валидацией).
  const MAIL_HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

  function sanitizePort(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }

  // {host,port,tls,user} | null (пароль шифруется отдельно)
  function sanitizeMailServer(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const host = typeof raw.host === 'string' ? raw.host.trim().toLowerCase() : '';
    if (!host || !MAIL_HOST_RE.test(host)) return null;
    const port = sanitizePort(raw.port);
    if (!port) return null;
    const tls = raw.tls === undefined ? true : raw.tls === true;
    const user = typeof raw.user === 'string' ? raw.user.trim().slice(0, EMAIL_SETTINGS_LIMITS.user) : '';
    return { host, port, tls, user };
  }

  // Входящий pass: пусто/undefined → «оставить прежний»; строка → новый; мусор → null.
  function incomingPass(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > EMAIL_SETTINGS_LIMITS.pass) return null;
    return value;
  }

  function readStoredEmail() {
    const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(EMAIL_KEY);
    if (!row) return null;
    try {
      const v = JSON.parse(row.value);
      if (!v || typeof v !== 'object' || !v.imap || !v.smtp) return null;
      return v;
    } catch { return null; }
  }

  function saveStoredEmail(stored) {
    db.prepare(`
      INSERT INTO hub_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(EMAIL_KEY, JSON.stringify(stored), new Date(nowMs()).toISOString());
  }

  // Расшифрованные полные креды | null. Не расшифровалось (сменили ключ) —
  // канал честно выключен, админ перенастраивает.
  function getEmail() {
    const stored = readStoredEmail();
    if (!stored) return null;
    const imapPass = stored.imap.pass ? decryptSecret(keyBytes, stored.imap.pass) : '';
    const smtpPass = stored.smtp.pass ? decryptSecret(keyBytes, stored.smtp.pass) : '';
    if ((stored.imap.pass && imapPass === null) || (stored.smtp.pass && smtpPass === null)) return null;
    const imap = { ...stored.imap, pass: imapPass ?? '' };
    const smtp = { ...stored.smtp, pass: smtpPass ?? '' };
    if (!imap.host || !imap.user || !imap.pass || !smtp.host || !smtp.from) return null;
    return { imap, smtp };
  }

  // POST {imap:{host,port,tls,user,pass?}, smtp:{host,port,tls,user,pass?,from}}:
  // всё, кроме pass, обязательно; пустой pass = «оставить прежний» (форма админа
  // не заставляет перепечатывать пароль при смене хоста). 'invalid' |
  // 'secret_key_missing' | true.
  function setEmail(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'invalid';
    // Полные креды требуют пароль, пароль требует ключ — как у включения 2FA.
    if (!keyBytes) return 'secret_key_missing';
    const prev = readStoredEmail();
    const imap = sanitizeMailServer(body.imap);
    const smtp = sanitizeMailServer(body.smtp);
    if (!imap || !smtp || !imap.user) return 'invalid';
    const from = sanitizeEmail(typeof body.smtp?.from === 'string' ? body.smtp.from.trim() : '');
    if (!from) return 'invalid';
    const newImapPass = incomingPass(body.imap?.pass);
    const newSmtpPass = incomingPass(body.smtp?.pass);
    if (newImapPass === null || newSmtpPass === null) return 'invalid';
    const imapPass = newImapPass ? encryptSecret(keyBytes, newImapPass) : (prev?.imap?.pass || '');
    const smtpPass = newSmtpPass ? encryptSecret(keyBytes, newSmtpPass) : (prev?.smtp?.pass || '');
    if (!imapPass) return 'invalid'; // полные креды: IMAP без пароля канал не включает
    saveStoredEmail({ imap: { ...imap, pass: imapPass }, smtp: { ...smtp, from, pass: smtpPass } });
    return true;
  }

  // Маска для GET: те же поля, что в POST, но pass → hasPass; пароля нет нигде.
  function getEmailSettings() {
    const stored = readStoredEmail();
    if (!stored) return null;
    const side = (s) => ({
      host: s.host ?? '',
      port: s.port ?? 0,
      tls: s.tls !== false,
      user: s.user ?? '',
      hasPass: Boolean(s.pass),
    });
    return {
      imap: side(stored.imap),
      smtp: { ...side(stored.smtp), from: stored.smtp.from ?? '' },
    };
  }

  // Выключение канала: креды и последний результат проверки связи стираются.
  function clearEmail() {
    db.prepare('DELETE FROM hub_settings WHERE key = ?').run(EMAIL_KEY);
    db.prepare('DELETE FROM hub_settings WHERE key = ?').run(EMAIL_TEST_KEY);
  }

  // Результат «Проверить связь»: {at, ok, imap:{ok,error?}, smtp:{ok,error?}}.
  // В логи не пишется вообще — только здесь, наружу админу.
  function setEmailTest(result) {
    if (!result || typeof result !== 'object') return;
    const side = (s) => {
      const clean = { ok: s?.ok === true };
      if (typeof s?.error === 'string' && s.error) clean.error = s.error.slice(0, 200);
      return clean;
    };
    const clean = {
      at: typeof result.at === 'string' ? result.at : new Date(nowMs()).toISOString(),
      ok: result.ok === true,
      imap: side(result.imap),
      smtp: side(result.smtp),
    };
    db.prepare(`
      INSERT INTO hub_settings (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(EMAIL_TEST_KEY, JSON.stringify(clean), new Date(nowMs()).toISOString());
  }

  function getEmailTest() {
    const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(EMAIL_TEST_KEY);
    if (!row) return null;
    try { return JSON.parse(row.value) ?? null; } catch { return null; }
  }

  return {
    getWidget, setWidget, ensureWebhookSecret, getWebhookSecret,
    getEmail, setEmail, getEmailSettings, clearEmail, setEmailTest, getEmailTest,
  };
}

import crypto from 'node:crypto';
import { sanitizeEmail, sanitizeText, THREAD_LIMITS } from './threads.mjs';
import { t } from '../client/lib/i18n.mjs';
import { SYSTEM_LOCALE } from './join.mjs';

// Email-канал хаба (T06, ADR 0025): IMAP-поллер складывает письма в тикеты
// (threads channel=email), ответы агента уходят по SMTP с проставленным
// In-Reply-To. Всё сетевое — инъекцией (ImapClient/transporter): прод получает
// реальные imapflow/nodemailer ленивым импортом, тесты — фейки без сети.
// Креды канала живут в hub_settings (hub/settings.mjs, AES-256-GCM) и сюда
// приходят уже расшифрованными через геттер config().

// Пределы: текст письма берём ≤20000 (потолок fetch), тема ≤300 (в треде
// дополнительно режется THREAD_LIMITS.subject=200), ссылок References ≤20.
export const EMAIL_LIMITS = { text: 20000, subject: 300, messageIds: 20, messageId: 998 };

// '<a@b>' → 'a@b'; мусор/пустое/слишком длинное → null.
export function normalizeMessageId(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/^</, '').replace(/>$/, '').trim();
  if (!s || s.length > EMAIL_LIMITS.messageId) return null;
  return s;
}

// Заголовок References: список id через пробел → нормализованные уникальные id.
export function parseMessageIds(value) {
  if (typeof value !== 'string') return [];
  const out = [];
  for (const part of value.split(/\s+/)) {
    const id = normalizeMessageId(part);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= EMAIL_LIMITS.messageIds) break;
  }
  return out;
}

// From → {email, name} | null. Принимает строку заголовка ('"Имя" <a@b>') или
// envelope-объект ({value:[{name,address}]} / {address,name}). email —
// trim/lower (правило тикета), имя — display-часть, ≤120.
function parseFrom(value, fallbackName = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const first = Array.isArray(value.value) ? value.value[0] : value;
    const email = sanitizeEmail(String(first?.address ?? '').toLowerCase().trim());
    if (!email) return null;
    const name = sanitizeText(String(first?.name ?? fallbackName), THREAD_LIMITS.contactName) ?? '';
    return { email, name };
  }
  if (typeof value !== 'string') return null;
  const m = /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(value);
  const email = m ? sanitizeEmail(m[0].toLowerCase()) : null;
  if (!email) return null;
  let name = fallbackName;
  const lt = value.indexOf('<');
  if (lt > 0) name = value.slice(0, lt).trim().replace(/^["']+|["']+$/g, '');
  return { email, name: sanitizeText(name, THREAD_LIMITS.contactName) ?? '' };
}

// Сырое письмо (messageFromImap) → нормализованное | null. Без Message-ID
// дедуп невозможен, без валидного from нечего создавать — честный null.
export function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const messageId = normalizeMessageId(raw.messageId);
  if (!messageId) return null;
  const from = parseFrom(raw.from, raw.fromName);
  if (!from) return null;
  const subject = typeof raw.subject === 'string'
    ? raw.subject.replace(/\s+/g, ' ').trim().slice(0, EMAIL_LIMITS.subject)
    : '';
  const text = typeof raw.text === 'string' ? raw.text.slice(0, EMAIL_LIMITS.text) : '';
  return {
    messageId,
    inReplyTo: normalizeMessageId(raw.inReplyTo),
    references: parseMessageIds(raw.references),
    from,
    subject,
    text,
    // Auto-Submitted (RFC 3834): '' — заголовка нет (= 'no'), 'no' — автор
    // человек; иначе письмо сгенерировано машиной (петля автоответов).
    autoSubmitted: typeof raw.autoSubmitted === 'string' ? raw.autoSubmitted.trim().toLowerCase() : '',
    date: raw.date ?? null,
  };
}

// Сообщение imapflow (envelope + headers + text) → сырое письмо для
// normalizeEmail. Заголовки бывают Map или объектом, ключи — lowercase.
export function messageFromImap(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const headers = msg.headers;
  const headerValue = (name) => {
    if (headers instanceof Map) return headers.get(name) ?? headers.get(name.toLowerCase());
    if (headers && typeof headers === 'object') return headers[name] ?? headers[name.toLowerCase()];
    return undefined;
  };
  const env = msg.envelope && typeof msg.envelope === 'object' ? msg.envelope : {};
  const envFrom = Array.isArray(env.from?.value) ? env.from.value[0] : env.from;
  const bodyParts = msg.bodyParts;
  const partText = bodyParts instanceof Map
    ? bodyParts.get('text')
    : (bodyParts && typeof bodyParts === 'object' ? bodyParts.text : undefined);
  const text = msg.text ?? (typeof partText === 'string' ? partText : '') ?? '';
  return {
    uid: msg.uid,
    messageId: env.messageId ?? headerValue('message-id') ?? '',
    inReplyTo: env.inReplyTo ?? headerValue('in-reply-to') ?? '',
    references: headerValue('references') ?? '',
    from: envFrom ?? msg.from ?? headerValue('from') ?? '',
    subject: env.subject ?? headerValue('subject') ?? '',
    text: typeof text === 'string' ? text : '',
    autoSubmitted: headerValue('auto-submitted') ?? '',
    date: msg.date ?? env.date ?? null,
  };
}

export function createEmailChannel({ db, store, config, now = Date.now, onMessage, ImapClient, transporter, log, intervalMs = 60_000 } = {}) {
  // Таблица email_seen (+индекс) — миграция v5 в hub/db.mjs: schema ведётся
  // только там; каналу остаётся доступ через prepared statements ниже.

  const nowIso = () => new Date(now()).toISOString();
  const seenGet = (messageId) =>
    db.prepare('SELECT thread_id FROM email_seen WHERE message_id = ?').get(messageId)?.thread_id ?? null;
  const seenPut = (messageId, threadId) =>
    db.prepare('INSERT OR REPLACE INTO email_seen (message_id, thread_id, created_at) VALUES (?,?,?)')
      .run(messageId, threadId, nowIso());
  const seenLastForThread = (threadId) =>
    db.prepare('SELECT message_id FROM email_seen WHERE thread_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(threadId)?.message_id ?? null;

  // Письмо → тикет. null — письмо не разобрано; created/appended/duplicate/
  // skipped — результат (skipped: html-only без текста — терять нечего, но
  // message-id помечен виденным и письмо не вернётся при следующем опросе).
  function processMessage(raw) {
    const mail = normalizeEmail(raw);
    if (!mail) return null;
    const seen = seenGet(mail.messageId);
    if (seen !== null) return { status: 'duplicate', threadId: seen || null };
    // Тред: In-Reply-To, затем References — первый известный id решает.
    const chain = [...(mail.inReplyTo ? [mail.inReplyTo] : []), ...mail.references];
    let threadId = null;
    for (const id of chain) {
      const t = seenGet(id);
      if (t && store.getThread(t)) { threadId = t; break; }
    }
    if (!mail.text) {
      // Виденным помечаем всегда — иначе html-only письмо вечно возвращается
      // при каждом опросе; треда может не быть (thread_id '') — sentinel:
      // TODO(схема): развести seen и thread_id при втором потребителе таблицы.
      seenPut(mail.messageId, threadId ?? '');
      return { status: 'skipped', threadId: threadId ?? null };
    }
    // Петля автоответов: собственное письмо (smtp.from / imap.user) с
    // Auto-Submitted кроме 'no' не становится тикетом — иначе наш же
    // SMTP-ответ, bounce или пересылка порождают бесконечную переписку
    // сами с собой. Без заголовка (или 'no') — человек, тикет создаётся.
    const cfg = config?.();
    const ownAddresses = [cfg?.smtp?.from, cfg?.imap?.user]
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
      .filter(Boolean);
    if (ownAddresses.includes(mail.from.email) && mail.autoSubmitted && mail.autoSubmitted !== 'no') {
      seenPut(mail.messageId, threadId ?? '');
      return { status: 'skipped', threadId: threadId ?? null };
    }
    if (threadId) {
      const message = store.appendMessage(threadId, { author: 'contact', type: 'text', body: mail.text });
      if (!message) return { status: 'skipped', threadId };
      seenPut(mail.messageId, threadId);
      onMessage?.(threadId, message);
      return { status: 'appended', threadId };
    }
    const subject = mail.subject || (mail.text.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, THREAD_LIMITS.subject)) || 'Без темы';
    const thread = store.createThread({
      channel: 'email',
      subject,
      contact: { email: mail.from.email, name: mail.from.name || null },
      firstMessage: { author: 'contact', type: 'text', body: mail.text },
    });
    if (!thread) return { status: 'skipped', threadId: null };
    seenPut(mail.messageId, thread.id);
    const first = store.getThread(thread.id)?.messages?.at(-1);
    if (first) onMessage?.(thread.id, first);
    return { status: 'created', threadId: thread.id };
  }

  // ---- поллер (IMAP) ----
  // Прод использует реальный ImapFlow (ленивый импорт — только когда канал
  // включён), тесты кладут фейк классом. Поверхность фейка: connect(),
  // getMailbox('INBOX') → {fetch(query, opts) — async-итератор сообщений,
  // addFlags(uid, flags)}, logout().

  let timer = null;
  let polling = false;
  let imapFlowPromise = null;
  let nodemailerPromise = null;

  const errText = (e) => String(e?.message ?? e).slice(0, 200);

  async function resolveImapClass() {
    if (ImapClient) return ImapClient;
    imapFlowPromise ??= import('imapflow').then((m) => m.ImapFlow ?? m.default);
    return imapFlowPromise;
  }

  // transporter — объект-фейк в тестах или функция-геттер в проде; без опции —
  // nodemailer из текущих кредов (без pooling: письмо → соединение, надежнее
  // при смене кредов на лету).
  async function resolveTransporter() {
    if (transporter) return typeof transporter === 'function' ? await transporter() : transporter;
    const c = config?.();
    if (!c?.smtp?.host) return null;
    nodemailerPromise ??= import('nodemailer').then((m) => m.default ?? m);
    const nm = await nodemailerPromise;
    return nm.createTransport({
      host: c.smtp.host,
      port: c.smtp.port,
      secure: c.smtp.tls !== false,
      auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass } : undefined,
    });
  }

  async function pollOnce() {
    if (polling) return; // предыдущий опрос ещё идёт — не наслаиваемся
    polling = true;
    try {
      const c = config?.();
      if (!c?.imap?.host) return; // канал выключен — тик пустой
      const Cls = await resolveImapClass();
      if (!Cls) { log?.('email: imapflow недоступен'); return; }
      const client = new Cls({
        host: c.imap.host,
        port: c.imap.port,
        secure: c.imap.tls !== false,
        auth: { user: c.imap.user, pass: c.imap.pass },
        logger: false,
      });
      await client.connect();
      try {
        const lock = await client.getMailbox('INBOX');
        if (lock) {
          for await (const message of lock.fetch({ seen: false }, { uid: true, envelope: true, headers: true, bodyParts: ['text'] })) {
            try { processMessage(messageFromImap(message)); } catch (e) { log?.(`email: письмо не разобрано: ${errText(e)}`); }
            if (message?.uid !== undefined && typeof lock.addFlags === 'function') {
              try { await lock.addFlags(message.uid, ['\\Seen']); } catch (e) { log?.(`email: \\Seen не поставлен: ${errText(e)}`); }
            }
          }
        }
      } finally {
        try { await client.logout?.(); } catch { /* уже закрыт */ }
      }
    } catch (e) {
      // Любая ошибка поллера — только строка в log, хаб не падает; креды
      // в сообщения лога намеренно не попадают (только текст ошибки).
      log?.(`email: опрос не удался: ${errText(e)}`);
    } finally {
      polling = false;
    }
  }

  function start() {
    if (timer || !(intervalMs > 0)) return; // идемпотентен
    timer = setInterval(() => { void pollOnce(); }, intervalMs);
    timer.unref?.(); // интервал не держит процесс хаба
  }

  function stop() {
    if (!timer) return; // идемпотентен
    clearInterval(timer);
    timer = null;
  }

  // ---- ответы по SMTP ----

  // Ответ агента в email-треде → письмо клиенту. In-Reply-To — последний
  // известный Message-ID треда (входящий или наш исходящий), собственный
  // Message-ID записывается в email_seen, чтобы ответ клиента вернулся в
  // тот же тред. Ошибка доставки → честное system-сообщение в тред + false.
  async function sendReply(thread, agent, text) {
    const id = typeof thread === 'string' ? thread : thread?.id;
    const detail = id ? store.getThread(id) : null;
    const to = detail?.thread?.contact?.email;
    const body = sanitizeText(text, THREAD_LIMITS.body);
    if (!detail || !to || !body) return false;
    const c = config?.();
    if (!c?.smtp?.from) return false; // канал выключен — шлюз не зовётся
    const mailer = await resolveTransporter();
    if (!mailer || typeof mailer.sendMail !== 'function') return false;
    const messageId = `${crypto.randomUUID()}@hub.enotdesk`;
    const inReplyTo = seenLastForThread(id);
    seenPut(messageId, id);
    try {
      await mailer.sendMail({
        from: c.smtp.from,
        to,
        subject: `Re: ${detail.thread.subject}`.slice(0, EMAIL_LIMITS.subject),
        text: body,
        messageId,
        inReplyTo: inReplyTo || undefined,
      });
      return true;
    } catch (e) {
      // Системный текст — через общий i18n с SYSTEM_LOCALE (как systemStarted
      // в join.mjs): system-сообщения треда детерминированы.
      const message = store.appendMessage(id, {
        author: 'system',
        type: 'text',
        body: t('hub.email.deliveryFailed', { to, error: errText(e) }, SYSTEM_LOCALE),
        agentId: typeof agent?.id === 'string' ? agent.id : null,
      });
      if (message) onMessage?.(id, message);
      return false;
    }
  }

  // «Проверить связь»: IMAP connect+logout и SMTP verify, обе стороны честно.
  async function testConnection() {
    const result = { at: nowIso(), ok: false, imap: { ok: false }, smtp: { ok: false } };
    const c = config?.();
    if (!c?.imap?.host || !c?.smtp?.host) return { ...result, reason: 'not_configured' };
    try {
      const Cls = await resolveImapClass();
      if (!Cls) throw new Error('imapflow недоступен');
      const client = new Cls({
        host: c.imap.host,
        port: c.imap.port,
        secure: c.imap.tls !== false,
        auth: { user: c.imap.user, pass: c.imap.pass },
        logger: false,
      });
      await client.connect();
      try {
        const lock = await client.getMailbox('INBOX');
        result.imap = { ok: true };
        if (!lock) result.imap.mailbox = null; // ящика нет — честно, но INBOX стандартен
      } finally {
        try { await client.logout?.(); } catch { /* уже закрыт */ }
      }
    } catch (e) {
      result.imap = { ok: false, error: errText(e) };
    }
    try {
      const mailer = await resolveTransporter();
      if (!mailer || typeof mailer.verify !== 'function') throw new Error('SMTP verify недоступен');
      await mailer.verify();
      result.smtp = { ok: true };
    } catch (e) {
      result.smtp = { ok: false, error: errText(e) };
    }
    result.ok = result.imap.ok === true && result.smtp.ok === true;
    return result;
  }

  return { processMessage, seenLastForThread, start, stop, pollOnce, sendReply, testConnection, get _interval() { return timer; } };
}

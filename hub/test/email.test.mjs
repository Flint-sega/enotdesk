import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { openHubDb } from '../db.mjs';
import { createThreadsStore, THREAD_LIMITS } from '../threads.mjs';
import { createEmailChannel, normalizeEmail, messageFromImap, parseMessageIds, EMAIL_LIMITS } from '../email.mjs';

// Фикстуры писем: значения ожидаемого фиксируем руками (форма сообщений —
// imapflow-подобная: envelope + text, как отдаёт lock.fetch с bodyParts:['text']).
const NOW = () => Date.parse('2026-09-20T10:00:00Z');

const MAIL_NEW = {
  uid: 1,
  envelope: {
    messageId: '<abc123@example-sender.test>',
    subject: 'Не работает подключение',
    from: { value: [{ name: 'Иван Петров', address: 'Ivan@Example.COM' }] },
  },
  text: 'Здравствуйте! Не могу подключиться к клиенту.',
  date: new Date('2026-09-20T10:00:00Z'),
};

const MAIL_REPLY = {
  uid: 2,
  envelope: {
    messageId: '<reply1@example-sender.test>',
    inReplyTo: 'abc123@example-sender.test', // без <> — нормализация обязана съесть обе формы
    subject: 'Re: Не работает подключение',
    from: { value: [{ name: 'Иван Петров', address: 'ivan@example.com' }] },
  },
  text: 'Всё ещё не работает',
};

function makeDb() {
  const db = openHubDb(':memory:');
  return { db, store: createThreadsStore(db, { nowMs: NOW }) };
}

function makeChannel({ db, store, config = () => null, ...rest } = {}) {
  return createEmailChannel({ db, store, config, now: NOW, intervalMs: 60_000, ...rest });
}

// ---- маппер: письмо → нормализованная форма ----

test('mapper: envelope-письмо → email lower/trim, имя, messageId без <>', () => {
  const mail = normalizeEmail(messageFromImap(MAIL_NEW));
  assert.equal(mail.messageId, 'abc123@example-sender.test');
  assert.equal(mail.from.email, 'ivan@example.com');
  assert.equal(mail.from.name, 'Иван Петров');
  assert.equal(mail.subject, 'Не работает подключение');
  assert.equal(mail.text, 'Здравствуйте! Не могу подключиться к клиенту.');
  assert.equal(mail.inReplyTo, null);
});

test('mapper: строковый From «Имя <a@b>», References из заголовков, Map-заголовки', () => {
  const mail = normalizeEmail(messageFromImap({
    uid: 3,
    envelope: { messageId: '<mid7@x.test>', subject: 's' },
    headers: { references: '<a@b.test> <c@d.test> <a@b.test>', 'message-id': '<mid7@x.test>' },
    from: '  "О. Продуктов" <O.Podgrupp@Mail.test>  ',
    text: 'текст',
  }));
  assert.equal(mail.from.email, 'o.podgrupp@mail.test');
  assert.equal(mail.from.name, 'О. Продуктов');
  assert.deepEqual(mail.references, ['a@b.test', 'c@d.test']); // дедуп и нормализация <>
  assert.equal(mail.messageId, 'mid7@x.test');

  const viaMap = normalizeEmail(messageFromImap({
    uid: 4,
    envelope: { subject: 's', from: { value: [{ address: 'x@y.test' }] } },
    headers: new Map([['message-id', '<map-id@x.test>']]),
    text: 'тело',
  }));
  assert.equal(viaMap.messageId, 'map-id@x.test');
});

test('mapper: мусор честно → null (нет Message-ID, нет валидного from, не объект)', () => {
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail({ from: 'a@b.test', subject: 's', text: 't' }), null); // нет Message-ID — дедуп невозможен
  assert.equal(normalizeEmail({ messageId: '<x@y>', from: 'не-почта', subject: 's', text: 't' }), null);
  assert.deepEqual(parseMessageIds(''), []);
  assert.deepEqual(parseMessageIds(undefined), []);
});

test('mapper: лимиты — text ≤20000, subject ≤300, длинный references-список обрезан', () => {
  const longText = 'ж'.repeat(25000);
  const mail = normalizeEmail({ messageId: '<l@t>', from: 'a@b.test', subject: 's'.repeat(400), text: longText });
  assert.equal(mail.text.length, EMAIL_LIMITS.text);
  assert.equal(mail.subject.length, EMAIL_LIMITS.subject);
  const many = Array.from({ length: 40 }, (_, i) => `<r${i}@t>`).join(' ');
  assert.ok(normalizeEmail({ messageId: '<l2@t>', from: 'a@b.test', subject: 's', text: 'x', references: many }).references.length <= 20);
});

// ---- processMessage: письмо → тикет ----

test('processMessage: новое письмо → тред channel=email, контакт, сообщение от клиента', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const r = channel.processMessage(messageFromImap(MAIL_NEW));
  assert.equal(r.status, 'created');
  const detail = store.getThread(r.threadId);
  assert.equal(detail.thread.channel, 'email');
  assert.equal(detail.thread.contact.email, 'ivan@example.com');
  assert.equal(detail.thread.contact.name, 'Иван Петров');
  assert.equal(detail.thread.subject, 'Не работает подключение');
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].author, 'contact');
  assert.equal(detail.messages[0].body, 'Здравствуйте! Не могу подключиться к клиенту.');
});

test('processMessage: In-Reply-To на известный message-id → сообщение в существующий тред', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const first = channel.processMessage(messageFromImap(MAIL_NEW));
  const second = channel.processMessage(messageFromImap(MAIL_REPLY));
  assert.equal(second.status, 'appended');
  assert.equal(second.threadId, first.threadId);
  const detail = store.getThread(first.threadId);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].body, 'Всё ещё не работает');
});

test('processMessage: дедуп — тот же message-id не создаёт второй тикет', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const first = channel.processMessage(messageFromImap(MAIL_NEW));
  const dup = channel.processMessage(messageFromImap(MAIL_NEW));
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.threadId, first.threadId);
  assert.equal(store.getThread(first.threadId).messages.length, 1);
  assert.equal(store.listThreads({ channel: 'email' }).total, 1);
});

test('processMessage: тот же отправитель в другом письме → тот же контакт (trim/lower)', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const a = channel.processMessage(messageFromImap(MAIL_NEW));
  const b = channel.processMessage(messageFromImap({
    uid: 9,
    envelope: { messageId: '<other@x.test>', subject: 'Другой вопрос', from: { value: [{ address: ' IVAN@example.com ' }] } },
    text: 'Ещё вопрос',
  }));
  const ca = store.getThread(a.threadId).thread.contact;
  const cb = store.getThread(b.threadId).thread.contact;
  assert.equal(cb.id, ca.id);
});

test('processMessage: письмо без темы → тред с темой из первой строки текста', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const r = channel.processMessage(messageFromImap({
    uid: 5,
    envelope: { messageId: '<nosubj@x.test>', from: { value: [{ address: 'a@b.test' }] } },
    text: 'Первая строка — это тема\nА это продолжение',
  }));
  assert.equal(r.status, 'created');
  assert.equal(store.getThread(r.threadId).thread.subject, 'Первая строка — это тема');
});

test('processMessage: длинный текст письма режется до 20000, имя контакта — до 120', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const r = channel.processMessage(messageFromImap({
    uid: 6,
    envelope: { messageId: '<big@x.test>', subject: 's', from: { value: [{ name: 'И'.repeat(500), address: 'a@b.test' }] } },
    text: 'т'.repeat(25000),
  }));
  const detail = store.getThread(r.threadId);
  assert.ok(detail.messages[0].body.length <= EMAIL_LIMITS.text);
  assert.ok(detail.thread.contact.name.length <= THREAD_LIMITS.contactName);
});

test('processMessage: письмо без текста (html-only) честно пропущено, но помечено виденным', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const r = channel.processMessage(messageFromImap({ uid: 7, envelope: { messageId: '<html@x.test>', subject: 's', from: { value: [{ address: 'a@b.test' }] } }, text: '' }));
  assert.equal(r.status, 'skipped');
  assert.equal(store.listThreads({ channel: 'email' }).total, 0);
  const dup = channel.processMessage(messageFromImap({ uid: 7, envelope: { messageId: '<html@x.test>', subject: 's', from: { value: [{ address: 'a@b.test' }] } }, text: '' }));
  assert.equal(dup.status, 'duplicate'); // не переобрабатывается вечно
});

// ---- цикл 2: поллер (фейк-IMAP), sendReply (фейк-transporter), креды ----

import { createSettingsStore } from '../settings.mjs';

const CREDS = {
  imap: { host: 'imap.test', port: 993, tls: true, user: 'support', pass: 'p4ssw0rd' },
  smtp: { host: 'smtp.test', port: 465, tls: true, user: 'support', pass: 'smtp-pw', from: 'support@test.example' },
};

function makeFakeImap(messages, hooks = {}) {
  const state = { connects: 0, logouts: 0, marked: [], opts: null };
  class FakeImapClient {
    constructor(opts) { state.opts = opts; }
    async connect() {
      state.connects++;
      if (hooks.failConnect) throw new Error(hooks.failConnect);
    }
    async logout() { state.logouts++; }
    async getMailbox(name) {
      if (name !== 'INBOX') throw new Error('mailbox: ' + name);
      return {
        fetch: async function* () { for (const m of messages) yield m; },
        addFlags: async (uid) => { state.marked.push(uid); },
      };
    }
  }
  return { Cls: FakeImapClient, state };
}

test('поллер: pollOnce забирает unseen, обрабатывает, помечает \\Seen, выходит через logout', async () => {
  const { db, store } = makeDb();
  const { Cls, state } = makeFakeImap([MAIL_NEW, MAIL_REPLY]);
  const channel = makeChannel({ db, store, config: () => CREDS, ImapClient: Cls });
  await channel.pollOnce();
  assert.equal(state.connects, 1);
  assert.equal(state.logouts, 1);
  assert.deepEqual(state.marked, [1, 2]);
  assert.equal(store.listThreads({ channel: 'email' }).total, 1);
  assert.equal(store.getThread(store.listThreads({ channel: 'email' }).items[0].id).messages.length, 2);
  assert.equal(state.opts.auth.pass, 'p4ssw0rd'); // креды дошли до клиента
  assert.equal(state.opts.host, 'imap.test');
});

test('поллер: канал не настроен → клиент даже не создаётся', async () => {
  const { db, store } = makeDb();
  const { Cls, state } = makeFakeImap([]);
  const channel = makeChannel({ db, store, config: () => null, ImapClient: Cls });
  await channel.pollOnce();
  assert.equal(state.connects, 0);
});

test('поллер: ошибка connect не роняет хаб и не пишет пароль в лог', async () => {
  const { db, store } = makeDb();
  const { Cls, state } = makeFakeImap([], { failConnect: 'imap down' });
  const logs = [];
  const channel = makeChannel({ db, store, config: () => CREDS, ImapClient: Cls, log: (m) => logs.push(String(m)) });
  await channel.pollOnce(); // resolve, не throw
  assert.equal(state.logouts, 0);
  const joined = logs.join('\n');
  assert.match(joined, /imap down/);
  assert.ok(!joined.includes('p4ssw0rd'), 'пароль не попадает в лог');
});

test('поллер: start запускает интервал (unref), stop останавливает; оба идемпотентны', async () => {
  const { db, store } = makeDb();
  const { Cls, state } = makeFakeImap([]);
  const channel = makeChannel({ db, store, config: () => CREDS, ImapClient: Cls, intervalMs: 5 });
  channel.start();
  channel.start(); // второй вызов — no-op
  assert.equal(channel._interval.hasRef?.(), false, 'таймер интервала unref');
  await new Promise((r) => setTimeout(r, 30));
  const afterRun = state.connects;
  assert.ok(afterRun >= 1, 'поллер тикает');
  channel.stop();
  channel.stop(); // идемпотентен
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.connects, afterRun, 'после stop тиков нет');
});

// ---- sendReply (фейк-transporter) ----

test('sendReply: to/from/text верные, In-Reply-To на последний message-id треда, исходящий id записан', async () => {
  const { db, store } = makeDb();
  const sent = [];
  const transporter = { sendMail: async (opts) => { sent.push(opts); return {}; } };
  const channel = makeChannel({ db, store, config: () => CREDS, transporter });
  const r = channel.processMessage(messageFromImap(MAIL_NEW));
  const thread = store.getThread(r.threadId).thread;
  const ok = await channel.sendReply(thread, { id: 'agent-1' }, 'Ответ агента');
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ivan@example.com');
  assert.equal(sent[0].from, 'support@test.example');
  assert.equal(sent[0].inReplyTo, 'abc123@example-sender.test');
  assert.equal(sent[0].text, 'Ответ агента');
  assert.match(sent[0].subject, /^Re: Не работает подключение/);
  // исходящий Message-ID записан: ответ клиента на него попадает в тот же тред
  const back = channel.processMessage(messageFromImap({
    uid: 8,
    envelope: { messageId: '<r2@x.test>', inReplyTo: sent[0].messageId, subject: 'Re: Re:', from: { value: [{ address: 'ivan@example.com' }] } },
    text: 'спасибо',
  }));
  assert.equal(back.status, 'appended');
  assert.equal(back.threadId, r.threadId);
});

test('sendReply: ошибка доставки → false и честное system-сообщение в тред', async () => {
  const { db, store } = makeDb();
  const transporter = { sendMail: async () => { throw new Error('relay denied'); } };
  const channel = makeChannel({ db, store, config: () => CREDS, transporter });
  const r = channel.processMessage(messageFromImap(MAIL_NEW));
  const ok = await channel.sendReply(store.getThread(r.threadId).thread, { id: 'a1' }, 'текст');
  assert.equal(ok, false);
  const messages = store.getThread(r.threadId).messages;
  const last = messages[messages.length - 1];
  assert.equal(last.author, 'system');
  assert.match(last.body, /relay denied/);
  assert.match(last.body, /ivan@example\.com/);
});

test('sendReply: канал не настроен → false, писем нет', async () => {
  const { db, store } = makeDb();
  const sent = [];
  const transporter = { sendMail: async (o) => { sent.push(o); } };
  const channel = makeChannel({ db, store, config: () => null, transporter });
  const thread = store.createThread({ channel: 'email', subject: 's', contact: { email: 'a@b.test' }, firstMessage: { author: 'contact', body: 'x' } });
  assert.equal(await channel.sendReply(thread, { id: 'a1' }, 'текст'), false);
  assert.equal(sent.length, 0);
});

// ---- testConnection ----

test('testConnection: оба канала живы → ok:true; SMTP-сбой виден честно', async () => {
  const { db, store } = makeDb();
  const good = makeChannel({
    db, store,
    config: () => CREDS,
    ImapClient: makeFakeImap([]).Cls,
    transporter: { verify: async () => true },
  });
  const goodResult = await good.testConnection();
  assert.equal(goodResult.ok, true);
  assert.equal(goodResult.imap.ok, true);
  assert.equal(goodResult.smtp.ok, true);

  const { db: db2, store: store2 } = makeDb();
  const bad = makeChannel({
    db: db2, store: store2, config: () => CREDS,
    ImapClient: makeFakeImap([], { failConnect: 'auth failed' }).Cls,
    transporter: { verify: async () => { throw new Error('relay refused'); } },
  });
  const badResult = await bad.testConnection();
  assert.equal(badResult.ok, false);
  assert.equal(badResult.imap.ok, false);
  assert.match(badResult.imap.error, /auth failed/);
  assert.equal(badResult.smtp.ok, false);
  assert.match(badResult.smtp.error, /relay refused/);
});

test('testConnection: канал не настроен → честная причина', async () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store });
  const r = await channel.testConnection();
  assert.equal(r.reason, 'not_configured');
  assert.equal(r.ok, false);
});

// ---- креды в hub_settings (AES-256-GCM от ENOT_SECRET_KEY) ----

const FULL = {
  imap: { host: 'imap.test', port: 993, tls: true, user: 'support', pass: 'p4ssw0rd' },
  smtp: { host: 'smtp.test', port: 465, tls: true, user: 'support', pass: 'smtp-pw', from: 'support@test.example' },
};

test('креды: round-trip шифрования — getEmail отдаёт пароль, в БД лежит только шифротекст', () => {
  const db = openHubDb(':memory:');
  const s = createSettingsStore(db, { secretKey: 'k'.repeat(32), nowMs: NOW });
  assert.ok(s.setEmail(FULL));
  const got = s.getEmail();
  assert.equal(got.imap.pass, 'p4ssw0rd');
  assert.equal(got.smtp.pass, 'smtp-pw');
  assert.equal(got.smtp.from, 'support@test.example');
  const raw = db.prepare("SELECT value FROM hub_settings WHERE key='email'").get().value;
  assert.ok(!raw.includes('p4ssw0rd'), 'imap-пароль не в открытом виде');
  assert.ok(!raw.includes('smtp-pw'), 'smtp-пароль не в открытом виде');
});

test('креды: без ENOT_SECRET_KEY включение честно отказывает (secret_key_missing)', () => {
  const db = openHubDb(':memory:');
  const s = createSettingsStore(db, { nowMs: NOW });
  assert.equal(s.setEmail(FULL), 'secret_key_missing');
  assert.equal(s.getEmail(), null);
});

test('креды: GET-маска — host/port/tls/user/from + hasPass, пароля нет', () => {
  const db = openHubDb(':memory:');
  const s = createSettingsStore(db, { secretKey: 'k'.repeat(32), nowMs: NOW });
  s.setEmail(FULL);
  const masked = s.getEmailSettings();
  assert.equal(masked.imap.host, 'imap.test');
  assert.equal(masked.imap.hasPass, true);
  assert.equal(masked.smtp.from, 'support@test.example');
  assert.equal(masked.smtp.hasPass, true);
  assert.equal('pass' in masked.imap, false);
  assert.equal('pass' in masked.smtp, false);
});

test('креды: валидация — мусорный host/port/from, пустой pass → invalid', () => {
  const db = openHubDb(':memory:');
  const s = createSettingsStore(db, { secretKey: 'k'.repeat(32), nowMs: NOW });
  const bad = (patch) => s.setEmail({
    imap: { ...FULL.imap, ...(patch.imap ?? {}) },
    smtp: { ...FULL.smtp, ...(patch.smtp ?? {}) },
  });
  assert.equal(bad({ imap: { host: 'не хост!' } }), 'invalid');
  assert.equal(bad({ imap: { port: 0 } }), 'invalid');
  assert.equal(bad({ imap: { port: 70000 } }), 'invalid');
  assert.equal(bad({ imap: { pass: '' } }), 'invalid'); // полные креды: без пароля канал не включается
  assert.equal(bad({ smtp: { from: 'не-адрес' } }), 'invalid');
  assert.equal(s.getEmail(), null);
});

test('креды: частичный патч — pass опущен, прежний сохраняется; host меняется', () => {
  const db = openHubDb(':memory:');
  const s = createSettingsStore(db, { secretKey: 'k'.repeat(32), nowMs: NOW });
  s.setEmail(FULL);
  const ok = s.setEmail({
    imap: { host: 'imap2.test', port: 993, tls: true, user: 'support', pass: '' },
    smtp: { host: 'smtp.test', port: 465, tls: true, user: 'support', pass: '', from: 'support@test.example' },
  });
  assert.ok(ok);
  const got = s.getEmail();
  assert.equal(got.imap.host, 'imap2.test');
  assert.equal(got.imap.pass, 'p4ssw0rd');
  assert.equal(got.smtp.pass, 'smtp-pw');
});

test('креды: смена ENOT_SECRET_KEY — getEmail честно null (канал выключен)', () => {
  const db = openHubDb(':memory:');
  const s1 = createSettingsStore(db, { secretKey: 'old'.repeat(11), nowMs: NOW });
  s1.setEmail(FULL);
  const s2 = createSettingsStore(db, { secretKey: 'new'.repeat(11), nowMs: NOW });
  assert.equal(s2.getEmail(), null);
});

// ---- цикл 3: REST /api/hub/settings/email, авто-ответ в email-треде ----

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../app.mjs';

function fakeEnotDesk(role = 'admin') {
  const user = () => ({ id: 'u1', login: 'op', name: 'Оператор', role, active: true });
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/auth/login') return Response.json({ token: 'upstream', user: user(), expiresAt: '2030-01-01T00:00:00.000Z' });
    if (path === '/api/v1/auth/me') return Response.json({ user: user() });
    return new Response(null, { status: 404 });
  };
}

async function startHub({ secretKey = 'k'.repeat(32), role = 'admin', imapCls, transporter, intervalMs } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'enotdesk-hub-email-'));
  const inst = createHub({
    dbPath: join(dir, 'hub.db'),
    port: 0,
    enotdeskUrl: 'http://enot.test',
    secretKey,
    enotFetch: fakeEnotDesk(role),
    emailImapClient: imapCls,
    emailTransporter: transporter,
    emailIntervalMs: intervalMs ?? 60_000,
  });
  const port = await inst.start();
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/hub/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'op', password: 'pw' }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('enot_hub_sid='))?.split(';')[0] ?? '';
  return {
    inst, base, cookie, db: inst.db,
    close: () => inst.close(),
    api: async (method, path, body) => {
      const r = await fetch(`${base}/api/hub${path}`, {
        method,
        headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
}

test('REST: аноним → 401, оператор → 403, админ → 200', async () => {
  const admin = await startHub({ role: 'admin' });
  try {
    const anon = await fetch(`${admin.base}/api/hub/settings/email`);
    assert.equal(anon.status, 401);
    assert.equal((await admin.api('GET', '/settings/email')).status, 200);
    const operator = await startHub({ role: 'operator' });
    try {
      assert.equal((await operator.api('GET', '/settings/email')).status, 403);
    } finally { await operator.close(); }
    const empty = await admin.api('GET', '/settings/email');
    assert.equal(empty.body.settings, null);
    assert.equal(empty.body.enabled, false);
  } finally { await admin.close(); }
});

test('REST: POST валидных кредов → enabled:true, паролей в ответе нет, в БД шифротекст', async () => {
  const hub = await startHub();
  try {
    const r = await hub.api('POST', '/settings/email', FULL);
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.settings.imap.hasPass, true);
    assert.equal(JSON.stringify(r.body).includes('p4ssw0rd'), false, 'пароль не возвращается');
    assert.equal(JSON.stringify(r.body).includes('smtp-pw'), false);
    const raw = hub.db.prepare("SELECT value FROM hub_settings WHERE key='email'").get().value;
    assert.ok(!raw.includes('p4ssw0rd'));
    const after = await hub.api('GET', '/settings/email');
    assert.equal(after.body.enabled, true);
  } finally { await hub.close(); }
});

test('REST: мусор в кредах → 400 bad_request; без ENOT_SECRET_KEY → 400 secret_key_missing', async () => {
  const hub = await startHub();
  try {
    const bad = await hub.api('POST', '/settings/email', {
      imap: { ...FULL.imap, host: 'не хост' },
      smtp: FULL.smtp,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');
  } finally { await hub.close(); }

  const noKey = await startHub({ secretKey: '' });
  try {
    const r = await noKey.api('POST', '/settings/email', FULL);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'secret_key_missing');
  } finally { await noKey.close(); }
});

test('REST: DELETE выключает канал — enabled:false, креды стёрты', async () => {
  const hub = await startHub();
  try {
    assert.equal((await hub.api('POST', '/settings/email', FULL)).status, 200);
    const del = await hub.api('DELETE', '/settings/email');
    assert.equal(del.status, 200);
    assert.equal(del.body.enabled, false);
    const after = await hub.api('GET', '/settings/email');
    assert.equal(after.body.settings, null);
    assert.equal(after.body.enabled, false);
  } finally { await hub.close(); }
});

test('REST: POST /test — проверка связи на фейках, lastTest сохранён', async () => {
  const { Cls } = makeFakeImap([]);
  const hub = await startHub({ imapCls: Cls, transporter: { verify: async () => true } });
  try {
    const before = await hub.api('POST', '/settings/email/test', {});
    assert.equal(before.status, 400); // канал ещё не настроен
    await hub.api('POST', '/settings/email', FULL);
    const r = await hub.api('POST', '/settings/email/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.result.ok, true);
    const after = await hub.api('GET', '/settings/email');
    assert.equal(after.body.lastTest?.ok, true);
  } finally { await hub.close(); }
});

test('авто-ответ: агент-текст в email-треде уходит по SMTP; note и чужие каналы — нет', async () => {
  const sent = [];
  const transporter = { sendMail: async (o) => { sent.push(o); } };
  const hub = await startHub({ transporter });
  try {
    await hub.api('POST', '/settings/email', FULL);
    const { createThreadsStore } = await import('../threads.mjs');
    const store = createThreadsStore(hub.db, { nowMs: () => Date.now() });
    const thread = store.createThread({
      channel: 'email',
      subject: 'Тикет из письма',
      contact: { email: 'client@example.com' },
      firstMessage: { author: 'contact', body: 'помогите' },
    });
    const sent1 = await hub.api('POST', `/threads/${thread.id}/messages`, { text: 'Ответ агента' });
    assert.equal(sent1.status, 201);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'client@example.com');
    assert.equal(sent[0].from, 'support@test.example');
    assert.equal(sent[0].text, 'Ответ агента');
    // note клиенту не уходит
    await hub.api('POST', `/threads/${thread.id}/messages`, { text: 'внутренняя заметка', note: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
    // chat-тред — не email, SMTP не трогаем
    const chat = store.createThread({ channel: 'chat', subject: 'чат', firstMessage: { author: 'contact', body: 'x' } });
    await hub.api('POST', `/threads/${chat.id}/messages`, { text: 'ответ в чате' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent.length, 1);
  } finally { await hub.close(); }
});

// ---- цикл 4: UI-контракты админ-формы email-канала ----

import ruDict from '../../client/locales/ru.mjs';
import enDict from '../../client/locales/en.mjs';

test('UI: секция email-канала — скрыта, поля есть, пароли type=password, кнопки подключены', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const js = readFileSync(join(import.meta.dirname, '..', 'web', 'app.mjs'), 'utf8');
  const section = /<section id="hub-email-admin" class="card hidden">/.test(html);
  assert.ok(section, 'секция hub-email-admin есть и скрыта по умолчанию');
  for (const id of ['hub-email-imap-host', 'hub-email-imap-port', 'hub-email-imap-tls', 'hub-email-imap-user',
    'hub-email-smtp-host', 'hub-email-smtp-port', 'hub-email-smtp-tls', 'hub-email-smtp-user', 'hub-email-from']) {
    assert.ok(html.includes(`id="${id}"`), `поле ${id} есть в разметке`);
  }
  for (const id of ['hub-email-imap-pass', 'hub-email-smtp-pass']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*type="password"`), `${id} — type=password`);
  }
  for (const id of ['hub-email-save', 'hub-email-test', 'hub-email-disable']) {
    assert.ok(html.includes(`id="${id}"`), `кнопка ${id} есть`);
    assert.ok(new RegExp(`\\$\\('${id}'\\)`).test(js), `кнопка ${id} подключена в app.mjs`);
  }
  // admin-блок показывает секцию и грузит настройки
  assert.ok(js.includes("show($('hub-email-admin'))"), 'секция показывается только админу');
});

test('UI: все ключи hub.email.* из разметки и t() есть в обоих словарях', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const js = readFileSync(join(import.meta.dirname, '..', 'web', 'app.mjs'), 'utf8');
  const keys = new Set([
    ...[...html.matchAll(/data-i18n(?:-placeholder)?="(hub\.email[^"]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/\bt\('(hub\.email[^']+)'/g)].map((m) => m[1]),
  ]);
  assert.ok(keys.size >= 15, `набор ключей email не пуст (найдено ${keys.size})`);
  for (const key of keys) {
    assert.ok(key in ruDict, `${key} нет в ru`);
    assert.ok(key in enDict, `${key} нет в en`);
  }
});

// ---- дозапрос: петля автоответов, log сбоя автоответа, миграция v5 ----

import { SCHEMA_VERSION } from '../db.mjs';

test('петля: своё письмо с Auto-Submitted → skipped, тикета нет, повтор — duplicate', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store, config: () => CREDS }); // smtp.from = support@test.example
  const selfMail = {
    uid: 20,
    envelope: { messageId: '<self1@x.test>', subject: 'auto reply', from: { value: [{ address: 'support@test.example' }] } },
    headers: { 'auto-submitted': 'auto-generated' },
    text: 'автоматический ответ',
  };
  const r = channel.processMessage(messageFromImap(selfMail));
  assert.equal(r.status, 'skipped');
  assert.equal(store.listThreads({ channel: 'email' }).total, 0);
  assert.equal(channel.processMessage(messageFromImap(selfMail)).status, 'duplicate'); // помечен виденным
  // imap.user тоже считается своим адресом
  const viaUser = channel.processMessage(messageFromImap({
    uid: 21,
    envelope: { messageId: '<self2@x.test>', subject: 'bounce', from: { value: [{ address: 'SUPPORT@test.example' }] } },
    headers: { 'auto-submitted': 'auto-replied' },
    text: 'маилер-демон',
  }));
  assert.equal(viaUser.status, 'skipped');
  assert.equal(store.listThreads({ channel: 'email' }).total, 0);
});

test('петля: от себя без Auto-Submitted или с "no" — тикет создаётся (не петля)', () => {
  const { db, store } = makeDb();
  const channel = makeChannel({ db, store, config: () => CREDS });
  const forwarded = channel.processMessage(messageFromImap({
    uid: 22,
    envelope: { messageId: '<fwd@x.test>', subject: 'пересылка себе', from: { value: [{ address: 'support@test.example' }] } },
    text: 'человек переслал письмо сам себе',
  }));
  assert.equal(forwarded.status, 'created');
  const explicitNo = channel.processMessage(messageFromImap({
    uid: 23,
    envelope: { messageId: '<no@x.test>', subject: 'вручную', from: { value: [{ address: 'support@test.example' }] } },
    headers: { 'auto-submitted': 'no' },
    text: 'auto-submitted: no — автор человек',
  }));
  assert.equal(explicitNo.status, 'created');
});

test('авто-ответ: сбой отправки не роняет REST и попадает в log', async () => {
  const hub = await startHub({ transporter: async () => { throw new Error('boom-transport'); } });
  try {
    await hub.api('POST', '/settings/email', FULL);
    const { createThreadsStore } = await import('../threads.mjs');
    const store = createThreadsStore(hub.db, { nowMs: () => Date.now() });
    const thread = store.createThread({
      channel: 'email', subject: 's', contact: { email: 'client@example.com' }, firstMessage: { author: 'contact', body: 'x' },
    });
    const errors = [];
    const orig = console.error;
    console.error = (m) => errors.push(String(m));
    let status;
    try {
      status = (await hub.api('POST', `/threads/${thread.id}/messages`, { text: 'ответ' })).status;
    } finally {
      console.error = orig;
    }
    assert.equal(status, 201); // сбой доставки не ломает ответ REST
    assert.ok(errors.some((m) => m.includes('автоответ') && m.includes('boom-transport')), 'сбой автоответа в log');
  } finally { await hub.close(); }
});

test('миграция v5: email_seen поднимается openHubDb, SCHEMA_VERSION = 5', () => {
  const db = openHubDb(':memory:');
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_seen'").get();
  assert.ok(table, 'таблица email_seen есть после миграций');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='email_seen_thread'").get();
  assert.ok(idx, 'индекс email_seen_thread есть');
  assert.equal(SCHEMA_VERSION, 5);
});

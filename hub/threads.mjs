import crypto from 'node:crypto';

// Тикеты хаба (T02): контакты, треды, сообщения, canned-ответы, присутствие.
// Наружу отдаются только sanitized-объекты: тексты и теги проходят allowlist
// с жёсткими пределами (как контакты/инвентарь в server/), мусор отбрасывается.
// SQL спрятан здесь; REST-слой (hub/app.mjs) знает только store.

// Пределы санитизации: тексты сообщений ≤8000 символов (как notes контактов
// сервера, но просторнее для переписки), теги ≤10×30 — лимиты сервера.
export const THREAD_LIMITS = {
  subject: 200,
  body: 8000,
  tags: 10,
  tag: 30,
  contactName: 120,
  email: 200,
  visitorId: 128,
  assignee: 120,
  cannedText: 2000,
  shortcut: 40,
};

const CHANNELS = ['chat', 'email', 'manual'];
const STATUSES = ['open', 'pending', 'resolved'];
const AUTHORS = ['contact', 'agent', 'system'];
const MESSAGE_TYPES = ['text', 'card', 'note'];
const PRESENCE = ['online', 'away', 'offline'];

// Теги: массив непустых строк 1..30, ≤10 штук; длиннее 30 — весь патч невалиден
// (молчаливая обрезка перепрятала бы смысл тега); не массив / мусор — null.
export function sanitizeTags(value) {
  if (!Array.isArray(value) || value.length > THREAD_LIMITS.tags) return null;
  const out = [];
  for (const t of value) {
    if (typeof t !== 'string' || t.length > THREAD_LIMITS.tag) return null;
    const s = t.trim();
    if (!s) return null;
    out.push(s);
  }
  return out;
}

// Текст (сообщение/тема/тело canned): строка → трим + потолок; иначе null.
export function sanitizeText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  return s.slice(0, max);
}

export function sanitizeEmail(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, THREAD_LIMITS.email);
  // грубый allowlist: локал@домен, без пробелов; полное рукопожатие — не задача хаба
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

// Шорткат canned: без '#' и пробелов (символ '#' на кнопке дописывает UI).
export function sanitizeShortcut(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/^#+/, '').slice(0, THREAD_LIMITS.shortcut);
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

function storedTags(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function createThreadsStore(db, { nowMs = Date.now } = {}) {
  const nowIso = () => new Date(nowMs()).toISOString();

  function threadRow(id) {
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) || null;
  }

  function contactRow(id) {
    return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) || null;
  }

  function outContact(row) {
    if (!row) return null;
    return { id: row.id, visitorId: row.visitor_id, email: row.email, name: row.name, createdAt: row.created_at };
  }

  function outMessage(row) {
    return {
      id: row.id,
      threadId: row.thread_id,
      author: row.author,
      type: row.type,
      body: row.body,
      agentId: row.agent_id,
      createdAt: row.created_at,
    };
  }

  function outThread(row) {
    if (!row) return null;
    const contact = row.contact_id ? contactRow(row.contact_id) : null;
    const count = db.prepare('SELECT count(*) c FROM messages WHERE thread_id = ?').get(row.id).c;
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      subject: row.subject,
      contact: outContact(contact),
      assigneeId: row.assignee_id,
      tags: storedTags(row.tags),
      rating: row.rating,
      messageCount: count,
      lastActivityAt: row.last_activity_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listMessages(threadId) {
    // tiebreak по rowid: created_at имеет точность до мс, порядок вставки честнее UUID
    return db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid')
      .all(threadId).map(outMessage);
  }

  // Контакты: тем же visitor_id (или тем же email) — одна строка, история общая.
  function ensureContact({ visitorId = null, email = null, name = null } = {}) {
    let row = null;
    if (visitorId) {
      row = db.prepare('SELECT * FROM contacts WHERE visitor_id = ?').get(visitorId) || null;
    }
    if (!row && email) {
      row = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) || null;
    }
    if (row) {
      // дополняем пустые поля, если пришли (visitor пришёл позже email-контакта)
      db.prepare('UPDATE contacts SET visitor_id = COALESCE(visitor_id, ?), name = COALESCE(name, ?) WHERE id = ?')
        .run(visitorId, name, row.id);
      return contactRow(row.id);
    }
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO contacts (id, visitor_id, email, name, created_at) VALUES (?,?,?,?,?)')
      .run(id, visitorId, email, name, nowIso());
    return contactRow(id);
  }

  // Создание треда (чат/email/ручной тикет). contact — уже sanitized-поля;
  // firstMessage — первое сообщение треда (автор contact для ручного тикета);
  // всё проверяется до INSERT — мусор не оставляет полупустых строк.
  function createThread({ channel, subject, contact = null, tags = null, firstMessage = null }) {
    if (!CHANNELS.includes(channel)) return null;
    const subj = sanitizeText(subject, THREAD_LIMITS.subject);
    if (!subj) return null;
    const tagsOut = sanitizeTags(tags ?? []);
    if (tagsOut === null) return null;
    if (firstMessage) {
      const probe = checkMessage(firstMessage);
      if (probe === null) return null;
    }
    let contactRowId = null;
    if (contact && (contact.visitorId || contact.email || contact.name)) {
      const row = ensureContact({
        visitorId: contact.visitorId ?? null,
        email: contact.email ?? null,
        name: contact.name ?? null,
      });
      contactRowId = row.id;
    }
    const id = crypto.randomUUID();
    const at = nowIso();
    db.prepare(`INSERT INTO threads (id, channel, status, subject, contact_id, assignee_id, tags, rating, last_activity_at, created_at, updated_at)
                VALUES (?,?, 'open', ?,?,NULL,?,NULL,?,?,?)`)
      .run(id, channel, subj, contactRowId, JSON.stringify(tagsOut), at, at, at);
    if (firstMessage) appendMessage(id, firstMessage);
    return outThread(threadRow(id));
  }

  // Инбокс: фильтры статус/канал/тег/assignee/поиск (тема + контакт), пагинация.
  function listThreads(filters = {}) {
    const where = [];
    const args = [];
    if (filters.status) { where.push('t.status = ?'); args.push(filters.status); }
    if (filters.channel) { where.push('t.channel = ?'); args.push(filters.channel); }
    if (filters.assigneeId === null) { where.push('t.assignee_id IS NULL'); }
    else if (filters.assigneeId) { where.push('t.assignee_id = ?'); args.push(filters.assigneeId); }
    if (filters.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(t.tags) je WHERE je.value = ?)');
      args.push(filters.tag);
    }
    if (filters.q) {
      const like = `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(t.subject LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')");
      args.push(like, like, like);
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // кламп пагинации только здесь (ревью T02): REST парсит, мусор/NaN/границы — дефолты
    let limit = Number.isInteger(filters.limit) ? filters.limit : 50;
    limit = Math.min(Math.max(limit, 1), 100);
    let offset = Number.isInteger(filters.offset) && filters.offset > 0 ? filters.offset : 0;
    const items = db.prepare(`
      SELECT t.* FROM threads t LEFT JOIN contacts c ON c.id = t.contact_id
      ${cond} ORDER BY t.last_activity_at DESC, t.id DESC LIMIT ? OFFSET ?
    `).all(...args, limit, offset).map(outThread);
    const total = db.prepare(`
      SELECT count(*) c FROM threads t LEFT JOIN contacts c ON c.id = t.contact_id ${cond}
    `).get(...args).c;
    return { items, total };
  }

  // Правка треда: статус/assignee/теги. null — треда нет; 'invalid' — мусор.
  function updateThread(id, patch = {}) {
    const row = threadRow(id);
    if (!row) return null;
    const sets = [];
    const args = [];
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status)) return 'invalid';
      sets.push('status = ?');
      args.push(patch.status);
    }
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId !== null && (typeof patch.assigneeId !== 'string' || !patch.assigneeId.trim() || patch.assigneeId.length > THREAD_LIMITS.assignee)) return 'invalid';
      sets.push('assignee_id = ?');
      args.push(patch.assigneeId ? patch.assigneeId : null);
    }
    if (patch.tags !== undefined) {
      const tags = sanitizeTags(patch.tags);
      if (tags === null) return 'invalid';
      sets.push('tags = ?');
      args.push(JSON.stringify(tags));
    }
    if (!sets.length) return outThread(row);
    db.prepare(`UPDATE threads SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...args, nowIso(), id);
    return outThread(threadRow(id));
  }

  // Оценка чата (1..5); null снимает. Ставит контакт (виджет — T03).
  function setRating(id, rating) {
    const row = threadRow(id);
    if (!row) return null;
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return 'invalid';
    const at = nowIso();
    db.prepare('UPDATE threads SET rating = ?, updated_at = ? WHERE id = ?').run(rating, at, id);
    return outThread(threadRow(id));
  }

  // Проверка сообщения без записи (шов для createThread с firstMessage).
  function checkMessage({ author, type = 'text', body, agentId = null }) {
    if (!AUTHORS.includes(author)) return null;
    if (!MESSAGE_TYPES.includes(type)) return null;
    const text = sanitizeText(body, THREAD_LIMITS.body);
    if (!text) return null;
    if (type === 'card') {
      // карточка несёт JSON-структуру (карточка «Подключиться» — T05):
      // битый JSON не проходит запись, а не ждёт разбора на UI
      try { JSON.parse(text); } catch { return null; }
    }
    if (agentId !== null && (typeof agentId !== 'string' || !agentId || agentId.length > THREAD_LIMITS.assignee)) return null;
    return { author, type, text, agentId };
  }

  // Сообщение треда; type 'card' несёт JSON-строку в body (карточка «Подключиться» — T05).
  function appendMessage(threadId, spec) {
    const check = checkMessage(spec);
    if (!check) return null;
    const row = threadRow(threadId);
    if (!row) return null;
    const id = crypto.randomUUID();
    const at = nowIso();
    db.prepare('INSERT INTO messages (id, thread_id, author, type, body, agent_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, threadId, check.author, check.type, check.text, check.agentId, at);
    db.prepare('UPDATE threads SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(at, at, threadId);
    return outMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  function getThread(id) {
    const row = threadRow(id);
    if (!row) return null;
    return { thread: outThread(row), messages: listMessages(id) };
  }

  // ---- canned-ответы ----

  function outCanned(row) {
    return { id: row.id, scope: row.scope, shortcut: row.shortcut, text: row.text, agentId: row.agent_id, createdAt: row.created_at };
  }

  // Свои приватные + общие. agentId обязателен (REST берёт из hub-сессии).
  function listCanned(agentId) {
    return db.prepare('SELECT * FROM canned WHERE scope = \'shared\' OR agent_id = ? ORDER BY shortcut')
      .all(agentId).map(outCanned);
  }

  // null — мусор или не найден тред... для canned: 'invalid' — мусор, 'duplicate' — шорткат занят.
  function createCanned({ scope, shortcut, text, agentId = null }) {
    if (scope !== 'private' && scope !== 'shared') return 'invalid';
    if (scope === 'private' && (typeof agentId !== 'string' || !agentId)) return 'invalid';
    if (scope === 'shared') agentId = null;
    const sh = sanitizeShortcut(shortcut);
    if (!sh) return 'invalid';
    const body = sanitizeText(text, THREAD_LIMITS.cannedText);
    if (!body) return 'invalid';
    const dup = scope === 'shared'
      ? db.prepare('SELECT id FROM canned WHERE scope = \'shared\' AND shortcut = ?').get(sh)
      : db.prepare('SELECT id FROM canned WHERE scope = \'private\' AND shortcut = ? AND agent_id = ?').get(sh, agentId);
    if (dup) return 'duplicate';
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO canned (id, scope, shortcut, text, agent_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, scope, sh, body, agentId, nowIso());
    return outCanned(db.prepare('SELECT * FROM canned WHERE id = ?').get(id));
  }

  // Удалять можно свои приватные; общие — любой агент консоли (operator/admin).
  function deleteCanned(id, agentId) {
    return db.prepare("DELETE FROM canned WHERE id = ? AND (scope = 'shared' OR agent_id = ?)")
      .run(id, agentId).changes === 1;
  }

  // ---- швы виджета (T03): история по visitor_id и факт согласия ----

  // Свежий тред контакта в канале: виджет переиспользует открытый чат-тред,
  // resolved открывает новый (после rating-виджета).
  function latestContactThread(contactId, channel) {
    if (!contactId || !CHANNELS.includes(channel)) return null;
    const row = db.prepare(`
      SELECT * FROM threads WHERE contact_id = ? AND channel = ?
      ORDER BY last_activity_at DESC, id DESC LIMIT 1
    `).get(contactId, channel);
    return row ? outThread(row) : null;
  }

  // Последние треды контакта (визит-история, ≤limit): наружные объекты без сообщений.
  function listContactThreads(contactId, limit = 20) {
    if (!contactId) return [];
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20;
    return db.prepare(`
      SELECT * FROM threads WHERE contact_id = ?
      ORDER BY last_activity_at DESC, id DESC LIMIT ?
    `).all(contactId, n).map(outThread);
  }

  // GDPR-факт: когда посетитель согласился (строка ISO или null).
  function setConsentAt(contactId, atIso) {
    if (!contactId) return;
    db.prepare('UPDATE contacts SET consent_at = ? WHERE id = ?').run(atIso, contactId);
  }

  function getContactByVisitor(visitorId) {
    if (!visitorId) return null;
    const row = db.prepare('SELECT * FROM contacts WHERE visitor_id = ?').get(visitorId);
    return row ? outContact(row) : null;
  }

  // ---- присутствие агентов ----

  function setPresence(agentId, status) {
    if (!PRESENCE.includes(status)) return false;
    db.prepare(`INSERT INTO agent_presence (agent_id, status, updated_at) VALUES (?,?,?)
                ON CONFLICT(agent_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
      .run(agentId, status, nowIso());
    return true;
  }

  function getPresence(agentId) {
    const row = db.prepare('SELECT * FROM agent_presence WHERE agent_id = ?').get(agentId);
    return row ? { agentId: row.agent_id, status: row.status, updatedAt: row.updated_at } : null;
  }

  function listPresence() {
    return db.prepare('SELECT * FROM agent_presence ORDER BY agent_id')
      .all().map((row) => ({ agentId: row.agent_id, status: row.status, updatedAt: row.updated_at }));
  }

  return {
    createThread, getThread, listThreads, updateThread, setRating,
    listMessages, appendMessage,
    listCanned, createCanned, deleteCanned,
    setPresence, getPresence, listPresence,
    latestContactThread, listContactThreads, setConsentAt, getContactByVisitor,
    ensureContact,
  };
}

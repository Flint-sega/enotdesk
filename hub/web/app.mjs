// Консоль EnotDesk Hub (T02): SSO-логин, инбокс тредов, детали, canned-подсказки.
// Токенов здесь нет — cookie HttpOnly, каждый запрос проверяет RBAC на сервере.
// Тексты — только из словарей (data-i18n в разметке, t() в JS); кириллических
// литералов в этом модуле нет — это проверяет контракт-тест.
import { t, initLocale, setLocale, getLocale } from './lib/i18n.mjs';

const root = document.getElementById('hub-root');
const pageState = root?.dataset.state ?? 'login';
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 25;
const CANNED_MAX = 8;

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

async function api(method, path, body) {
  const res = await fetch(`/api/hub${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function applyI18n() {
  document.documentElement.lang = getLocale();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

function setTitle(key, vars) {
  document.title = t(key, vars);
}

// ---- состояние инбокса ----

const filters = { status: '', channel: '', tag: '', q: '', limit: PAGE_SIZE, offset: 0 };
let inboxTotal = 0;
let inboxItems = [];
let currentThread = null;
let me = null;
let cannedCache = null;

// ---- инбокс ----

function contactLabel(th) {
  const c = th.contact;
  if (!c) return '';
  return c.name || c.email || '';
}

function assigneeLabel(th) {
  if (!th.assigneeId) return t('hub.inbox.unassigned');
  if (me && th.assigneeId === me.id) return t('hub.thread.you');
  return th.assigneeId;
}

function threadRow(th) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = th.id;
  row.setAttribute('role', 'button');
  const col = document.createElement('div');
  col.className = 'col';
  const subjectLine = document.createElement('div');
  subjectLine.className = 'subject';
  subjectLine.appendChild(document.createTextNode(th.subject));
  subjectLine.appendChild(chip(`hub.status.${th.status}`, `chip ${th.status}`));
  subjectLine.appendChild(chip(`hub.channel.${th.channel}`));
  col.appendChild(subjectLine);
  const sub = document.createElement('div');
  sub.className = 'sub';
  const parts = [contactLabel(th), assigneeLabel(th)].filter(Boolean);
  sub.textContent = parts.join(' · ');
  col.appendChild(sub);
  row.appendChild(col);
  const side = document.createElement('div');
  side.className = 'side';
  const when = th.lastActivityAt ? new Date(th.lastActivityAt) : null;
  side.textContent = `${th.messageCount} · ${when && !Number.isNaN(when.valueOf()) ? when.toLocaleString(getLocale()) : ''}`;
  row.appendChild(side);
  return row;
}

function chip(key, cls = 'chip') {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = t(key);
  return span;
}

function renderInbox() {
  const list = $('hub-list');
  list.textContent = '';
  for (const t of inboxItems) list.appendChild(threadRow(t));
  const emptyEl = $('hub-list-empty');
  const filtered = filters.status || filters.channel || filters.tag || filters.q;
  emptyEl.textContent = filtered ? t('hub.inbox.emptyFiltered') : t('hub.inbox.empty');
  (inboxItems.length ? hide : show)(emptyEl);
  $('hub-page-prev').disabled = filters.offset === 0;
  $('hub-page-next').disabled = filters.offset + PAGE_SIZE >= inboxTotal;
  $('hub-page-info').textContent = t('common.pageOf', {
    page: Math.floor(filters.offset / PAGE_SIZE) + 1,
    total: inboxTotal,
  });
}

async function loadInbox() {
  const params = new URLSearchParams();
  for (const key of ['status', 'channel', 'tag', 'q', 'limit', 'offset']) {
    if (filters[key] !== '' && filters[key] !== undefined) params.set(key, filters[key]);
  }
  const res = await api('GET', `/threads?${params}`);
  if (res.status !== 200) {
    $('hub-list-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
    return;
  }
  $('hub-list-error').textContent = '';
  inboxItems = res.body?.items ?? [];
  inboxTotal = res.body?.total ?? 0;
  renderInbox();
}

function readFilters() {
  filters.status = $('hub-f-status').value;
  filters.channel = $('hub-f-channel').value;
  filters.tag = $('hub-f-tag').value.trim();
  filters.q = $('hub-f-search').value.trim();
  filters.offset = 0;
}

function resetFilters() {
  $('hub-f-status').value = '';
  $('hub-f-channel').value = '';
  $('hub-f-tag').value = '';
  $('hub-f-search').value = '';
  readFilters();
}

// ---- детали треда ----

function setThreadStatusLine(t) {
  const chipEl = $('hub-thread-status');
  chipEl.textContent = t(`hub.status.${t.status}`);
  chipEl.className = `chip ${t.status}`;
  $('hub-thread-channel').textContent = t(`hub.channel.${t.channel}`);
  $('hub-thread-assignee').textContent = t.assigneeId
    ? t('hub.thread.assignedTo', { name: t.assigneeId === me?.id ? t('hub.thread.you') : t.assigneeId })
    : t('hub.inbox.unassigned');
  $('hub-thread-rating').textContent = t.rating
    ? t('hub.thread.rating', { value: t.rating })
    : t('hub.thread.noRating');
  $('hub-thread-take').textContent = t.assigneeId && t.assigneeId === me?.id
    ? t('hub.thread.release')
    : t('hub.thread.takeIt');
}

function renderTags(t) {
  const box = $('hub-thread-taglist');
  box.textContent = '';
  for (const tag of t.tags ?? []) {
    const chipEl = document.createElement('span');
    chipEl.className = 'tag';
    chipEl.appendChild(document.createTextNode(tag));
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', t('hub.thread.removeTag', { tag }));
    x.dataset.tag = tag;
    chipEl.appendChild(x);
    box.appendChild(chipEl);
  }
}

function messageBubble(m) {
  const el = document.createElement('div');
  el.className = `bubble ${m.author}${m.type === 'note' ? ' note' : ''}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = t(`hub.msg.from${m.author[0].toUpperCase()}${m.author.slice(1)}`);
  if (m.type === 'note' || m.type === 'card') {
    const badge = document.createElement('span');
    badge.className = 'badgeword';
    badge.textContent = t(m.type === 'note' ? 'hub.msg.noteBadge' : 'hub.msg.cardBadge');
    who.appendChild(badge);
  }
  el.appendChild(who);
  if (m.type === 'card') {
    // карточка «Подключиться» (T05) пока показывается честной заглушкой с JSON
    const pre = document.createElement('code');
    pre.textContent = m.body;
    el.appendChild(pre);
  } else {
    el.appendChild(document.createTextNode(m.body));
  }
  return el;
}

function renderMessages(messages) {
  const box = $('hub-msgs');
  box.textContent = '';
  for (const m of messages) box.appendChild(messageBubble(m));
}

async function openThread(id) {
  const res = await api('GET', `/threads/${encodeURIComponent(id)}`);
  if (res.status !== 200) {
    $('hub-thread-error').textContent = t('hub.thread.notFound');
    showThreadView();
    return;
  }
  currentThread = res.body?.thread ?? null;
  hide($('hub-thread-error'));
  clearUnread(currentThread?.id);
  $('hub-thread-subject').textContent = currentThread?.subject ?? '';
  setThreadStatusLine(currentThread);
  renderTags(currentThread);
  renderMessages(res.body?.messages ?? []);
  showThreadView();
  hideCannedPop();
}

function showInboxView() {
  show($('hub-inbox'));
  hide($('hub-thread'));
  hide($('hub-new'));
  void loadInbox();
}

function showThreadView() {
  hide($('hub-inbox'));
  show($('hub-thread'));
  hide($('hub-new'));
}

function showNewView() {
  hide($('hub-inbox'));
  hide($('hub-thread'));
  show($('hub-new'));
  $('hub-new-error').textContent = '';
  $('hub-new-subject').focus();
}

// ---- canned-подсказки (#) ----

async function loadCanned() {
  const res = await api('GET', '/canned');
  cannedCache = res.status === 200 ? (res.body?.items ?? []) : [];
  return cannedCache;
}

function hideCannedPop() {
  hide($('hub-canned-pop'));
  $('hub-canned-pop').textContent = '';
}

function cannedToken(text) {
  const m = /(?:^|\s)#([A-Za-z0-9_-]*)$/.exec(text);
  return m ? m[1] : null;
}

function renderCannedPop(items, token) {
  const pop = $('hub-canned-pop');
  pop.textContent = '';
  if (!items.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = t('hub.canned.empty');
    pop.appendChild(none);
  } else {
    for (const item of items.slice(0, CANNED_MAX)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.shortcut = item.shortcut;
      btn.textContent = `#${item.shortcut} — ${item.text.slice(0, 80)}`;
      pop.appendChild(btn);
    }
  }
  show(pop);
  return token;
}

async function updateCannedPop() {
  const input = $('hub-reply');
  const token = cannedToken(input.value);
  if (token === null) { hideCannedPop(); return; }
  const items = (await loadCanned()).filter((c) => c.shortcut.startsWith(token));
  renderCannedPop(items, token);
}

function applyCanned(shortcut) {
  const items = cannedCache ?? [];
  const item = items.find((c) => c.shortcut === shortcut);
  if (!item) { hideCannedPop(); return; }
  const input = $('hub-reply');
  input.value = input.value.replace(/#[A-Za-z0-9_-]*$/, item.text);
  hideCannedPop();
  input.focus();
}

// ---- presence ----

async function loadPresence() {
  const res = await api('GET', '/presence');
  const items = res.status === 200 ? (res.body?.items ?? []) : [];
  const mine = me ? items.find((p) => p.agentId === me.id) : null;
  if (mine) $('hub-presence').value = mine.status;
}

async function savePresence() {
  $('hub-presence-error').textContent = '';
  const res = await api('PUT', '/presence', { status: $('hub-presence').value });
  if (res.status !== 200) {
    $('hub-presence-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
    void loadPresence(); // честный откат на серверное значение
  }
}

// ---- тикет ----

async function patchThread(patch) {
  if (!currentThread) return null;
  const res = await api('PATCH', `/threads/${encodeURIComponent(currentThread.id)}`, patch);
  if (res.status === 200 && res.body?.thread) {
    currentThread = res.body.thread;
    setThreadStatusLine(currentThread);
    renderTags(currentThread);
  }
  return res;
}

// кнопки статуса (R02.1): успех гасит ошибку, отказ показывает её честно
async function setThreadStatus(status) {
  const res = await patchThread({ status });
  if (res && res.status !== 200) $('hub-thread-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
  else hide($('hub-thread-error'));
}

async function sendReply(asNote) {
  const input = $('hub-reply');
  const btn = $('hub-reply-send');
  const text = input.value.trim();
  if (!text || !currentThread) return;
  btn.disabled = true;
  try {
    const res = await api('POST', `/threads/${encodeURIComponent(currentThread.id)}/messages`, { text, note: asNote === true });
    if (res.status !== 201) {
      $('hub-thread-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
      return;
    }
    hide($('hub-thread-error'));
    input.value = '';
    hideCannedPop();
    await openThread(currentThread.id);
  } finally {
    btn.disabled = false;
  }
}

async function saveCanned() {
  const text = $('hub-reply').value.trim();
  if (!text) return;
  const shortcut = window.prompt(t('hub.canned.prompt'));
  if (shortcut === null) return; // отмена
  const res = await api('POST', '/canned', { shortcut: shortcut.trim(), text });
  if (res.status === 409) $('hub-thread-error').textContent = t('hub.canned.dup');
  else if (res.status !== 201) $('hub-thread-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
  else {
    hide($('hub-thread-error'));
    cannedCache = null; // обновится при следующем #
  }
}

async function submitNewTicket(e) {
  e.preventDefault();
  const btn = $('hub-new-submit');
  const contact = {};
  const name = $('hub-new-name').value.trim();
  const email = $('hub-new-email').value.trim();
  if (name) contact.name = name;
  if (email) contact.email = email;
  btn.disabled = true;
  try {
    const res = await api('POST', '/threads', {
      subject: $('hub-new-subject').value,
      text: $('hub-new-text').value,
      contact: Object.keys(contact).length ? contact : undefined,
    });
    if (res.status !== 201) {
      $('hub-new-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
      return;
    }
    $('hub-new-subject').value = '';
    $('hub-new-text').value = '';
    $('hub-new-name').value = '';
    $('hub-new-email').value = '';
    resetFilters();
    showInboxView();
  } finally {
    btn.disabled = false;
  }
}

// ---- live-канал консоли (/ws/console): new-message/typing/presence (T03) ----

let sock = null;
let sockRetryMs = 3000;
const unread = new Map(); // threadId → счётчик непрочитанных от клиента

function markUnread(threadId) {
  unread.set(threadId, (unread.get(threadId) ?? 0) + 1);
  const row = document.querySelector(`.row[data-id="${CSS.escape(threadId)}"]`);
  if (!row) { void loadInbox(); return; }
  row.classList.add('unread');
  let chipEl = row.querySelector('.unread-chip');
  if (!chipEl) {
    chipEl = document.createElement('span');
    chipEl.className = 'unread-chip';
    chipEl.setAttribute('aria-label', t('hub.widget.unread'));
    row.querySelector('.subject').appendChild(chipEl);
  }
  chipEl.textContent = String(unread.get(threadId));
}

function clearUnread(threadId) {
  if (!unread.delete(threadId)) return;
  const row = document.querySelector(`.row[data-id="${CSS.escape(threadId)}"]`);
  if (row) {
    row.classList.remove('unread');
    row.querySelector('.unread-chip')?.remove();
  }
}

function onLiveMessage(m) {
  if (m.type === 'new-message') {
    const id = m.thread?.id;
    if (!id) return;
    if (currentThread && currentThread.id === id) {
      void openThread(id); // открытый тред обновляется сам
    } else if (m.message?.author === 'contact') {
      markUnread(id);
    } else {
      void loadInbox(); // чужой ответ/offline-тикета мог не быть в списке
    }
    return;
  }
  if (m.type === 'agent-message') {
    if (currentThread && currentThread.id === m.threadId) void openThread(m.threadId);
    return;
  }
  if (m.type === 'presence' && Array.isArray(m.items) && me) {
    const mine = m.items.find((p) => p.agentId === me.id);
    if (mine && document.activeElement !== $('hub-presence')) $('hub-presence').value = mine.status;
  }
}

function connectConsole() {
  if (pageState !== 'console' || sock) return;
  sock = new WebSocket(`/ws/console`);
  sock.onopen = () => { sockRetryMs = 3000; };
  sock.onmessage = (e) => {
    try { onLiveMessage(JSON.parse(e.data)); } catch { /* мусор игнорируем */ }
  };
  sock.onclose = () => {
    sock = null;
    setTimeout(connectConsole, sockRetryMs); // reconnect с постоянным шагом
    sockRetryMs = Math.min(sockRetryMs * 2, 30000);
  };
}

// ---- настройки виджета (только админ) ----

async function loadWidgetSettings() {
  const res = await api('GET', '/settings/widget');
  if (res.status !== 200) return;
  const s = res.body?.settings ?? {};
  $('hub-widget-origins').value = (s.origins ?? []).join('\n');
  $('hub-widget-consent').checked = s.consentRequired === true;
  $('hub-widget-policy').value = s.policyUrl ?? '';
}

async function saveWidgetSettings() {
  const errEl = $('hub-widget-error');
  const savedEl = $('hub-widget-saved');
  errEl.textContent = '';
  savedEl.textContent = '';
  const origins = $('hub-widget-origins').value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const btn = $('hub-widget-save');
  btn.disabled = true;
  try {
    const res = await api('POST', '/settings/widget', {
      origins,
      consentRequired: $('hub-widget-consent').checked,
      policyUrl: $('hub-widget-policy').value.trim(),
    });
    if (res.status !== 200) {
      errEl.textContent = res.body?.error?.message ?? t('hub.error.generic');
      return;
    }
    savedEl.textContent = t('hub.widget.saved');
    void loadWidgetSettings(); // честное значение от сервера (нормализация origins)
  } finally {
    btn.disabled = false;
  }
}

// ---- запуск ----

async function loadMe() {
  try {
    const res = await fetch('/api/hub/auth/me');
    if (!res.ok) return null;
    return (await res.json())?.user ?? null;
  } catch { return null; }
}

initLocale(localStorage.getItem('hub.locale'));
applyI18n();

function setLang(lang) {
  setLocale(lang);
  localStorage.setItem('hub.locale', lang);
  applyI18n();
}
$('hub-lang-ru').addEventListener('click', () => setLang('ru'));
$('hub-lang-en').addEventListener('click', () => setLang('en'));

if (pageState === 'login') {
  show($('hub-login'));
  $('hub-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('hub-login-error');
    errEl.textContent = '';
    const login = $('hub-login-name').value;
    const password = $('hub-login-pass').value;
    const totp = $('hub-login-totp').value.trim();
    const btn = $('hub-login-submit');
    btn.disabled = true;
    try {
      const res = await fetch('/api/hub/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login, password, ...(totp ? { totp } : {}) }),
      });
      if (res.ok) { window.location.reload(); return; }
      const body = await res.json().catch(() => null);
      const code = body?.error?.code ?? 'generic';
      if (code === 'totp_required') {
        show($('hub-totp-field'));
        $('hub-login-totp').focus();
      }
      // коды ошибок сервера в snake_case, ключ словаря — invalidCredentials
      errEl.textContent = t(code === 'invalid_credentials' ? 'hub.error.invalidCredentials' : `hub.error.${code}`);
    } catch {
      errEl.textContent = t('hub.error.generic');
    } finally {
      btn.disabled = false;
    }
  });
} else if (pageState === 'console') {
  show($('hub-console'));
  show($('hub-logout'));
  show($('hub-presence-box'));
  show($('hub-new-ticket-btn'));
  loadMe().then(async (user) => {
    if (!user) { window.location.reload(); return; }
    me = user;
    $('hub-user').classList.remove('hidden');
    $('hub-user-name').textContent = user.name ?? user.login ?? '';
    $('hub-user-role').textContent = user.role ?? '';
    setTitle('hub.console.title');
    void loadInbox();
    void loadPresence();
    connectConsole(); // live-обновления инбокса (new-message/typing/presence)
    if (me.role === 'admin') {
      show($('hub-widget-admin'));
      void loadWidgetSettings();
    }
  });
} else {
  show($('hub-forbidden'));
}

$('hub-logout').addEventListener('click', async () => {
  await fetch('/api/hub/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.reload();
});

// инбокс: фильтры, пагинация, строки
for (const id of ['hub-f-status', 'hub-f-channel']) {
  $(id).addEventListener('change', () => { readFilters(); void loadInbox(); });
}
for (const id of ['hub-f-tag', 'hub-f-search']) {
  $(id).addEventListener('input', () => { readFilters(); void loadInbox(); });
}
$('hub-f-reset').addEventListener('click', () => { resetFilters(); void loadInbox(); });
$('hub-list').addEventListener('click', (e) => {
  const row = e.target.closest?.('.row');
  if (row?.dataset.id) void openThread(row.dataset.id);
});
$('hub-page-prev').addEventListener('click', () => {
  filters.offset = Math.max(0, filters.offset - PAGE_SIZE);
  void loadInbox();
});
$('hub-page-next').addEventListener('click', () => {
  if (filters.offset + PAGE_SIZE < inboxTotal) filters.offset += PAGE_SIZE;
  void loadInbox();
});

// тред: статусы, assignee, теги, ответ, canned
$('hub-thread-back').addEventListener('click', showInboxView);
// каждая кнопка подключена статически — это проверяет анти-мёртвый контракт
$('hub-st-open').addEventListener('click', () => void setThreadStatus('open'));
$('hub-st-pending').addEventListener('click', () => void setThreadStatus('pending'));
$('hub-st-resolved').addEventListener('click', () => void setThreadStatus('resolved'));
$('hub-thread-take').addEventListener('click', async () => {
  if (!me) return;
  const take = currentThread?.assigneeId !== me.id;
  const res = await patchThread({ assigneeId: take ? me.id : null });
  if (res && res.status !== 200) $('hub-thread-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
  else hide($('hub-thread-error'));
});
$('hub-tag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('hub-tag-add');
  const value = $('hub-tag-input').value.trim();
  if (!value || !currentThread) return;
  btn.disabled = true;
  try {
    const res = await patchThread({ tags: [...(currentThread.tags ?? []), value] });
    if (res && res.status !== 200) $('hub-thread-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
    else hide($('hub-thread-error'));
    $('hub-tag-input').value = '';
  } finally {
    btn.disabled = false;
  }
});
$('hub-thread-taglist').addEventListener('click', async (e) => {
  const btn = e.target.closest?.('button[data-tag]');
  if (!btn || !currentThread) return;
  const next = (currentThread.tags ?? []).filter((tag) => tag !== btn.dataset.tag);
  const res = await patchThread({ tags: next });
  if (res && res.status !== 200) $('hub-thread-error').textContent = res.body?.error?.message ?? t('hub.error.generic');
});
$('hub-reply-form').addEventListener('submit', (e) => { e.preventDefault(); void sendReply(false); });
$('hub-reply-note').addEventListener('click', () => void sendReply(true));
$('hub-canned-save').addEventListener('click', () => void saveCanned());
$('hub-reply').addEventListener('input', () => void updateCannedPop());
$('hub-reply').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCannedPop();
  if (e.key === 'Tab' && !$('hub-canned-pop').classList.contains('hidden')) {
    const first = $('hub-canned-pop')?.querySelector('button[data-shortcut]');
    if (first) { e.preventDefault(); applyCanned(first.dataset.shortcut); }
  }
});
$('hub-canned-pop').addEventListener('click', (e) => {
  const btn = e.target.closest?.('button[data-shortcut]');
  if (btn) applyCanned(btn.dataset.shortcut);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.reply')) hideCannedPop();
});

// новый тикет
$('hub-new-ticket-btn').addEventListener('click', showNewView);
$('hub-new-cancel').addEventListener('click', showInboxView);
$('hub-new').addEventListener('submit', (e) => void submitNewTicket(e));

// настройки виджета (админ)
$('hub-widget-save').addEventListener('click', () => void saveWidgetSettings());

// presence
$('hub-presence').addEventListener('change', () => void savePresence());

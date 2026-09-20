// Страница виджета (iframe /w): WS-гость /ws/widget, pre-chat + consent,
// offline-форма, история по visitor_id, rating после resolve.
// Токенов и привилегий здесь нет: гость идентифицируется visitor_id
// (cookie enot_wv ставит сервер; fallback — localStorage, если куки блокированы).
// Все тексты — из словарей (data-i18n в разметке, t() в JS).
import { t, initLocale, getLocale } from '/hub/lib/i18n.mjs';
import { safeCardHref } from '/hub/card-url.mjs';

const $ = (id) => document.getElementById(id);
const LS = { visitor: 'enot.wv', profile: 'enot.wprofile', consent: 'enot.wconsent' };
const NS = 'enotdesk-w';
const HISTORY_MAX = 50;

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* приватный режим */ }
}

function applyI18n() {
  document.documentElement.lang = getLocale();
  document.title = t('widget.title');
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function setError(el, key) { el.textContent = key ? t(key) : ''; }

function post(type, extra = {}) {
  // Родитель — чужой сайт, его origin здесь неизвестен: контент события
  // невинный (высота/готовность), загрузчик проверяет e.origin со своей стороны.
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ ns: NS, type, ...extra }, '*');
  }
}

// ---- состояние ----

let ws = null;
let retryMs = 1000;
let helloTimer = 0;
let joinHintTimer = 0;
let settings = { consentRequired: false, policyUrl: '' };
let presence = 'connecting';
let thread = null; // открытый (или последний) тред гостя
let typingTimer = 0;
let closed = false;

function visitorId() { return lsGet(LS.visitor) || ''; }
function profile() {
  try { return JSON.parse(lsGet(LS.profile) || '{}'); } catch { return {}; }
}
function consented() { return lsGet(LS.consent) === '1'; }

// ---- рендер ----

function setStatus(status) {
  presence = status;
  const dot = $('w-status-dot');
  dot.className = `w-dot ${status === 'connecting' ? 'connecting' : status}`;
  $('w-status-text').textContent = t(`widget.status.${status}`);
}

// Карточка «Подключиться» (T05): кнопка протокола (enotdesk://) и ссылка на
// страницу скачивания/инструкции. Чужой или битый JSON — null (обычный пузырь).
function joinCard(m) {
  let card;
  try { card = JSON.parse(m.body); } catch { return null; }
  if (!card || card.kind !== 'remote-offer') return null;
  // href — только enotdesk: (запуск) и https: (страница хаба): чужая схема —
  // карточка не рендерится, гость видит обычный текстовый пузырь
  const url = safeCardHref(card.url, 'enotdesk:');
  if (!url) return null;
  const box = document.createElement('div');
  box.className = 'w-card';
  const start = document.createElement('a');
  start.id = 'w-card-start';
  start.className = 'w-btn';
  start.href = url;
  start.textContent = t('widget.join.start');
  box.appendChild(start);
  const page = safeCardHref(card.joinPage, 'https:');
  if (page) {
    const pageLink = document.createElement('a');
    pageLink.id = 'w-card-download';
    pageLink.className = 'w-btn ghost';
    pageLink.href = page;
    pageLink.target = '_blank';
    pageLink.rel = 'noopener noreferrer';
    pageLink.textContent = t('widget.join.download');
    box.appendChild(pageLink);
  }
  const hint = document.createElement('p');
  hint.id = 'w-card-hint';
  hint.className = 'w-error hidden';
  hint.textContent = t('widget.join.hint');
  box.appendChild(hint);
  // протокол мог не сработать (клиент не установлен) — через 3 с показываем подсказку
  start.addEventListener('click', () => {
    clearTimeout(joinHintTimer);
    joinHintTimer = setTimeout(() => { hint.classList.remove('hidden'); reportHeight(); }, 3000);
  });
  return box;
}

function bubble(m) {
  const el = document.createElement('div');
  el.className = `bubble ${m.author}`;
  if (m.type === 'card') {
    const card = joinCard(m);
    if (card) { el.classList.add('card'); el.appendChild(card); return el; }
  }
  el.textContent = m.body;
  return el;
}

function renderMessages(messages) {
  const box = $('w-msgs');
  box.textContent = '';
  for (const m of messages) box.appendChild(bubble(m));
  box.scrollTop = box.scrollHeight;
}

function appendMessage(m) {
  const box = $('w-msgs');
  box.appendChild(bubble(m));
  box.scrollTop = box.scrollHeight;
}

function views({ chat, prechat, offline, rating, done }) {
  (chat ? show : hide)($('w-chat'));
  (prechat ? show : hide)($('w-prechat'));
  (offline ? show : hide)($('w-offline'));
  (rating ? show : hide)($('w-rating'));
  (done ? show : hide)($('w-offline-done'));
}

function renderView() {
  const hasThread = Boolean(thread && thread.id);
  const needConsent = settings.consentRequired && !consented();
  const ratingBox = $('w-rating');
  for (const b of ratingBox.querySelectorAll('button')) b.disabled = false;
  hide($('w-rating-done'));
  show($('w-rating-lead'));
  if (hasThread) {
    views({ chat: true, prechat: false, offline: false, rating: true, done: false });
    if (thread.status === 'resolved' && !thread.rating) {
      // свежий resolve — звёзды активны
    } else if (thread.rating) {
      show($('w-rating-done'));
      hide($('w-rating-lead'));
      for (const b of ratingBox.querySelectorAll('button')) b.disabled = true;
    } else {
      hide(ratingBox);
    }
  } else if (needConsent) {
    views({ chat: false, prechat: true, offline: false, rating: false, done: false });
  } else if (presence === 'offline') {
    views({ chat: false, prechat: false, offline: true, rating: false, done: false });
  } else {
    views({ chat: true, prechat: false, offline: false, rating: false, done: false });
  }
  reportHeight();
}

function applyReady(data) {
  settings = data.settings ?? settings;
  lsSet(LS.visitor, data.visitorId);
  thread = data.thread ?? null;
  renderMessages((data.messages ?? []).slice(-HISTORY_MAX));
  renderView();
}

// ---- pre-chat ----

function refreshConsentUi() {
  const row = $('w-consent-row');
  if (settings.consentRequired) {
    show(row);
    const link = $('w-policy');
    if (settings.policyUrl) {
      link.href = settings.policyUrl;
      show(link);
    } else hide(link);
  } else hide(row);
}

function submitPrechat(e) {
  e.preventDefault();
  const errEl = $('w-prechat-error');
  if (settings.consentRequired && !$('w-consent').checked) {
    setError(errEl, 'widget.error.consent_required');
    return;
  }
  setError(errEl, null);
  const name = $('w-name').value.trim();
  const email = $('w-email').value.trim();
  lsSet(LS.profile, JSON.stringify({ name, email }));
  if ($('w-consent').checked) lsSet(LS.consent, '1');
  sendHello(); // повторный hello с профилем/согласием — сервер ответит ready
}

// ---- offline-форма ----

async function submitOffline(e) {
  e.preventDefault();
  const errEl = $('w-offline-error');
  const btn = $('w-offline-send');
  btn.disabled = true;
  try {
    const res = await fetch('/api/hub/widget/offline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        visitorId: visitorId(),
        name: $('w-name').value.trim() || undefined,
        email: $('w-offline-email').value.trim(),
        subject: $('w-offline-subject').value.trim(),
        text: $('w-offline-text').value.trim(),
      }),
    });
    if (res.status !== 201) {
      setError(errEl, 'widget.error.generic');
      return;
    }
    // сервер мог сгенерировать visitorId (первый визит ещё без WS) — сохраняем
    const saved = await res.json().catch(() => null);
    if (saved?.visitorId) lsSet(LS.visitor, saved.visitorId);
    views({ chat: false, prechat: false, offline: false, rating: false, done: true });
  } catch {
    setError(errEl, 'widget.error.generic');
  } finally {
    btn.disabled = false;
  }
}

// ---- rating ----

async function submitRating(stars) {
  const errEl = $('w-rating-error');
  try {
    const res = await fetch('/api/hub/widget/rating', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId(), threadId: thread?.id, rating: stars }),
    });
    if (res.status !== 200) {
      setError(errEl, 'widget.error.generic');
      return;
    }
    setError(errEl, null);
    thread = (await res.json())?.thread ?? thread;
    show($('w-rating-done'));
    hide($('w-rating-lead'));
    for (const b of $('w-rating-stars').querySelectorAll('button')) b.disabled = true;
  } catch {
    setError(errEl, 'widget.error.generic');
  }
}

// ---- WS ----

function sendHello() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const p = profile();
  ws.send(JSON.stringify({
    type: 'hello',
    visitorId: visitorId(),
    name: p.name || undefined,
    email: p.email || undefined,
    consent: consented() || undefined,
  }));
}

function connect() {
  if (closed) return;
  setStatus('connecting');
  clearTimeout(helloTimer);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${proto}${location.host}/ws/widget`);
  ws.onopen = () => {
    retryMs = 1000;
    sendHello();
    // без hello в разумный срок — соединение не считается живым
    helloTimer = setTimeout(() => { try { ws.close(); } catch { /* уже закрыт */ } }, 15000);
  };
  ws.onclose = () => {
    clearTimeout(helloTimer);
    setStatus('connecting');
    if (!closed) {
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    }
  };
  ws.onerror = () => { try { ws.close(); } catch { /* уже закрыт */ } };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m.type) {
      case 'ready':
        clearTimeout(helloTimer);
        setStatus((m.presence && m.presence.status) || 'offline');
        refreshConsentUi();
        applyReady(m);
        break;
      case 'sent':
        if (m.threadId) thread = { ...(thread ?? {}), id: m.threadId, status: thread?.status ?? 'open', rating: thread?.rating ?? null };
        $('w-input').value = '';
        setError($('w-error'), null);
        reportHeight();
        break;
      case 'msg':
        if (m.message) appendMessage(m.message);
        reportHeight();
        break;
      case 'error':
        setError($('w-error'), m.code === 'consent_required' ? 'widget.error.consent_required' : 'widget.error.generic');
        break;
      case 'resolved':
        if (m.threadId && thread) thread.status = 'resolved';
        renderView();
        break;
      case 'agent-typing':
        show($('w-typing'));
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => hide($('w-typing')), 4000);
        break;
      default:
        break;
    }
  };
}

function sendText() {
  const input = $('w-input');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) {
    if (!ws || ws.readyState !== WebSocket.OPEN) setError($('w-error'), 'widget.error.generic');
    return;
  }
  ws.send(JSON.stringify({ type: 'msg', text }));
  // очистка и рендер — только после ack 'sent': дубли исключены, сбой не теряет текст
}

// ---- высота и родитель ----

let heightTimer = 0;
function reportHeight() {
  clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    post('height', { h: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  }, 50);
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.ns !== NS) return;
  if (d.type === 'open' && ws && ws.readyState === WebSocket.OPEN) $('w-input').focus();
});

// ---- запуск ----

initLocale(lsGet('widget.locale'));
applyI18n();
show($('w-root'));
refreshConsentUi();
renderView();

$('w-form').addEventListener('submit', (e) => { e.preventDefault(); sendText(); });
$('w-prechat').addEventListener('submit', submitPrechat);
$('w-offline').addEventListener('submit', (e) => { e.preventDefault(); void submitOffline(e); });
for (const b of $('w-rating-stars').querySelectorAll('button[data-star]')) {
  b.addEventListener('click', () => void submitRating(Number(b.dataset.star)));
}
new ResizeObserver(reportHeight).observe(document.documentElement);
post('ready');
connect();

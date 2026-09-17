// Браузерный оператор (spec §браузерный оператор): логин, claim, WS /signal,
// WebRTC-answer, ввод/чат/буфер/файлы — те же протоколы, что у desktop.
// Переиспользуются Electron-free модули: client/lib/* (протоколы, i18n, статистика),
// client/renderer/{dom,state}.js (хелперы и состояние без моста window.enot).
// Отличие от desktop: вместо preload-моста — fetch + нативный WebSocket этой страницы.

import { $, text, show, hide, setBusy, applyI18n, roleName } from '../client/renderer/dom.js';
import { state, endReasonText } from '../client/renderer/state.js';
import { t, setLocale, getLocale } from '../client/lib/i18n.mjs';
import { INPUT_KEYS, validateOutgoingSignal } from '../client/lib/protocol.mjs';
import { parseChatMessage, chatMessage } from '../client/lib/chat.mjs';
import { parseClipMessage, clipMessage } from '../client/lib/clipboard-sync.mjs';
import {
  parseFileControl, createFileReceiver, createFileSender,
  fileMeta, fileAccept, makeFileId,
} from '../client/lib/file-transfer.mjs';
import { summarizeStats, formatQuality } from '../client/lib/rtc-stats.mjs';
import { wireBrowserInput } from './input-source.mjs';

const TOKEN_KEY = 'enot-op-token';
const COOKIE = 'enot_op';
const ALLOWED_ROLES = ['admin', 'operator'];

// ---- транспорт: fetch с Bearer вместо enot.request ----

const getToken = () => sessionStorage.getItem(TOKEN_KEY) ?? cookieToken();
function cookieToken() {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(document.cookie ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}
function saveToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(token)}; path=/operator; SameSite=Strict${secure}`;
}
function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
  document.cookie = `${COOKIE}=; path=/operator; Max-Age=0; SameSite=Strict`;
}

async function api(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- сигналинг: нативный WebSocket вместо createSignalClient (тот mjs тянет 'ws') ----

let ws = null;
let keyErrorReset = null;

function sendSignal(data) {
  const v = validateOutgoingSignal({ type: 'signal', data });
  if (!v.ok || !ws || ws.readyState !== 1) return; // некорректное не уходит, как в desktop
  ws.send(JSON.stringify({ type: 'signal', data }));
}

function openSignal() {
  ws?.close(1000, 'reconnect');
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`;
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({
      type: 'auth', role: 'operator',
      sessionId: state.connect.sessionId, claimId: state.connect.claimId, token: getToken(),
    }));
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg) onSignal(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return; // сокет закрыт ради нового (переподключение) — не мешаем
    ws = null;
    // сокет закрылся при живом сеансе: сервер держит грейс (ADR 0013) — даём вернуться
    if (state.connect) { show($('op-reconnect')); text($('remote-status'), ''); }
  };
}

function showStatus(value) {
  text($('remote-status'), value);
}

// Возврат статус-строки после временных сообщений: «Подключено» — только при
// живом соединении (state.pc), иначе честный нейтральный текст без сеанса.
function restoreStatus() {
  showStatus(state.pc ? t('status.connected') : t('web.status.idle'));
}

function showKeyError(key) {
  showStatus(t('op.keyUnsupported', { key }));
  clearTimeout(keyErrorReset);
  keyErrorReset = setTimeout(restoreStatus, 2000);
}

// ---- состояния страницы ----

const VIEWS = ['view-login', 'view-denied', 'view-connect', 'op-waiting', 'op-reconnect', 'op-remote'];
function showOnly(...ids) {
  for (const id of VIEWS) (ids.includes(id) ? show : hide)($(id));
}

function showConnectForm() {
  stopMedia();
  state.connect = null;
  showOnly('view-connect');
  text($('remote-status'), '');
  text($('session-timer'), '');
}

function stopMedia() {
  try { state.dc?.close(); } catch { /* уже закрыт */ }
  for (const ch of Object.values(state.dcs ?? {})) { try { ch.close(); } catch { /* уже закрыт */ } }
  try { state.pc?.close(); } catch { /* уже закрыт */ }
  state.pc = null; state.dc = null; state.dcs = null; state.fileRx = null;
  state.iceQueue = [];
  $('remote-video').srcObject = null;
  stopTimers();
}

// Таймер и качество — как в desktop (session-media.js).
let sessionTimer = null;
let qualityTimer = null;
function startTimers(pc) {
  const startedAt = Date.now();
  stopTimers();
  sessionTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    text($('session-timer'), `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`);
  }, 1000);
  qualityTimer = setInterval(async () => {
    try {
      const summary = summarizeStats(await pc.getStats());
      if (pc.connectionState === 'connected') showStatus(formatQuality(t('status.connected'), summary));
    } catch { /* соединение закрывается — не критично */ }
  }, 2000);
}
function stopTimers() {
  clearInterval(sessionTimer); clearInterval(qualityTimer);
  sessionTimer = null; qualityTimer = null;
}

// ---- WebRTC: оператор отвечает на оффер клиента (host — offerer, как в desktop) ----

function makePc(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate.toJSON() }); };
  // краткое дрожание сети самовосстанавливается — 10с грейс, 'failed' рвёт сразу
  let rtcGrace = null;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected') {
      rtcGrace ??= setTimeout(() => { rtcGrace = null; rtcLinkLost(); }, 10000);
      return;
    }
    if (pc.connectionState === 'connected' && rtcGrace) { clearTimeout(rtcGrace); rtcGrace = null; }
    if (['failed', 'closed'].includes(pc.connectionState) && state.connect) rtcLinkLost();
  };
  return pc;
}

function rtcLinkLost() {
  if (!state.connect) return;
  showConnectForm();
  text($('conn-error'), endReasonText('rtc'));
}

function drainIce(pc) {
  for (const c of state.iceQueue) pc.addIceCandidate(c).catch(() => { /* устаревший кандидат */ });
  state.iceQueue = [];
}

async function operatorAnswer(offerSdp) {
  const cfg = await api('GET', '/rtc-config');
  const pc = makePc(cfg.body?.iceServers ?? []);
  state.pc = pc;
  state.iceQueue = [];
  state.dc = pc.createDataChannel('input');
  state.dc.onopen = () => {
    wireBrowserInput($('remote-video'), (obj) => {
      try { state.dc.send(JSON.stringify(obj)); } catch { /* канал закрывается */ }
    }, { keys: new Set(INPUT_KEYS), onUnsupported: showKeyError });
  };
  // Каналы сессии (ADR 0014): chat / clip / file — те же имена и протоколы.
  const chatCh = pc.createDataChannel('chat');
  chatCh.onmessage = (m) => {
    const msg = parseChatMessage(m.data);
    if (msg) appendChat('client', msg.text);
  };
  const clipCh = pc.createDataChannel('clip');
  clipCh.onmessage = (m) => {
    const msg = parseClipMessage(m.data);
    if (msg) incomingClip(msg.text);
  };
  const fileCh = pc.createDataChannel('file');
  fileCh.binaryType = 'arraybuffer';
  fileCh.onmessage = (m) => fileMessage(fileCh, m.data);
  state.dcs = { input: state.dc, chat: chatCh, clip: clipCh, file: fileCh };
  pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0]; };
  startTimers(pc);
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  drainIce(pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ description: { type: 'answer', sdp: pc.localDescription.sdp } });
}

// ---- роутер сигналов (операторская ветка desktop app.js) ----

async function onSignal(msg) {
  switch (msg.type) {
    case 'ready':
      hide($('op-reconnect'));
      break;
    case 'approved':
      if (!state.pc) {
        showOnly('op-waiting');
        showStatus(t('op.waitingScreen'));
      }
      break;
    case 'signal':
      try {
        if (msg.data?.description && msg.data.description.type === 'offer') {
          await operatorAnswer(msg.data.description.sdp);
          showOnly('op-remote');
          showStatus(t('status.connected'));
        } else if (msg.data?.candidate) {
          const c = msg.data.candidate;
          if (state.pc && state.pc.remoteDescription) state.pc.addIceCandidate(c).catch(() => {});
          else state.iceQueue.push(c); // кандидаты в очередь до remote description
        }
      } catch {
        // ошибка ответа (некорректный оффер, нет доступа к rtc-config) — честный откат
        showConnectForm();
        text($('conn-error'), t('common.serverError'));
      }
      break;
    case 'peer-reconnecting':
      showStatus(t('op.clientReconnecting'));
      break;
    case 'resumed':
      showStatus(t('status.connected'));
      hide($('op-reconnect'));
      break;
    case 'ended': {
      const reason = endReasonText(msg.reason);
      showConnectForm();
      text($('conn-error'), reason);
      break;
    }
    case 'error':
      // транзиентные ошибки (rate_limited, bad_signal) управление не рвут
      showStatus(msg.message ?? t('common.serverError'));
      clearTimeout(keyErrorReset);
      keyErrorReset = setTimeout(restoreStatus, 3000);
      break;
    default:
      break;
  }
}

// ---- чат / буфер / файлы (операторская сторона session-services.js) ----

function appendChat(whoKey, value) {
  const log = $('op-chat-log');
  const line = document.createElement('p');
  line.className = `chat-line chat-${whoKey === 'you' ? 'me' : 'them'}`;
  const name = document.createElement('strong');
  name.textContent = `${t(`chat.${whoKey}`)}: `;
  line.appendChild(name);
  line.appendChild(document.createTextNode(value));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function sendChat() {
  const input = $('op-chat-input');
  const value = input.value.trim();
  if (!value) return;
  const wire = chatMessage(value);
  if (!wire) { input.value = ''; return; }
  const dc = state.dcs?.chat;
  if (!dc || dc.readyState !== 'open') return;
  try { dc.send(wire); } catch { return; }
  appendChat('you', value);
  input.value = '';
}

// Исходящий буфер: событие copy уходит в канал, только если синхронизация включена.
document.addEventListener('copy', () => {
  if (!$('clip-op-toggle').checked) return;
  const dc = state.dcs?.clip;
  if (!dc || dc.readyState !== 'open') return;
  const selected = String(document.getSelection?.() ?? '');
  const wire = clipMessage(selected);
  if (!wire) return;
  try { dc.send(wire); } catch { /* канал закрывается */ }
});

function incomingClip(value) {
  navigator.clipboard?.writeText(value).catch(() => { /* нет разрешения — текст не теряется, показан в чате не нужен */ });
}

function saveReceivedBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = t('files.saveLink', { name, size: (blob.size / 1048576).toFixed(1) });
  const box = $('op-file-list');
  box.appendChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Оператор: клиент шлёт файл только по своему явному действию — принимаем сами.
function fileMessage(ch, data) {
  if (typeof data === 'string') {
    const ctl = parseFileControl(data);
    if (!ctl) return;
    if (ctl.kind === 'meta') {
      state.fileRx = { rx: createFileReceiver(ctl), dc: ch, prog: null };
      try { ch.send(fileAccept(ctl.id)); } catch { /* канал закрыт */ }
      text($('file-op-status'), t('files.clientSending', { name: ctl.name }));
    } else if (ctl.kind === 'done') {
      const { rx } = state.fileRx ?? {};
      if (!rx) return;
      const blob = rx.complete();
      const name = rx.meta.name;
      state.fileRx = null;
      text($('file-op-status'), '');
      if (!blob) { text($('file-op-status'), t('files.brokenShort')); return; }
      saveReceivedBlob(blob, name);
    } else if (ctl.kind === 'reject') {
      text($('file-op-status'), t('files.clientRejected'));
    }
    return;
  }
  const { rx } = state.fileRx ?? {};
  if (rx?.push(data)) {
    text($('file-op-status'), t('files.progress', {
      got: (rx.received / 1048576).toFixed(1),
      total: (rx.meta.size / 1048576).toFixed(1),
    }));
  }
}

function sendFile(file) {
  if (!file) return;
  const dc = state.dcs?.file;
  if (!dc || dc.readyState !== 'open') {
    text($('file-op-status'), t('files.noChannel'));
    return;
  }
  const id = makeFileId();
  try {
    dc.send(fileMeta(id, file.name, file.size));
    createFileSender({ file, dc, id }).start();
  } catch { return; }
  text($('file-op-status'), t('files.sending', { name: file.name }));
}

// ---- действия страницы ----

function wire() {
  $('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-login');
    setBusy(btn, true, t('web.login.busy'));
    try {
      const res = await api('POST', '/auth/login', {
        login: $('login-login').value, password: $('login-password').value,
      });
      if (res.status !== 200) {
        text($('login-error'), res.body?.error?.message ?? t('common.serverError'));
        return;
      }
      if (!ALLOWED_ROLES.includes(res.body.user.role)) {
        clearToken();
        show($('login-auditor'));
        return;
      }
      saveToken(res.body.token);
      location.replace('/operator');
    } finally {
      setBusy(btn, false);
    }
  });

  $('connect-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btn-claim');
    setBusy(btn, true, t('web.connect.busy'));
    try {
      const id = $('conn-id').value.trim();
      const password = $('conn-password').value;
      const res = await api('POST', `/sessions/${encodeURIComponent(id)}/claim`, { password });
      if (res.status !== 201) {
        // 403 аудитора, 401 без прав, неверный ID/пароль — тексты сервера, как в desktop
        text($('conn-error'), res.body?.error?.message ?? t('common.serverError'));
        return;
      }
      state.connect = { sessionId: res.body.sessionId, claimId: res.body.claimId };
      text($('conn-error'), '');
      showOnly('op-waiting');
      openSignal();
    } finally {
      setBusy(btn, false);
    }
  });

  $('btn-cancel')?.addEventListener('click', async () => {
    const { sessionId } = state.connect ?? {};
    showConnectForm();
    if (sessionId) await api('POST', `/sessions/${encodeURIComponent(sessionId)}/end`).catch(() => {});
    ws?.close(1000, 'cancel');
    ws = null;
  });

  $('btn-end')?.addEventListener('click', async () => {
    const { sessionId } = state.connect ?? {};
    showConnectForm();
    if (sessionId) await api('POST', `/sessions/${encodeURIComponent(sessionId)}/end`).catch(() => {});
    ws?.close(1000, 'end');
    ws = null;
  });

  $('btn-reconnect')?.addEventListener('click', () => {
    if (!state.connect) return;
    hide($('op-reconnect'));
    openSignal(); // повторный auth теми же токенами — сервер разыграет replay
  });

  $('btn-chat-send')?.addEventListener('click', () => sendChat());
  $('op-chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  $('btn-op-file')?.addEventListener('click', () => $('op-file-input').click());
  $('op-file-input')?.addEventListener('change', () => {
    const file = $('op-file-input').files?.[0];
    $('op-file-input').value = '';
    sendFile(file);
  });

  // Drag&drop файла на экран сеанса, как в desktop.
  const zone = $('op-remote');
  zone?.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop-hover'); });
  zone?.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
  zone?.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop-hover');
    sendFile(e.dataTransfer?.files?.[0]);
  });

  $('btn-fullscreen')?.addEventListener('click', () => {
    $('remote-video').requestFullscreen?.().catch(() => { /* пользователь отказал */ });
  });
  $('btn-fit')?.addEventListener('click', () => {
    const video = $('remote-video');
    const cover = video.classList.toggle('fit-cover');
    text($('btn-fit'), cover ? t('web.session.fitFit') : t('web.session.fitFill'));
  });

  $('btn-logout')?.addEventListener('click', async () => {
    await api('POST', '/auth/logout').catch(() => {});
    clearToken();
    location.replace('/operator');
  });

  $('lang-select')?.addEventListener('change', (e) => {
    localStorage.setItem('enot-locale', e.target.value);
    location.reload(); // статичная страница: перезагрузка мгновенна и честна
  });
}

// ---- запуск ----

(async function boot() {
  // Локаль: сохранённый выбор сильнее серверного (Accept-Language), фолбэк en.
  const baked = document.body.dataset.locale;
  const saved = localStorage.getItem('enot-locale');
  setLocale(saved === 'ru' || saved === 'en' ? saved : (baked === 'en' ? 'en' : 'ru'));
  document.documentElement.lang = getLocale();
  applyI18n();
  const lang = $('lang-select');
  if (lang) lang.value = getLocale();
  wire();

  // Страница отдаётся сервером по ролям; но токен в браузере мог устареть —
  // сверяемся с /auth/me и показываем честное состояние.
  const me = await api('GET', '/auth/me');
  if (me.status === 200) {
    const user = me.body.user;
    text($('op-user-name'), user.name);
    text($('op-user-role'), roleName(user.role));
    if (!ALLOWED_ROLES.includes(user.role)) {
      clearToken();
      showOnly('view-denied');
      return;
    }
    showOnly('view-connect');
    showStatus(t('web.status.idle'));
    return;
  }
  clearToken();
  if ($('login-form')) showOnly('view-login');
  else location.replace('/operator'); // cookie истёк — сервер отдаст форму входа
})();

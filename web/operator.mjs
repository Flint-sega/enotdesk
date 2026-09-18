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

const VIEWS = ['view-login', 'view-denied', 'view-connect', 'view-machines', 'op-waiting', 'op-reconnect', 'op-remote'];
function showOnly(...ids) {
  for (const id of VIEWS) (ids.includes(id) ? show : hide)($(id));
}

function showConnectForm() {
  stopMedia();
  state.connect = null;
  showOnly('view-connect');
  hide($('op-term')); // панель терминала живёт только внутри сеанса
  hide($('btn-term-retry'));
  text($('op-term-out'), '');
  text($('op-term-status'), '');
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
  // Терминал (R09): канал создаём только для сеанса с машиной (unattended).
  let termCh = null;
  if (state.connect?.machineId) {
    termCh = pc.createDataChannel('term');
    wireTermChannel(termCh);
  }
  state.dcs = { input: state.dc, chat: chatCh, clip: clipCh, file: fileCh, ...(termCh ? { term: termCh } : {}) };
  pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0]; };
  startTimers(pc);
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  drainIce(pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ description: { type: 'answer', sdp: pc.localDescription.sdp } });
}

// Machine-сеанс (R09): оператор — оферер, агент отвечает answer'ом без медиа;
// единственный канал — `term` (панель терминала).
async function machineOffer() {
  try {
    const cfg = await api('GET', '/rtc-config');
    const pc = makePc(cfg.body?.iceServers ?? []);
    state.pc = pc;
    state.iceQueue = [];
    const termCh = pc.createDataChannel('term');
    wireTermChannel(termCh);
    state.dcs = { term: termCh };
    pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0]; };
    startTimers(pc);
    // Повторное открытие терминала (R09): новый DataChannel требует
    // ренеготиации. Первый раунд — offer ниже, поэтому пока нет remote
    // description, хук молчит; дальше каждый новый канал офферится сам.
    // Агент (answerTermOffer) отвечает на каждый offer, пока жив сеанс.
    pc.onnegotiationneeded = async () => {
      if (!pc.remoteDescription) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ description: { type: 'offer', sdp: pc.localDescription.sdp } });
      } catch { /* раунд не собрался — дедлайн открытия честно отчитается */ }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ description: { type: 'offer', sdp: pc.localDescription.sdp } });
  } catch {
    // честный откат: оффер не собрался (нет rtc-config и т.п.)
    showConnectForm();
    text($('conn-error'), t('common.serverError'));
  }
}

// ---- роутер сигналов (операторская ветка desktop app.js) ----

async function onSignal(msg) {
  switch (msg.type) {
    case 'ready':
      hide($('op-reconnect'));
      break;
    case 'approved':
      if (!state.pc) {
        if (state.connect?.machineId) {
          // machine-сеанс (R09): оператор офферит — агент без медиа отвечает answer'ом
          showOnly('op-remote');
          showStatus(t('op.waitingScreen'));
          void machineOffer();
        } else {
          showOnly('op-waiting');
          showStatus(t('op.waitingScreen'));
        }
      }
      break;
    case 'signal':
      try {
        if (msg.data?.description && msg.data.description.type === 'offer') {
          await operatorAnswer(msg.data.description.sdp);
          showOnly('op-remote');
          showStatus(t('status.connected'));
        } else if (msg.data?.description && msg.data.description.type === 'answer'
                   && state.connect?.machineId && state.pc && !state.pc.remoteDescription) {
          // machine-сеанс: ответ агента на наш offer
          await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.data.description.sdp });
          drainIce(state.pc);
          showOnly('op-remote');
          showStatus(t('status.connected'));
        } else if (msg.data?.description?.type === 'answer'
                   && state.connect?.machineId && state.pc
                   && state.pc.signalingState === 'have-local-offer') {
          // ренеготиация терминала (R09): агент ответил на повторный offer.
          // Раунд best-effort: не сошёлся — сеанс жив, дедлайн открытия
          // терминала честно отчитается.
          try {
            await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.data.description.sdp });
            drainIce(state.pc);
          } catch { /* устаревший/несошедшийся раунд */ }
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

// ---- терминал машины (R09): DC-канал `term`, только внутри сеанса с машиной ----

// Дедлайн открытия (craft-ревью R09): канал может не открыться вовсе (мост
// агента мёртв, answer не пришёл) — без него панель навсегда висит на
// «Открываю терминал…», и отказ не виден оператору.
const TERM_OPEN_TIMEOUT_MS = 10000;

// Честный отказ вместо вечного «Открываю…»: причина и кнопка «Повторить».
function termFail(reason) {
  showStatusId(t('term.unavailableWith', { reason }));
  show($('btn-term-retry'));
}

function wireTermChannel(ch) {
  show($('op-term'));
  text($('op-term-out'), '');
  showStatusId(t('term.opening'));
  hide($('btn-term-retry'));
  let alive = false; // терминал подтвердил открытие ({opened} или вывод)
  let settled = false; // честный статус уже показан — поздние события не перебивают
  const deadline = setTimeout(() => {
    if (!settled) termFail(t('term.reasonTimeout'));
  }, TERM_OPEN_TIMEOUT_MS);
  const settle = () => { settled = true; clearTimeout(deadline); hide($('btn-term-retry')); };
  ch.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; } // не-JSON не проходит allowlist
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'opened':
        // честная пометка контекста исполнения (SYSTEM v1, R09.1)
        settle();
        alive = true;
        showStatusId(t('term.context', { context: typeof msg.context === 'string' ? msg.context : '?' }));
        break;
      case 'out':
        if (!alive) { settle(); alive = true; }
        termAppend(String(msg.data ?? ''));
        break;
      case 'exit':
        clearTimeout(deadline);
        showStatusId(t('term.exited', { reason: typeof msg.reason === 'string' ? msg.reason : 'exit' }));
        break;
      case 'error':
        settled = true;
        clearTimeout(deadline);
        showStatusId(t(msg.code === 'term-busy' ? 'term.busy'
          : msg.code === 'term-unavailable' ? 'term.unavailable' : 'term.failed'));
        show($('btn-term-retry'));
        break;
      default:
        break;
    }
  };
  ch.onclose = () => {
    clearTimeout(deadline);
    if (alive) showStatusId(t('term.closed'));
    else if (!settled) termFail(t('term.reasonClosed'));
  };
}

// Повторить (R09): старый канал закрывается, новый «term» требует ренеготиации —
// её ведёт onnegotiationneeded в machineOffer; не сошлось — дедлайн открытия
// снова честно отчитается.
function retryTerm() {
  const pc = state.pc;
  if (!pc || pc.connectionState === 'closed') return;
  const old = state.dcs?.term;
  if (old && old.readyState !== 'closed') { try { old.close(); } catch { /* уже закрыт */ } }
  const ch = pc.createDataChannel('term');
  state.dcs = { ...(state.dcs ?? {}), term: ch };
  wireTermChannel(ch);
}

function showStatusId(value) {
  text($('op-term-status'), value);
}

// Вывод — <pre> с потолком (хвост), чтобы живая страница не раздувалась.
function termAppend(data) {
  const out = $('op-term-out');
  const joined = out.textContent + data;
  out.textContent = joined.length > 20000 ? joined.slice(-20000) : joined;
  out.scrollTop = out.scrollHeight;
}

function sendTermLine() {
  const input = $('op-term-input');
  const dc = state.dcs?.term;
  if (!dc || dc.readyState !== 'open') return;
  const line = input.value.slice(0, 8192);
  input.value = '';
  try { dc.send(JSON.stringify({ type: 'in', data: `${line}\r` })); } catch { /* канал закрывается */ }
}

// ---- панель «Машины» (R07): список/пагинация/PIN/отзыв/удаление/терминал ----
// Только существующий machines API (spec §UI машин): нового серверного кода нет.
// Панель показывается только admin; оператор её не видит, а любой прямой запрос
// всё равно честно получит отказ сервера (403).

const MACHINES_PAGE = 25;
const PIN_MIN = 4;
const PIN_MAX = 128;
// Действия строки машины: и значения data-action, и хвосты словарных ключей
// web.machines.action.* — контракт-тест проверяет, что каждое обработано.
const MACHINE_ACTIONS = ['terminal', 'pin', 'revoke', 'deleteAction'];
let machinesOffset = 0;
let machinesTotal = 0;
let machinesCache = []; // текущая страница: данные строк для действий по data-id
let claimMachine = null; // машина, для которой открыт терминальный claim

// Инвентарь (R06) приходит прямо в списке машин; поля может не быть —
// агент не прислал (например, statfs недоступен) — это честно показываем.
function inventoryParts(inv) {
  if (!inv || typeof inv !== 'object') return [t('web.machines.invNone')];
  const parts = [];
  if (typeof inv.os === 'string') parts.push(t('web.machines.invOs', { value: inv.os }));
  if (typeof inv.appVersion === 'string') parts.push(t('web.machines.invVersion', { value: inv.appVersion }));
  if (Number.isFinite(inv.uptimeSec)) parts.push(t('web.machines.invUptime', { value: fmtUptime(inv.uptimeSec) }));
  if (Number.isFinite(inv.diskFreeGb)) parts.push(t('web.machines.invDisk', { value: inv.diskFreeGb }));
  return parts.length ? parts : [t('web.machines.invNone')];
}

function fmtUptime(sec) {
  const total = Math.max(0, Math.floor(sec));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}${t('web.machines.uDay')}`);
  if (h) parts.push(`${h}${t('web.machines.uHour')}`);
  if (m || (!d && !h)) parts.push(`${m}${t('web.machines.uMin')}`);
  return parts.join(' ');
}

function machineBadge(m) {
  const span = document.createElement('span');
  span.className = 'badge';
  if (m.revokedAt) { span.classList.add('off'); span.textContent = t('web.machines.badgeRevoked'); }
  else if (!m.registered) { span.textContent = t('web.machines.badgeNoAgent'); }
  else if (m.online) { span.classList.add('on'); span.textContent = t('web.machines.online'); }
  else if (m.lastSeenAt) { span.classList.add('off'); span.textContent = t('web.machines.offline', { date: new Date(m.lastSeenAt).toLocaleString(getLocale()) }); }
  else { span.classList.add('off'); span.textContent = t('web.machines.offlineNever'); }
  return span;
}

function machineActionButton(m, action) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ghost sm${action === 'terminal' ? '' : ' danger'}`;
  btn.dataset.action = action;
  btn.dataset.id = m.id;
  btn.textContent = t(`web.machines.action.${action}`);
  if (action === 'terminal') btn.disabled = Boolean(m.revokedAt) || !m.registered;
  if (action === 'revoke') btn.disabled = Boolean(m.revokedAt);
  return btn;
}

function renderMachineRows(items) {
  const box = $('machines-list');
  box.textContent = '';
  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'machine-item';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const title = document.createElement('div');
    title.className = 'title';
    title.appendChild(document.createTextNode(m.name));
    title.appendChild(machineBadge(m));
    if (m.hasPin) {
      const pin = document.createElement('span');
      pin.className = 'badge';
      pin.textContent = t('web.machines.badgePin');
      title.appendChild(pin);
    }
    grow.appendChild(title);
    const subs = [
      m.groupName ? t('web.machines.group', { value: m.groupName }) : '',
      ...inventoryParts(m.inventory),
    ].filter(Boolean);
    for (const line of subs) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = line;
      grow.appendChild(sub);
    }
    row.appendChild(grow);
    const actions = document.createElement('div');
    actions.className = 'machine-actions';
    for (const action of MACHINE_ACTIONS) actions.appendChild(machineActionButton(m, action));
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function renderMachines() {
  const res = await api('GET', `/machines?limit=${MACHINES_PAGE}&offset=${machinesOffset}`);
  if (res.status !== 200) {
    // отказ сервера честен: не-admin получит свой 403, остальные — свой текст
    text($('machines-error'), res.body?.error?.message ?? t('common.serverError'));
    return;
  }
  machinesTotal = res.body.total ?? res.body.items?.length ?? 0;
  machinesCache = res.body.items ?? [];
  text($('machines-error'), '');
  renderMachineRows(machinesCache);
  const empty = $('machines-empty');
  (machinesCache.length ? hide : show)(empty);
  text($('machines-page'), t('common.pageOf', { page: Math.floor(machinesOffset / MACHINES_PAGE) + 1, total: machinesTotal }));
  $('btn-machines-prev').disabled = machinesOffset === 0;
  $('btn-machines-next').disabled = machinesOffset + MACHINES_PAGE >= machinesTotal;
}

function machineActionError(res) {
  text($('machines-error'), res.body?.error?.message ?? t('common.serverError'));
}

async function machinePin(m) {
  const raw = window.prompt(t('web.machines.pinPrompt', { name: m.name }));
  if (raw === null) return; // отмена
  const pin = raw.trim();
  const body = pin ? { pin } : {}; // пустое значение — снять PIN (сервер так и понимает)
  if (pin && (pin.length < PIN_MIN || pin.length > PIN_MAX)) {
    text($('machines-error'), t('machines.pinLength'));
    return;
  }
  if (!pin && m.hasPin && !window.confirm(t('web.machines.pinClearConfirm', { name: m.name }))) return;
  const res = await api('POST', `/machines/${encodeURIComponent(m.id)}/pin`, body);
  if (res.status !== 200) machineActionError(res);
  await renderMachines();
}

async function machineRevoke(m) {
  if (!window.confirm(t('web.machines.revokeConfirm', { name: m.name }))) return;
  const res = await api('POST', `/machines/${encodeURIComponent(m.id)}/revoke`);
  if (res.status !== 200) machineActionError(res);
  await renderMachines();
}

async function machineDelete(m) {
  if (!window.confirm(t('web.machines.deleteConfirm', { name: m.name }))) return;
  const res = await api('DELETE', `/machines/${encodeURIComponent(m.id)}`);
  if (res.status !== 200) machineActionError(res);
  await renderMachines();
}

// Открытие терминала машины (R09): claim с обязательной причиной (+PIN, если
// задан) — политику проверяет сервер; дальше работает существующий flow
// machine-сеанса, терминал откроется в своей панели.
function openMachineClaim(m) {
  claimMachine = m;
  text($('machines-claim-name'), t('web.machines.claimTarget', { name: m.name }));
  (m.hasPin ? show : hide)($('machines-claim-pin-field'));
  $('machines-claim-reason').value = '';
  $('machines-claim-pin').value = '';
  text($('machines-claim-error'), '');
  show($('machines-claim'));
  $('machines-claim-reason').focus();
}

function closeMachineClaim() {
  claimMachine = null;
  hide($('machines-claim'));
}

function showMachines() {
  if (state.connect) return; // во время сеанса панель машин недоступна
  closeMachineClaim();
  showOnly('view-machines');
  void renderMachines();
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
      state.connect = { sessionId: res.body.sessionId, claimId: res.body.claimId, machineId: res.body.machineId ?? null };
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

  $('btn-term-send')?.addEventListener('click', () => sendTermLine());
  $('btn-term-retry')?.addEventListener('click', () => retryTerm());
  $('op-term-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendTermLine(); }
  });
  $('btn-term-close')?.addEventListener('click', () => {
    const dc = state.dcs?.term;
    if (!dc || dc.readyState !== 'open') return;
    try { dc.send(JSON.stringify({ type: 'close' })); } catch { /* канал закрывается */ }
  });

  // Панель «Машины» (R07): делегирование клика по строкам, пагинация, claim.
  $('machines-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button[data-action]');
    if (!btn || btn.disabled) return;
    const m = machinesCache.find((x) => x.id === btn.dataset.id);
    if (!m) return;
    const action = btn.dataset.action;
    if (action === 'terminal') openMachineClaim(m);
    else if (action === 'pin') void machinePin(m);
    else if (action === 'revoke') void machineRevoke(m);
    else if (action === 'deleteAction') void machineDelete(m);
  });

  $('btn-machines-prev')?.addEventListener('click', () => {
    machinesOffset = Math.max(0, machinesOffset - MACHINES_PAGE);
    void renderMachines();
  });
  $('btn-machines-next')?.addEventListener('click', () => {
    if (machinesOffset + MACHINES_PAGE < machinesTotal) machinesOffset += MACHINES_PAGE;
    void renderMachines();
  });
  $('btn-machines-refresh')?.addEventListener('click', () => void renderMachines());

  $('machines-claim-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!claimMachine) return;
    const btn = $('btn-machines-claim');
    setBusy(btn, true, t('web.machines.claimBusy'));
    try {
      const body = { reason: $('machines-claim-reason').value.trim() };
      if (claimMachine.hasPin) body.pin = $('machines-claim-pin').value;
      const res = await api('POST', `/machines/${encodeURIComponent(claimMachine.id)}/claim`, body);
      if (res.status !== 201) {
        // reason_required / pin_required / bad_pin / machine_revoked — тексты сервера
        text($('machines-claim-error'), res.body?.error?.message ?? t('common.serverError'));
        return;
      }
      const { sessionId, claimId, machineId } = res.body;
      closeMachineClaim();
      text($('machines-error'), '');
      // дальше — существующий flow machine-сеанса: approved → терминал
      state.connect = { sessionId, claimId, machineId: machineId ?? claimMachine.id };
      showOnly('op-waiting');
      openSignal();
    } finally {
      setBusy(btn, false);
    }
  });
  $('btn-machines-claim-cancel')?.addEventListener('click', () => closeMachineClaim());

  $('btn-nav-machines')?.addEventListener('click', () => showMachines());
  $('btn-nav-connect')?.addEventListener('click', () => {
    closeMachineClaim();
    showConnectForm();
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
    // Панель машин — только admin (spec §UI машин); оператор её не видит.
    if (user.role === 'admin') show($('btn-nav-machines'));
    showOnly('view-connect');
    showStatus(t('web.status.idle'));
    return;
  }
  clearToken();
  if ($('login-form')) showOnly('view-login');
  else location.replace('/operator'); // cookie истёк — сервер отдаст форму входа
})();

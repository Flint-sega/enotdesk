// Медиа сеанса: RTCPeerConnection, выбор и смена источника, качество,
// пауза трансляции, таймер, запуск/приём WebRTC-соединения.

import { $, enot, text, setBusyAll } from './dom.js';
import { state, endReasonText } from './state.js';
import { t } from '../lib/i18n.mjs';
import { wireOperatorInput } from './operator-input.js';
import { wireHostChannel } from './session-services.js';
import { setVideoEnabled } from '../lib/media-toggle.mjs';
import { summarizeStats, formatQuality } from '../lib/rtc-stats.mjs';

// Пауза трансляции: чёрные кадры оператору, явный статус у клиента.
let streamPaused = false;
$('btn-pause-stream').addEventListener('click', () => {
  if (!state.localStream) return;
  streamPaused = !streamPaused;
  setVideoEnabled(state.localStream, !streamPaused);
  text($('btn-pause-stream'), streamPaused ? t('client.showScreen') : t('client.hideScreen'));
  text($('client-live-note'), streamPaused ? t('client.pausedNote') : '');
});

// Таймер длительности сеанса у оператора.
let sessionTimer = null;
function startSessionTimer() {
  const startedAt = Date.now();
  clearInterval(sessionTimer);
  sessionTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    text($('session-timer'), `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`);
  }, 1000);
}
function stopSessionTimer() {
  clearInterval(sessionTimer);
  sessionTimer = null;
  text($('session-timer'), '');
}

// Индикатор качества соединения у оператора (rtt/потери видео).
let qualityTimer = null;
function startQualityPolling(pc) {
  stopQualityPolling();
  qualityTimer = setInterval(async () => {
    try {
      const summary = summarizeStats(await pc.getStats());
      text($('remote-status'), formatQuality(t('status.connected'), summary));
    } catch { /* соединение закрывается — не критично */ }
  }, 2000);
}
function stopQualityPolling() {
  clearInterval(qualityTimer);
  qualityTimer = null;
}

export function cleanupSession() {
  stopMedia();
  enot.closeSignal().catch(() => {});
  streamPaused = false;
  text($('btn-pause-stream'), t('client.hideScreen'));
  state.session = null;
  state.pendingClaim = null;
  state.connect = null;
}

export function stopMedia() {
  try { state.localStream?.getTracks().forEach((track) => track.stop()); } catch { /* треки уже остановлены */ }
  try { state.dc?.close(); } catch { /* уже закрыт */ }
  for (const ch of Object.values(state.dcs ?? {})) { try { ch.close(); } catch { /* уже закрыт */ } }
  try { state.pc?.close(); } catch { /* уже закрыт */ }
  state.localStream = null; state.dc = null; state.pc = null;
  state.dcs = null; state.fileRx = null;
  state.iceQueue = [];
  $('remote-video').srcObject = null;
  stopSessionTimer();
  stopQualityPolling();
}

export function makePc(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => {
    if (e.candidate) enot.sendSignal({ type: 'signal', data: { candidate: e.candidate.toJSON() } }).catch(() => {});
  };
  // Host-сторона: принимает каналы оператора; сырой ввод уходит в main,
  // где парс/валидация/ворота/диспетчер — единый код (input-pipeline.mjs).
  pc.ondatachannel = (e) => wireHostChannel(e.channel);
  // Краткое дрожание сети ('disconnected') часто самовосстанавливается — даём
  // 10с грейс; 'failed' рвёт сразу (R15.2: не висим в вечном connected).
  let rtcGrace = null;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected') {
      rtcGrace ??= setTimeout(() => { rtcGrace = null; rtcLinkLost(); }, 10000);
      return;
    }
    if (pc.connectionState === 'connected') {
      if (rtcGrace) { clearTimeout(rtcGrace); rtcGrace = null; }
      return;
    }
    if (['failed', 'closed'].includes(pc.connectionState) && (state.session || state.connect)) rtcLinkLost();
  };
  return pc;
}

export function rtcLinkLost() {
  if (!state.session && !state.connect) return;
  const wasClient = state.role === 'client' || !!state.session;
  cleanupSession();
  if (wasClient) { text($('ended-reason'), endReasonText('rtc')); clientShow('ended'); }
  else { showConnectForm(); text($('conn-error'), endReasonText('rtc')); }
}

// Импорт в конце: представления импортируют cleanupSession из этого модуля,
// здесь же нужны только их функции времени исполнения — цикл безопасен.
import { clientShow } from './views/client-view.js';
import { showConnectForm } from './views/operator-view.js';

export function drainIce(pc) {
  for (const c of state.iceQueue) pc.addIceCandidate(c).catch(() => {});
  state.iceQueue = [];
}

export async function startHostRtc() {
  await showSourcePicker(async (id, pickEl) => {
    const stream = await acquireStream(id, pickEl);
    if (!stream) return;
    pickEl.remove();
    state.localStream = stream;
    const cfg = await enot.request('rtc.config', { asHost: true });
    const pc = makePc(cfg.body?.iceServers ?? []);
    state.pc = pc;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    applyVideoCap(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await enot.sendSignal({ type: 'signal', data: { description: { type: 'offer', sdp: pc.localDescription.sdp } } });
    clientShow('connected');
  });
}

// Выбор источника: экраны отдельно, окна — по одному; onChoose решает, стартовать
// трансляцию или заменить трек на ходу (replaceTrack, без ренегоциации).
async function showSourcePicker(onChoose) {
  const srcs = await enot.sources();
  if (!srcs.items?.length) throw new Error(t('client.noSources'));
  const pick = document.createElement('div');
  pick.className = 'card';
  pick.innerHTML = '<h2></h2><p class="muted"></p>';
  pick.querySelector('h2').textContent = t('client.pickTitle');
  pick.querySelector('p').textContent = t('client.pickSubtitle');
  const list = document.createElement('div');
  list.className = 'list';
  for (const s of srcs.items) {
    const item = document.createElement('button');
    item.className = 'btn wide';
    item.textContent = s.name || t('common.untitled');
    item.addEventListener('click', async () => {
      setBusyAll(list, true);
      try { await onChoose(s.id, pick); } catch { /* ошибка уже показана в статусах сеанса */ }
      setBusyAll(list, false);
    });
    list.appendChild(item);
  }
  pick.appendChild(list);
  $('view-client').appendChild(pick);
}

async function acquireStream(id, pickEl) {
  const sel = await enot.selectSource(id);
  if (!sel.ok) {
    text($('client-error-text'), sel.error ?? t('client.sourceUnavailable'));
    clientShow('error');
    pickEl.remove();
    return null;
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    const perms = await enot.permissions();
    text($('client-error-text'), perms.platform === 'darwin' ? t('client.permMac') : t('client.permOther'));
    clientShow('error');
    pickEl.remove();
    return null;
  }
}

// Потолок качества исходящего видео: 2.5 Мбит/с хватает для читаемого экрана.
function applyVideoCap(pc, maxBitrate = 2_500_000) {
  try {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const p = sender.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = maxBitrate;
      sender.setParameters(p).catch(() => { /* не применилось — не критично */ });
    }
  } catch { /* не критично */ }
}

export async function operatorAnswer(offerSdp) {
  const cfg = await enot.request('rtc.config', {});
  const pc = makePc(cfg.body?.iceServers ?? []);
  state.pc = pc;
  state.dc = pc.createDataChannel('input');
  wireOperatorInput(state.dc);
  // Каналы сессии (ADR 0014): чат, буфер, файлы — отдельные DC с allowlist-именами.
  const chatCh = pc.createDataChannel('chat');
  chatCh.onmessage = (m) => {
    const msg = parseChatMessage(m.data);
    if (msg) operatorChatMessage(msg.text);
  };
  const clipCh = pc.createDataChannel('clip');
  clipCh.onmessage = (m) => {
    const msg = parseClipMessage(m.data);
    if (msg) operatorClipMessage(msg.text);
  };
  const fileCh = pc.createDataChannel('file');
  fileCh.binaryType = 'arraybuffer';
  fileCh.onmessage = (m) => operatorFileMessage(fileCh, m.data);
  state.dcs = { input: state.dc, chat: chatCh, clip: clipCh, file: fileCh };
  pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0]; };
  startSessionTimer();
  startQualityPolling(pc);
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  drainIce(pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await enot.sendSignal({ type: 'signal', data: { description: { type: 'answer', sdp: pc.localDescription.sdp } } });
}

// Операторские обработчики сервисов — в session-services (без циклов импорта).
import { operatorChatMessage, operatorClipMessage, operatorFileMessage } from './session-services.js';
import { parseChatMessage } from '../lib/chat.mjs';
import { parseClipMessage } from '../lib/clipboard-sync.mjs';

// Видео-UX: полноэкранный режим, заполнение кадра, смена источника на ходу.
$('btn-fullscreen').addEventListener('click', () => {
  $('remote-video').requestFullscreen?.().catch(() => { /* пользователь отказал */ });
});
$('btn-fit').addEventListener('click', () => {
  const video = $('remote-video');
  const cover = video.classList.toggle('fit-cover');
  text($('btn-fit'), cover ? t('op.fitFit') : t('op.fitFill'));
});
$('btn-switch-source').addEventListener('click', () => {
  if (!state.pc) return;
  showSourcePicker(async (id, pickEl) => {
    const stream = await acquireStream(id, pickEl);
    if (!stream) return;
    pickEl.remove();
    const old = state.localStream;
    state.localStream = stream;
    const videoSender = state.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (videoSender) await videoSender.replaceTrack(stream.getVideoTracks()[0]);
    else for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
    applyVideoCap(state.pc);
    old?.getTracks().forEach((track) => track.stop());
  }).catch((e) => text($('client-error-text'), e.message));
});

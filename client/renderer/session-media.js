// Медиа сеанса: RTCPeerConnection, выбор и смена источника, качество,
// пауза трансляции, таймер, запуск/приём WebRTC-соединения.

import { $, enot, text, setBusyAll } from './dom.js';
import { state, endReasonText } from './state.js';
import { t } from '../lib/i18n.mjs';
import { wireOperatorInput } from './operator-input.js';
import { wireHostChannel } from './session-services.js';
import { setVideoEnabled } from '../lib/media-toggle.mjs';
import { summarizeStats, formatQuality } from '../lib/rtc-stats.mjs';
import { nextTarget, TOP_BITRATE } from '../lib/adaptive-bitrate.mjs';

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

// Адаптивный битрейт (A3): решение по тем же rtc-stats принимает чистая
// политика (adaptive-bitrate.mjs), применяет — host-сторона, потому что
// sender.setParameters есть только у отправителя видео. Потери своего
// исходящего потока host видит в remote-inbound-rtp (их дополняет
// summarizeStats), rtt — из candidate-pair своей стороны.
let adaptive = { target: TOP_BITRATE, lastChangeAt: 0 };
let adaptiveTimer = null;
function startAdaptive(pc) {
  stopAdaptive();
  adaptive = { target: TOP_BITRATE, lastChangeAt: 0 };
  adaptiveTimer = setInterval(async () => {
    try {
      const summary = summarizeStats(await pc.getStats());
      if (!summary) return;
      const now = Date.now();
      const { target, changed } = nextTarget(summary, adaptive.target, adaptive.lastChangeAt, now);
      if (!changed) return;
      adaptive = { target, lastChangeAt: now };
      applyVideoCap(pc, target);
    } catch { /* соединение закрывается — не критично */ }
  }, 2000);
}
function stopAdaptive() {
  clearInterval(adaptiveTimer);
  adaptiveTimer = null;
}

export function cleanupSession() {
  stopMedia();
  removeCaptureCard(); // карточка ретрая не переживает сеанс (ревью GLM-5.3 v0.3.0)
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
  stopAdaptive();
  adaptive = { target: TOP_BITRATE, lastChangeAt: 0 };
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

// Версия клиента: лениво, для диагностики в текстах ошибок.
let cachedVersion = null;
async function clientVersion() {
  if (!cachedVersion) {
    try { cachedVersion = await enot.appVersion(); } catch { cachedVersion = '?'; }
  }
  return cachedVersion;
}

// Диагностика отказа захвата: fallback-кнопка «Начать показ экрана» — повторная
// попытка без перезапуска сеанса. Карточка живёт модульно: удаляется при успехе,
// новом вызове и в cleanupSession — иначе переживает сеанс и запускает
// «призрачный» захват (ревью GLM-5.3 v0.3.0).
let captureCard = null;
function removeCaptureCard() {
  captureCard?.remove();
  captureCard = null;
}
function captureFailureUi() {
  removeCaptureCard();
  const card = document.createElement('div');
  card.className = 'card';
  const btn = document.createElement('button');
  btn.className = 'btn wide';
  btn.textContent = t('client.retryCapture');
  btn.addEventListener('click', async () => {
    // сеанс мог закончиться, пока карточка висела — призрачный захват не запускаем
    if (!state.session || state.pc) { removeCaptureCard(); return; }
    btn.disabled = true;
    try {
      removeCaptureCard();
      await startHostRtc();
    } catch { /* ошибка уже показана в статусах сеанса */ }
  });
  card.appendChild(btn);
  $('view-client').appendChild(card);
  captureCard = card;
  clientShow('error');
}

// Захват основного экрана без вопросов: согласие клиента уже дано — трансляция
// стартует сразу. reason: 'sel' — нет дисплеев/источника (честный текст уже
// показан), 'os' — ОС/Chromium отказал в самом захвате (perm-текст + версия).
async function acquirePrimaryStream() {
  const sel = await enot.selectPrimaryScreen();
  if (!sel.ok) {
    text($('client-error-text'), sel.error ?? t('client.sourceUnavailable'));
    clientShow('error');
    return { stream: null, reason: 'sel' };
  }
  try {
    return { stream: await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }), reason: null };
  } catch (err) {
    const perms = await enot.permissions();
    const v = await clientVersion();
    const detail = err && err.name ? ` (${err.name}: ${err.message ?? ''})` : '';
    text($('client-error-text'), (perms.platform === 'darwin' ? t('client.permMac') : t('client.permOther')) + ` [${t('client.captureVersionTag', { v })}]` + detail);
    clientShow('error');
    return { stream: null, reason: 'os' };
  }
}

export async function startHostRtc() {
  const got = await acquirePrimaryStream();
  if (!got.stream) {
    // perm-текст для 'os' уже показан в acquirePrimaryStream; для 'sel' — свой текст
    captureFailureUi();
    return;
  }
  const stream = got.stream;
  state.localStream = stream;
  // Честный статус нативного ввода (конвенция продукта): клиент и оператор видят,
  // работает ли инъекция — без этого «не двигается мышь» не диагностируется.
  try {
    const perms = await enot.permissions();
    const ni = perms.nativeInput ?? {};
    text($('client-input-status'), ni.available
      ? t('client.inputStatus', { backend: ni.platform })
      : t('client.inputUnavailable', { reason: ni.reason ?? 'native-unavailable' }));
  } catch { /* статус не критичен для трансляции */ }
  try {
    const cfg = await enot.request('rtc.config', { asHost: true });
    const pc = makePc(cfg.body?.iceServers ?? []);
    state.pc = pc;
    // Каналы данных создаёт офферер (ADR 0014): answer оператора не может
    // добавить m=application, которого нет в offer — иначе ввод/чат/файлы
    // никогда не согласуются (найдено живым сеансом 25.09).
    state.dc = pc.createDataChannel('input');
    const chatCh = pc.createDataChannel('chat');
    const clipCh = pc.createDataChannel('clip');
    const fileCh = pc.createDataChannel('file');
    fileCh.binaryType = 'arraybuffer';
    for (const ch of [state.dc, chatCh, clipCh, fileCh]) wireHostChannel(ch);
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    applyVideoCap(pc);
    startAdaptive(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await enot.sendSignal({ type: 'signal', data: { description: { type: 'offer', sdp: pc.localDescription.sdp } } });
  } catch (e) {
    // сбой после успешного захвата: гасим поток — иначе экран «течёт» без сеанса
    // и без кнопки (ревью GLM-5.3 v0.3.0)
    stopMedia();
    text($('client-error-text'), e?.message ?? t('common.serverError'));
    clientShow('error');
    return;
  }
  clientShow('connected');
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
  // Вызов идёт в ЖИВОМ сеансе (смена источника): при отказе не роняем клиента
  // в фатальный error-экран — сеанс и старый поток продолжаются (ревью GLM-5.3 v0.3.0)
  const sel = await enot.selectSource(id);
  if (!sel.ok) {
    text($('client-live-note'), sel.error ?? t('client.sourceUnavailable'));
    pickEl.remove();
    return null;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    pickEl.remove();
    return stream;
  } catch {
    const perms = await enot.permissions();
    text($('client-live-note'), perms.platform === 'darwin' ? t('client.permMac') : t('client.permOther'));
    pickEl.remove();
    return null;
  }
}

// Потолок качества исходящего видео: по умолчанию — текущая ступень
// адаптивного битрейта (в начале сеанса это верхняя, 2.5 Мбит/с), дальше
// startAdaptive ведёт её сам по качеству сети.
function applyVideoCap(pc, maxBitrate = adaptive.target) {
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
  // Каналы приходят от клиента-офферера (ADR 0014): answer не может добавлять
  // новые m=секции, поэтому createDataChannel здесь не согласуется никогда.
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    state.dcs ??= {};
    state.dcs[ch.label] = ch;
    if (ch.label === 'input') {
      state.dc = ch;
      wireOperatorInput(ch);
    } else if (ch.label === 'chat') {
      ch.onmessage = (m) => {
        const msg = parseChatMessage(m.data);
        if (msg) operatorChatMessage(msg.text);
      };
    } else if (ch.label === 'clip') {
      ch.onmessage = (m) => {
        const msg = parseClipMessage(m.data);
        if (msg) operatorClipMessage(msg.text);
      };
    } else if (ch.label === 'file') {
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (m) => operatorFileMessage(ch, m.data);
    }
  };
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
    if (!stream) {
      // отказ смены источника не роняет живой сеанс: остаёмся в connected с note
      clientShow('connected');
      return;
    }
    pickEl.remove();
    const old = state.localStream;
    state.localStream = stream;
    const videoSender = state.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (videoSender) await videoSender.replaceTrack(stream.getVideoTracks()[0]);
    else for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
    // Смена источника: держим текущую адаптивную ступень, не сбрасывая наверх.
    applyVideoCap(state.pc);
    old?.getTracks().forEach((track) => track.stop());
  }).catch((e) => text($('client-live-note'), e.message));
});

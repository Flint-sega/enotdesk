// Медиа сеанса: RTCPeerConnection, выбор и смена источника, качество,
// пауза трансляции, таймер, запуск/приём WebRTC-соединения.

import { $, enot, text, setBusyAll } from './dom.js';
import { state, endReasonText } from './state.js';
import { t } from '../lib/i18n.mjs';
import { wireOperatorInput } from './operator-input.js';
import { wireHostChannel, resetFileReceivers } from './session-services.js';
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
  // re-offer (грейс-переподключение хоста) пересобирает pc, но НЕ сбрасывает
  // счётчик длительности сеанса (ревью v0.4.3)
  if (sessionTimer) return;
  const startedAt = Date.now();
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
// Мультиоператор: per-viewer контроль (у каждого pc свой энкодер и свой REMB/
// TWCC — проще и точнее глобального VIDEO_QOS RustDesk). Ступень по каждому pc
// своя; новая ступень applyVideoCap-ится в свой sender.
function startAdaptiveIfNeeded() {
  if (adaptiveTimer) return;
  adaptiveTimer = setInterval(async () => {
    const now = Date.now();
    for (const op of state.operators.values()) {
      try {
        const summary = summarizeStats(await op.pc.getStats());
        if (!summary) continue;
        const { target, changed } = nextTarget(summary, op.adaptive.target, op.adaptive.lastChangeAt, now);
        if (!changed) continue;
        op.adaptive = { target, lastChangeAt: now };
        applyVideoCap(op.pc, target);
      } catch { /* соединение закрывается — не критично */ }
    }
  }, 2000);
}
function stopAdaptive() {
  clearInterval(adaptiveTimer);
  adaptiveTimer = null;
}

// №15 (ретест 28–29.09): по peer-reconnecting оператор не рвёт видео-сеанс по
// 10с rtc-таймеру — держим до server-grace + запас, чтобы новый оффер
// вернувшегося клиента дошёл до живого operatorAnswer. Клиент-роль (host) hold
// не берёт: его восстановление требует пере-оффера хоста (v0.5), честный
// локальный конец честнее замороженного экрана. Метка времени, а не таймер —
// меньше швов на чистку.
let rtcLinkHoldUntil = 0;
export function holdRtcLink(ms) {
  if (!(ms > 0)) return;
  rtcLinkHoldUntil = Math.max(rtcLinkHoldUntil, Date.now() + ms);
}
export function rtcLinkHoldActive() { return Date.now() < rtcLinkHoldUntil; }
function rtcLinkHoldRemainMs() { return Math.max(0, rtcLinkHoldUntil - Date.now()); }

export function cleanupSession() {
  stopMedia();
  enot.chatWidgetEnd?.(); // чат-виджет сессионный — закрываем вместе с сеансом
  removeCaptureCard(); // карточка ретрая не переживает сеанс (ревью GLM-5.3 v0.3.0)
  rtcLinkHoldUntil = 0; // hold №15 не переживает сеанс
  enot.closeSignal().catch(() => {});
  streamPaused = false;
  text($('btn-pause-stream'), t('client.hideScreen'));
  state.session = null;
  state.pendingClaim = null;
  state.connect = null;
}

export function stopMedia() {
  inputDetach?.detach?.(); // pointer-слушатели оператора не переживают сеанс
  inputDetach = null;
  stopAllOperators(); // персональные pc всех операторов закрываются вместе с сеансом
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
  // Гвард `state.pc !== pc`: pc заменён (reconnect в грейсе, новый оффер) — его
  // события и осиротевший 10с-таймер не должны убивать НОВОЕ подключение
  // (ревью v0.4.3, high: таймер стрелял в новый pc и ронял свежий сеанс).
  let rtcGrace = null;
  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) { if (rtcGrace) { clearTimeout(rtcGrace); rtcGrace = null; } return; }
    if (pc.connectionState === 'disconnected') {
      // Тик самовозобновляется, пока активен hold №15: по его истечении
      // застрявший 'disconnected'/'failed' честно разрывается (ревью v0.4.4)
      const tick = () => {
        rtcGrace = null;
        if (state.pc !== pc) return; // pc уже заменён — таймер чужой
        if (rtcLinkHoldActive()) { rtcGrace = setTimeout(tick, 10_000); return; }
        rtcLinkLost();
      };
      // Гонка №15 (ревью v0.4.6): серверный peer-reconnecting при тихой
      // заморозке приходит позже (~20-26 с), чем выстрелил бы локальный 10с-тик
      // — hold взводим уже здесь по известному серверному graceMs. Только
      // оператор (state.connect): клиент-роль hold не берёт — его честный
      // локальный конец через 10с ценнее замороженного экрана (инвариант №15)
      if (state.connect && !rtcLinkHoldActive() && (state.graceMs ?? 0) > 0) holdRtcLink(state.graceMs + 10_000);
      rtcGrace ??= setTimeout(tick, 10000);
      return;
    }
    if (pc.connectionState === 'connected') {
      if (rtcGrace) { clearTimeout(rtcGrace); rtcGrace = null; }
      rtcLinkHoldUntil = 0; // связь вернулась — hold №15 больше не нужен
      return;
    }
    if (['failed', 'closed'].includes(pc.connectionState) && (state.session || state.connect)) {
      // failed ПРЯМО под hold (свежий pc от re-offer минует 'disconnected'):
      // hold-тик не взведён — назначаем проверку на конец hold, иначе мёртвое
      // видео висело бы бессрочно (ревью v0.4.6, medium; паритет web)
      if (rtcLinkHoldActive()) {
        // Перепроверяем rtcLinkHoldActive() и при продлении hold
        // (peer-reconnecting пришёл позже) ждём уже НОВЫЙ конец — иначе рвали
        // бы сеанс до истечения продлённого hold (ревью v0.4.6, доводка)
        const recheck = () => {
          rtcGrace = null;
          if (state.pc !== pc) return; // pc уже заменён — таймер чужой
          if (rtcLinkHoldActive()) { rtcGrace = setTimeout(recheck, rtcLinkHoldRemainMs() + 100); return; }
          rtcLinkLost();
        };
        rtcGrace ??= setTimeout(recheck, rtcLinkHoldRemainMs() + 100);
        return;
      }
      rtcLinkLost();
    }
  };
  return pc;
}

// Слушатели ввода оператора текущего сеанса: снимаются при конце сеанса и при
// перепроводке канала (re-offer) — иначе накапливаются на единственном видео.
let inputDetach = null;

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
export function removeCaptureCard() {
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

// Эпоха сборки host-RTC: invalidateHostRtc() (грейс-сброс из main) инвалидирует
// висящий в await'ах старт — без этого rtc-reset открывает окно двойного старта
// (два pc/два offer/утёкший захват; ревью v0.4.3, подтверждено репро).
let hostRtcEpoch = 0;
let hostRtcStarting = false;
export function invalidateHostRtc() {
  hostRtcEpoch += 1;
  hostRtcStarting = false; // новый старт разрешён немедленно; старый выйдет по эпохе
}

export async function startHostRtc() {
  if (hostRtcStarting) return;
  hostRtcStarting = true;
  const epoch = hostRtcEpoch;
  try {
    const got = await acquirePrimaryStream();
    if (epoch !== hostRtcEpoch) { got.stream?.getTracks().forEach((track) => track.stop()); return; }
    if (!got.stream) {
      // perm-текст для 'os' уже показан в acquirePrimaryStream; для 'sel' — свой текст
      captureFailureUi();
      return;
    }
    const stream = got.stream;
    if (epoch !== hostRtcEpoch) { stream.getTracks().forEach((track) => track.stop()); return; }
    state.localStream = stream;
    // Пауза трансляции переживает грейс-переподключение: новый стрим обязан
    // наследовать «Скрыть экран», иначе после reconnect'а оператор снова видит
    // экран при UI «на паузе» (ревью v0.4.3, приватность).
    setVideoEnabled(stream, !streamPaused);
    // Честный статус нативного ввода (конвенция продукта): клиент и оператор видят,
    // работает ли инъекция — без этого «не двигается мышь» не диагностируется.
    try {
      const perms = await enot.permissions();
      if (epoch !== hostRtcEpoch) return;
      const ni = perms.nativeInput ?? {};
      text($('client-input-status'), ni.available
        ? t('client.inputStatus', { backend: ni.platform })
        : t('client.inputUnavailable', { reason: ni.reason ?? 'native-unavailable' }));
    } catch { /* статус не критичен для трансляции */ }
    // pc больше НЕТ на этом этапе: мультиоператор — хост поднимает ПЕРСОНАЛЬНЫЙ
    // pc на каждого оператора в attachOperator (по operator-joined c claimId)
    flushPendingAttaches();
  } catch (e) {
    // устаревший старт (эпоха сменилась): СВОИ ресурсы не трогаем через stopMedia —
    // там уже состояние нового старта; частичное гасит stale-пути выше
    if (epoch !== hostRtcEpoch) return;
    // сбой после успешного захвата: гасим поток — иначе экран «течёт» без сеанса
    // и без кнопки (ревью GLM-5.3 v0.3.0); 'ended' не затираем (гонка await)
    stopMedia();
    if (state.session) {
      text($('client-error-text'), e?.message ?? t('common.serverError'));
      clientShow('error');
    }
    return;
  } finally {
    // флаг сбрасывает только АКТУАЛЬНЫЙ старт: устаревший (эпоха сменилась)
    // не затирает флаг нового, иначе третий реплей запустит параллельный старт
    if (epoch === hostRtcEpoch) hostRtcStarting = false;
  }
  clientShow('connected');
}

// ---------------------------------------------------------------------------
// Мультиоператор (модель RustDesk, N подписчиков на один поток): захваченный
// track расшаривается в ПЕРСОНАЛЬНЫЙ pc каждого оператора (pc-per-operator).
// offer адресуется (to:claimId), answer/ICE оператора тегируются сервером
// (from) и роутятся сюда по claimId. Ввод обоих операторов идёт в одну
// очередь инъекции — last-write-wins (input-pipeline).
// ---------------------------------------------------------------------------

const pendingAttaches = new Set(); // claimId: operator-joined до готовности захвата
const reattachTimers = new Map(); // claimId → таймер пере-оффера

function flushPendingAttaches() {
  for (const claimId of [...pendingAttaches]) attachOperator(claimId).catch(() => {});
  pendingAttaches.clear();
}

// Само-восстановление после approved-replay: пере-оффер операторам, чей pc
// не подключён (персональный pc живёт P2P и обычно переживает сигналинг)
export function rehomeOperators() {
  flushPendingAttaches();
  for (const [claimId, op] of state.operators) {
    if (op.pc.connectionState !== 'connected') scheduleReattach(claimId);
  }
}

// Роутинг op→host сигналов (answer/ICE тегированы сервером from=claimId):
// доставляются в персональный pc этого оператора; чужие/устаревшие — молча.
export function routeOperatorSignal(from, data) {
  const op = from ? state.operators.get(from) : null;
  if (!op) return;
  if (data.description) {
    if (data.description.type !== 'answer') return;
    op.pc.setRemoteDescription({ type: 'answer', sdp: data.description.sdp })
      .then(() => {
        for (const c of op.iceQueue) op.pc.addIceCandidate(c).catch(() => {});
        op.iceQueue.length = 0;
      })
      .catch(() => { /* некорректный answer — pc не портим */ });
    return;
  }
  if (data.candidate) {
    const c = data.candidate;
    if (op.pc.remoteDescription) op.pc.addIceCandidate(c).catch(() => {});
    else op.iceQueue.push(c);
  }
}

export function attachOperator(claimId, name = '') {
  if (!claimId || typeof claimId !== 'string') return;
  if (state.operators.has(claimId)) return; // уже подключён (upsert не нужен)
  if (!state.localStream || !state.session) {
    pendingAttaches.add(claimId); // захват ещё не готов — доиграем после
    return;
  }
  attachOperatorNow(claimId, name).catch(() => {
    // пере-оффер по таймеру: операторский WS жив — сервер доставит
    scheduleReattach(claimId);
  });
}

function scheduleReattach(claimId) {
  if (!state.session || reattachTimers.has(claimId)) return;
  reattachTimers.set(claimId, setTimeout(() => {
    reattachTimers.delete(claimId);
    if (state.session && !state.operators.has(claimId)) {
      attachOperator(claimId).catch(() => {});
    }
  }, 3000));
}

async function attachOperatorNow(claimId, name) {
  const cfg = await enot.request('rtc.config', { asHost: true });
  if (!state.localStream || !state.session || state.operators.has(claimId)) return;
  const pc = makePcOperator(claimId, cfg.body?.iceServers ?? []);
  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  applyVideoCap(pc);
  const op = { pc, iceQueue: [], dcs: {}, name, adaptive: { target: adaptive.target, lastChangeAt: Date.now() } };
  state.operators.set(claimId, op);
  startAdaptiveIfNeeded(); // первый подписчик — цикл per-viewer ступеней
  // Каналы создаёт офферер (ADR 0014): per-operator набор input/chat/clip/file
  for (const label of ['input', 'chat', 'clip', 'file']) {
    const ch = pc.createDataChannel(label);
    if (label === 'file') ch.binaryType = 'arraybuffer';
    wireHostChannel(ch, claimId);
  }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await enot.sendSignal({ type: 'signal', to: claimId, data: { description: { type: 'offer', sdp: pc.localDescription.sdp } } });
}

function makePcOperator(claimId, iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      enot.sendSignal({ type: 'signal', to: claimId, data: { candidate: e.candidate.toJSON() } }).catch(() => {});
    }
  };
  pc.ondatachannel = (e) => wireHostChannel(e.channel, claimId);
  // Персональный pc: его смерть ≠ смерть сеанса (другие операторы не трогаются).
  // Оператор перезапустится: host пере-офферит по таймеру (answerChain у
  // оператора пересобирает pc на каждый новый offer — само-восстановление).
  let opGrace = null;
  pc.onconnectionstatechange = () => {
    const op = state.operators.get(claimId);
    if (!op || op.pc !== pc) return; // оператор уже заменён/удалён — таймер чужой
    if (pc.connectionState === 'connected') {
      if (opGrace) { clearTimeout(opGrace); opGrace = null; }
      return;
    }
    if (pc.connectionState === 'disconnected') {
      opGrace ??= setTimeout(() => {
        opGrace = null;
        const cur = state.operators.get(claimId);
        if (!cur || cur.pc !== pc || pc.connectionState === 'connected') return;
        dropOperator(claimId);
        scheduleReattach(claimId);
      }, 10_000);
      return;
    }
    if (['failed', 'closed'].includes(pc.connectionState)) {
      if (opGrace) { clearTimeout(opGrace); opGrace = null; }
      dropOperator(claimId);
      scheduleReattach(claimId);
    }
  };
  return pc;
}

export function dropOperator(claimId) {
  const op = state.operators.get(claimId);
  if (!op) return;
  try { op.pc.close(); } catch { /* уже закрыт */ }
  for (const ch of Object.values(op.dcs)) { try { ch.close(); } catch { /* уже закрыт */ } }
  state.operators.delete(claimId);
  resetFileReceivers(claimId); // недокачанный файл этого оператора — вместе с каналом
  if (!state.operators.size) stopAdaptive(); // подписчиков нет — захват не крутится вхолостую (аналог has_subscribes у RustDesk)
}

function stopAllOperators() {
  for (const claimId of [...state.operators.keys()]) dropOperator(claimId);
  for (const t of reattachTimers.values()) clearTimeout(t);
  reattachTimers.clear();
  pendingAttaches.clear();
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

// Полный сброс host-RTC при грейс-переподключении (main шлёт 'rtc-reset' только
// host-роли). Мультиоператор: pc операторов — P2P, смерть сигналинга хоста их
// НЕ убивает; захваченный трек тоже живёт (его остановка = обрыв видео всем).
// Сбрасываем только стартовые флаги и карточку ретрая; операторы пере-офферятся
// по необходимости (сервер реплеит operator-joined, attachOperator доцепит).
export function resetHostRtcState() {
  invalidateHostRtc();
  removeCaptureCard();
}

// Ответы на офферы строго последовательно: два конкурентных вызова (гонка
// офферов при быстрых reconnect'ах) оставляли зомби-pc, таймеры на мёртвом pc
// и устаревший answer (ревью v0.4.3, medium — воспроизведено на web-твине).
let answerChain = Promise.resolve();

export function operatorAnswer(offerSdp) {
  const run = answerChain.catch(() => {}).then(() => doOperatorAnswer(offerSdp));
  answerChain = run.catch(() => {});
  return run;
}

async function doOperatorAnswer(offerSdp) {
  // Чистку старого pc/каналов делаем ДО await (ревью v0.4.3): в окне
  // await rtc.config кандидаты нового оффера уходили в СТАРЫЙ pc и терялись
  // безвозвратно. Очередь кандидатов НЕ чистим: чужая генерация отбрасывается
  // новым pc по ufrag нативно, своя — доезжает через drainIce (wipe стирал
  // кандидаты «своего» оффера в гонке — ревью v0.4.3 доводка).
  try { state.pc?.close(); } catch { /* уже закрыт */ }
  for (const ch of Object.values(state.dcs ?? {})) { try { ch.close(); } catch { /* уже закрыт */ } }
  state.pc = null; state.dc = null; state.dcs = {}; state.fileRx = null;
  const connect = state.connect; // эпоха оператора: 'ended' во время await обнуляет её
  if (!connect) return; // сеанс уже мёртв на входе — pc и таймеры не создаём
  const cfg = await enot.request('rtc.config', {});
  if (state.connect !== connect) {
    // сеанс завершился, пока мы получали конфиг: не воскрешаем pc и таймеры.
    // (Старый pc закрыт выше, закрывать здесь нечего — только не создаём новый.)
    return;
  }
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
      // #remote-video один на все сеансы страницы: прежние pointer-слушатели
      // снимаем, иначе каждый re-offer/сеанс навсегда добавлял бы по четыре
      // (паритет web-твину inputDetach, ревью v0.4.6 доводка)
      inputDetach?.detach?.();
      inputDetach = wireOperatorInput(ch);
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
  // Фолбэк как в web-панели (web/operator.mjs): replaceTrack без трека даёт
  // answer без msid — e.streams пуст и без обёртки MediaStream([e.track])
  // настольный оператор смотрел в чёрный экран (приёмка 03.10, V8-находка)
  pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0] ?? new MediaStream([e.track]); };
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
  if (!state.localStream) return;
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
    // Смена источника: track подменяется в КАЖДОМ персональном pc (мультиоператор)
    for (const op of state.operators.values()) {
      const videoSender = op.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (videoSender) await videoSender.replaceTrack(stream.getVideoTracks()[0]);
      else for (const track of stream.getTracks()) op.pc.addTrack(track, stream);
      // Смена источника: держим текущую адаптивную ступень, не сбрасывая наверх.
      applyVideoCap(op.pc);
    }
    old?.getTracks().forEach((track) => track.stop());
  }).catch((e) => text($('client-live-note'), e.message));
});

// Медиа сеанса клиента помощи (host): захват экрана, выбор и смена источника,
// пауза трансляции, персональные pc операторов, адаптивный битрейт.
// Операторская сторона — программа оператора с сервера (ADR 0033, этап 3).

import { $, enot, text, setBusyAll, errorText } from './dom.js';
import { state } from './state.js';
import { t } from '../lib/i18n.mjs';
import { wireHostChannel, resetFileReceivers } from './session-services.js';
import { videoAllowed } from '../lib/multiop-limits.mjs';
import { setVideoEnabled } from '../lib/media-toggle.mjs';
import { summarizeStats } from '../lib/rtc-stats.mjs';
import { nextTarget, TOP_BITRATE } from '../lib/adaptive-bitrate.mjs';
// Цикл client-view ↔ session-media безопасен: client-view берёт cleanupSession
// только во время исполнения, здесь clientShow — тоже.
import { clientShow } from './views/client-view.js';

// Пауза трансляции: чёрные кадры оператору, явный статус у клиента.
let streamPaused = false;
$('btn-pause-stream').addEventListener('click', () => {
  if (!state.localStream) return;
  streamPaused = !streamPaused;
  setVideoEnabled(state.localStream, !streamPaused);
  text($('btn-pause-stream'), streamPaused ? t('client.showScreen') : t('client.hideScreen'));
  text($('client-live-note'), streamPaused ? t('client.pausedNote') : '');
});

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

export function cleanupSession() {
  stopMedia();
  enot.chatWidgetEnd?.(); // чат-виджет сессионный — закрываем вместе с сеансом
  removeCaptureCard(); // карточка ретрая не переживает сеанс (ревью GLM-5.3 v0.3.0)
  enot.closeSignal().catch(() => {});
  streamPaused = false;
  text($('btn-pause-stream'), t('client.hideScreen'));
  state.session = null;
  state.pendingClaim = null;
  state.inputActiveClaimId = null; // арбитраж сеанса не протекает в следующий (P3-1)
}

export function stopMedia() {
  stopAllOperators(); // персональные pc всех операторов закрываются вместе с сеансом
  try { state.localStream?.getTracks().forEach((track) => track.stop()); } catch { /* треки уже остановлены */ }
  for (const ch of Object.values(state.dcs ?? {})) { try { ch.close(); } catch { /* уже закрыт */ } }
  state.localStream = null;
  state.dcs = null;
  stopAdaptive();
  adaptive = { target: TOP_BITRATE, lastChangeAt: 0 };
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
  card.className = 'card capture-card';
  const btn = document.createElement('button');
  btn.className = 'cta';
  btn.textContent = t('client.retryCapture');
  btn.addEventListener('click', async () => {
    // сеанс мог закончиться, пока карточка висела — призрачный захват не запускаем
    if (!state.session || state.localStream) { removeCaptureCard(); return; }
    btn.disabled = true;
    try {
      removeCaptureCard();
      await startHostRtc();
    } catch { /* ошибка уже показана в статусах сеанса */ }
  });
  // Сеанс жив (согласие дано), поэтому «Повторить» экрана ошибки здесь не к месту
  // (CSS прячет его при карточке) — выход из сеанса даёт своя кнопка
  const stop = document.createElement('button');
  stop.className = 'btn danger-ghost';
  stop.textContent = t('client.endSession');
  stop.addEventListener('click', () => { removeCaptureCard(); $('btn-stop').click(); });
  const row = document.createElement('div');
  row.className = 'row';
  row.append(btn, stop);
  card.appendChild(row);
  $('client-error').after(card); // правая колонка компактного окна, под текстом причины
  captureCard = card;
  clientShow('error');
}

// Отказ ОС в захвате: честный текст про разрешение «Запись экрана» + версия и
// техническая деталь (без префикса IPC-обёртки Electron)
async function showCaptureDenied(err) {
  const perms = await enot.permissions();
  const v = await clientVersion();
  const detail = err && err.name ? ` (${err.name}: ${errorText(err)})` : '';
  text($('client-error-text'), (perms.platform === 'darwin' ? t('client.permMac') : t('client.permOther')) + ` [${t('client.captureVersionTag', { v })}]` + detail);
  clientShow('error');
  return { stream: null, reason: 'os' };
}

// Захват основного экрана без вопросов: согласие клиента уже дано — трансляция
// стартует сразу. reason: 'sel' — нет дисплеев/источника (честный текст уже
// показан), 'os' — ОС/Chromium отказал в самом захвате (perm-текст + версия).
async function acquirePrimaryStream() {
  let sel;
  // macOS без «Записи экрана» отказывает уже на списке экранов (desktopCapturer
  // бросает «Failed to get sources») — это тот же отказ ОС, а не сбой сеанса
  try { sel = await enot.selectPrimaryScreen(); } catch (err) { return showCaptureDenied(err); }
  if (!sel.ok) {
    text($('client-error-text'), sel.error ?? t('client.sourceUnavailable'));
    clientShow('error');
    return { stream: null, reason: 'sel' };
  }
  try {
    return { stream: await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }), reason: null };
  } catch (err) {
    return showCaptureDenied(err);
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

const pendingAttaches = new Map(); // claimId → имя: operator-joined до готовности захвата (ревью G P3-3: имя не терять)
const reattachTimers = new Map(); // claimId → таймер пере-оффера

function flushPendingAttaches() {
  for (const [claimId, name] of [...pendingAttaches]) attachOperator(claimId, name).catch(() => {});
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

// async не для await: все ранние выходы обязаны возвращать Promise —
// вызывающие вешают .catch (живая приёмка v0.6.2: undefined.catch ронял
// startHostRtc в «Не удалось начать» сразу после «Разрешить»)
export async function attachOperator(claimId, name = '') {
  if (!claimId || typeof claimId !== 'string') return;
  if (state.operators.has(claimId)) return; // уже подключён (upsert не нужен)
  if (!state.localStream || !state.session) {
    pendingAttaches.set(claimId, name); // захват ещё не готов — доиграем после (с именем)
    return;
  }
  try {
    await attachOperatorNow(claimId, name);
  } catch {
    // пере-оффер по таймеру: операторский WS жив — сервер доставит
    scheduleReattach(claimId);
  }
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
  // Cap видеослотов (W-C5): сверх MULTIOP_VIDEO_CAP pc строится БЕЗ видео —
  // чат/файлы/терминал работают, оператор получит честный session-info.
  const grantVideo = videoAllowed(videoOperatorCount());
  if (grantVideo) {
    for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
    applyVideoCap(pc);
  }
  const op = { pc, iceQueue: [], dcs: {}, name, noVideo: !grantVideo, adaptive: { target: adaptive.target, lastChangeAt: Date.now() } };
  state.operators.set(claimId, op);
  enot.inputAttach(claimId).catch(() => {}); // арбитраж (W-C4): одинокий получит ввод сам
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
  enot.inputDrop(claimId).catch(() => {}); // арбитраж (W-C4): ввод ушедшего освобождается
  try { op.pc.close(); } catch { /* уже закрыт */ }
  for (const ch of Object.values(op.dcs)) { try { ch.close(); } catch { /* уже закрыт */ } }
  state.operators.delete(claimId);
  resetFileReceivers(claimId); // недокачанный файл этого оператора — вместе с каналом
  if (!state.operators.size) stopAdaptive(); // подписчиков нет — захват не крутится вхолостую (аналог has_subscribes у RustDesk)
}

// Живые операторы с видео (для cap'а W-C5): деградированные (noVideo) слот не занимают.
function videoOperatorCount() {
  let n = 0;
  for (const op of state.operators.values()) if (!op.noVideo) n += 1;
  return n;
}

// Арбитраж (W-C4): main сменил активного вводчика — grants уходят всем
// операторам по их input-каналам, клиенту честный бейдж «кто управляет».
enot.onInputActive?.(({ claimId } = {}) => {
  state.inputActiveClaimId = claimId ?? null; // кэш для начального гранта (P3-1)
  for (const [opId, op] of state.operators) {
    const ch = op.dcs?.input;
    if (!ch || ch.readyState !== 'open') continue;
    try { ch.send(JSON.stringify({ type: 'input-grant', granted: opId === claimId })); } catch { /* канал закрывается */ }
  }
  const note = $('client-control-note');
  if (!note) return;
  if (claimId) text(note, t('client.controlBy', { name: state.operators.get(claimId)?.name || claimId }));
  else text(note, state.operators.size ? t('client.controlFree') : '');
});

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

// Смена источника трансляции на ходу (без ренегоциации).
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

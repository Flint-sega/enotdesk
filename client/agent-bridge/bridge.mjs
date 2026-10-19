// Страница-мост терминала и сервисов machine-сеанса (R09 + W-U6): RTCPeerConnection
// есть только в renderer, поэтому pc агента живёт в этом скрытом окне. Сигналинг
// (offer/answer/ICE) и данные DataChannel релеются в main через preload (agentRtc;
// имена каналов — BRIDGE_IPC в relay.mjs, метки — allowlist BRIDGE_DC_LABELS:
// term/chat/file/input, прочие каналы честно закрываются). Бэкпрешшн: при
// переполнении dc.bufferedAmount просим main приостановить отправку (PAUSE),
// после опустошения (bufferedamountlow) — возобновить (RESUME); пауза per-op.
//
// Мультиоператор (волна C, W-C2): pc ПЕРСОНАЛЬНЫЙ каждому оператору — Map<op, …>
// в одном окне; адресация сообщений — полем op в payload (отсутствие op =
// 'primary', легаси). Видео: JPEG-кадры хелпера рисуются на ОДИН canvas, один
// canvas.captureStream-track расшаривается replaceTrack'ом в видеотрансивер
// каждого pc (аналог одного localStream в N pc attended-хоста). Смерть pc
// оператора (обрыв/уход — main шлёт DC_TO {op, close:true}) не трогает остальных.
// Cap видеослотов (W-C5): сверх MULTIOP_VIDEO_CAP новый pc получает
// видеотрансивер inactive и честный session-info по input-каналу.

import { videoAllowed } from '../lib/multiop-limits.mjs';
import { summarizeStats } from '../lib/rtc-stats.mjs';
import { nextTarget, TOP_BITRATE } from '../lib/adaptive-bitrate.mjs';

const api = window.agentRtc;
if (!api) {
  // preload не предоставил мост — честно сообщить некому, остаётся консоль окна
  console.error('agent-bridge: preload не предоставил agentRtc');
} else {
  const peers = new Map(); // op → {pc, dcs: Map<label, {ch}>, videoAttached, videoDenied, paused}
  // Видео-хелпер (ADR 0027): JPEG-кадры рисуются на canvas, track уходит в
  // recvonly-трансивер оператора через replaceTrack (без ренеготиации).
  // canvas/videoTrack/videoSeq — ОДНИ на страницу: кадры рисуются один раз.
  let videoCanvas = null;
  let videoCtx = null;
  let videoTrack = null;
  let videoSeq = 0; // пропуск устаревших кадров: декодируем только свежий
  // TURN-конфиг приходит из main до offer (ICE_CONFIG, общий для всех pc);
  // пусто или сбой — прямое LAN-соединение, причина честно видна в логе окна.
  let iceServers = [];
  let iceReason = null;
  const HIGH_WATER = 1 << 20; // байт в буфере DataChannel — просим main притормозить
  const LOW_WATER = 256 * 1024; // опустело ниже — разрешаем снова
  // Зеркало allowlist релея (BRIDGE_DC_LABELS): чат и файлы machine-сеанса (W-U6)
  // проходят в main; всё прочее закрывается здесь же, в рендерере.
  const LABELS = new Set(['term', 'chat', 'file', 'input']);

  const opOf = (v) => (typeof v === 'string' && v ? v : 'primary');

  function videoPeerCount() {
    let n = 0;
    for (const p of peers.values()) if (!p.videoDenied) n += 1;
    return n;
  }

  // Служебное сообщение хоста оператору по input-каналу (W-C5): честный статус
  // «видеослоты заняты» — деградация видна, а не выглядит чёрным экраном-загадкой.
  const SESSION_INFO_VIDEO_FULL = JSON.stringify({ type: 'session-info', video: false, reason: 'video-slots-full' });

  // Адаптивный битрейт машинного видео (ADR 0030/0031 обещали потолок, 19.10 —
  // решение владельца: «умная подстройка»): та же лестница и та же чистая
  // политика, что у attended-хоста (session-media.js), — у КАЖДОГО pc своя
  // ступень по его же статистике (per-viewer). Старт — TOP_BITRATE при
  // привязке трека; дальше раз в ABR_INTERVAL_MS решает nextTarget.
  // api.abrIntervalMs задаёт только тестовый фейк preload (боевой не задаёт).
  const ABR_INTERVAL_MS = Number(api.abrIntervalMs) > 0 ? Number(api.abrIntervalMs) : 2000;
  let abrTimer = null;

  async function applyVideoCap(peer, maxBitrate) {
    const sender = peer.videoSender;
    if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    try {
      const p = sender.getParameters();
      p.encodings = p.encodings?.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = maxBitrate;
      await sender.setParameters(p);
    } catch (e) {
      // не применилось (pc закрывается/ренеготиация) — следующий тик повторит
      console.warn(`agent-bridge: setParameters отказал (${e?.message ?? e})`);
    }
  }

  async function adaptTick() {
    const now = Date.now();
    for (const peer of peers.values()) {
      if (!peer.videoAttached || typeof peer.pc.getStats !== 'function') continue;
      try {
        const summary = summarizeStats(await peer.pc.getStats());
        if (!summary) continue;
        const { target, changed } = nextTarget(summary, peer.adaptive.target, peer.adaptive.lastChangeAt, now);
        if (!changed) continue;
        peer.adaptive = { target, lastChangeAt: now };
        await applyVideoCap(peer, target);
      } catch { /* pc закрывается — не критично */ }
    }
  }

  function ensureAdaptive() {
    if (abrTimer) return;
    abrTimer = setInterval(() => { void adaptTick(); }, ABR_INTERVAL_MS);
    abrTimer?.unref?.(); // вне браузера (тесты) таймер не держит процесс
  }

  function stopAdaptiveIfIdle() {
    if (abrTimer && peers.size === 0) {
      clearInterval(abrTimer);
      abrTimer = null;
    }
  }

  function closePeer(op) {
    const peer = peers.get(op);
    if (!peer) return;
    peers.delete(op);
    stopAdaptiveIfIdle();
    for (const ch of peer.dcs.values()) {
      try { ch.close(); } catch { /* уже закрыт */ }
    }
    try { peer.pc.close(); } catch { /* уже закрыт */ }
  }

  api.onIceConfig?.((cfg) => {
    iceServers = Array.isArray(cfg?.iceServers) ? cfg.iceServers : [];
    iceReason = typeof cfg?.reason === 'string' && cfg.reason ? cfg.reason : null;
    if (iceReason) console.warn(`agent-bridge: ${iceReason}`);
  });

  // Кадр → canvas → track. Первый кадр создаёт canvas/track; привязка к
  // видео-трансиверу ПОВТОРЯЕТСЯ на каждом кадре до успеха (v0.6 fix ревью:
  // гонка «кадр раньше offer'а» оставляла видео мёртвым весь сеанс). Устаревшие
  // кадры (пришли во время декодирования предыдущего) пропускаются по счётчику.
  // Мультиоператор: один track расшаривается во ВСЕ pc без видео-отказа (W-C2).
  async function attachVideoTrack(op) {
    const peer = peers.get(op);
    if (!peer || peer.videoAttached || peer.videoDenied || !videoTrack) return;
    // Волна G (баг-1, win-агент): кадры хелпера льются непрерывно, и
    // replaceTrack выполнялся на трансивере ВТОРОГО pc ДО его
    // setLocalDescription (signalingState 'have-remote-offer'): answer
    // формируется и уходит, а ICE-агент pc молчит — проверки оператора
    // доходят до порта pc в одну сторону (живая приёмка G, 5/5; на linux
    // gdm-кадры стартуют позже и гонка не ловилась). Трек цепляем только к
    // УЖЕ согласованному pc — следующий кадр (≤40 мс) повторит попытку.
    if (!peer.pc.localDescription || peer.pc.signalingState !== 'stable') return;
    const vt = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');
    if (!vt) return; // offer ещё не применён — повторим на следующем кадре
    try {
      await vt.sender.replaceTrack(videoTrack);
      peer.videoAttached = true;
      // потолок с первой секунды: верхняя ступень, дальше ведёт adaptTick
      peer.videoSender = vt.sender;
      await applyVideoCap(peer, peer.adaptive.target);
      ensureAdaptive();
    } catch (e) {
      console.warn(`agent-bridge: replaceTrack отказал (${e?.message ?? e}) — повторим`);
    }
  }

  async function drawVideoFrame(jpeg) {
    try {
      helperLive = true; // кадры хелпера пошли — gdm-захват (ADR 0031) самоотключается
      stopGdm('helper');
      const seq = ++videoSeq;
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (seq !== videoSeq) { bitmap.close?.(); return; }
      ensureCanvas(bitmap.width, bitmap.height);
      videoCtx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      for (const op of peers.keys()) await attachVideoTrack(op);
    } catch { /* битый кадр пропускаем — следующий будет */ }
  }

  api.onVideoFrame?.((jpeg) => { void drawVideoFrame(jpeg); });

  // ADR 0031: Linux-захват без хелпера — getDisplayMedia в тот же canvas
  // (конвейер один: canvas-track → replaceTrack каждому pc). Main включает
  // режим посылкой video-mode (только linux, env EDESK_AGENT_VIDEO≠off);
  // кадры Windows-хелпера всегда приоритетнее.
  let helperLive = false;
  let gdmStarted = false;
  let gdmStopped = false;
  let gdmEl = null;
  let gdmStream = null;
  function ensureCanvas(w, h) {
    if (!videoCanvas) {
      videoCanvas = document.createElement('canvas');
      videoCanvas.width = w;
      videoCanvas.height = h;
      videoCtx = videoCanvas.getContext('2d');
      videoTrack = videoCanvas.captureStream(24).getVideoTracks()[0] ?? null;
    } else if (videoCanvas.width !== w || videoCanvas.height !== h) {
      videoCanvas.width = w;
      videoCanvas.height = h;
    }
  }
  function stopGdm(reason) {
    if (!gdmStarted || gdmStopped) return;
    gdmStopped = true;
    try { gdmStream?.getTracks().forEach((t) => t.stop()); } catch { /* уже мёртв */ }
    try { gdmEl?.pause(); } catch { /* уже мёртв */ }
    gdmEl = null; gdmStream = null;
    api.gdmStatus?.('stopped', reason);
  }
  async function startGdm() {
    if (gdmStarted || helperLive || gdmStopped) return;
    gdmStarted = true;
    try {
      gdmStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (helperLive) { stopGdm('helper'); return; }
      gdmEl = document.createElement('video');
      gdmEl.srcObject = gdmStream;
      gdmEl.muted = true;
      await gdmEl.play();
      const pump = () => {
        if (gdmStopped) return;
        if (helperLive) { stopGdm('helper'); return; }
        const w = gdmEl.videoWidth || 0, h = gdmEl.videoHeight || 0;
        if (w && h) {
          ensureCanvas(w, h);
          videoCtx.drawImage(gdmEl, 0, 0);
          for (const op of peers.keys()) void attachVideoTrack(op);
        }
        gdmEl.requestVideoFrameCallback(pump);
      };
      gdmEl.requestVideoFrameCallback(pump);
      api.gdmStatus?.('running', '');
    } catch (e) {
      gdmStopped = true;
      // Честный отказ: нет DISPLAY/XAUTHORITY, Wayland-без-портала и т.п. —
      // оператор видит статус, кадры никогда не фейкаются.
      api.gdmStatus?.('unavailable', String(e?.message ?? e).slice(0, 200));
    }
  }
  api.onVideoMode?.((cfg) => { if (cfg?.gdm) void startGdm(); });

  function answerChain(op, offerSdp) {
    const peer = peers.get(op);
    const pc = peer?.pc;
    if (!pc) return;
    pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      .then(() => {
        // Оператор офферит видео recvonly (machine-сеанс, ADR 0027): отвечаем
        // sendonly — кадры хелпера уйдут в этот трансивер через replaceTrack
        // без ренеготиации. В attended-сеансах видео-трансивера нет — no-op.
        // Cap (W-C5): видеослоты заняты — трансивер inactive, оператор получает
        // честный session-info; чат/файлы/терминал работают без видео.
        // Ревью 16.10 P2-2: ренеготиация уже-видео оператора (re-offer того же
        // op, например переоткрытие терминала) кап НЕ пересчитывает — иначе на
        // полном капе штатное действие демонтировало бы его видео навсегда.
        const vt = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
        if (vt) {
          const renegotiatingWithVideo = !peer.videoDenied && vt.direction !== 'inactive';
          if (renegotiatingWithVideo || videoAllowed(videoPeerCount())) {
            vt.direction = 'sendonly';
            // attachVideoTrack НЕ зовём: здесь signalingState 'have-remote-offer'
            // (до setLocalDescription) — гейт волны G его отверг бы; трек цепляет
            // ближайший кадр (helper ≤40 мс / gdm rVFC) уже на стабильном pc.
          } else {
            peer.videoDenied = true;
            vt.direction = 'inactive';
          }
        }
        return pc.createAnswer();
      })
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => api.sendAnswer(pc.localDescription.sdp, op))
      .catch((err) => {
        // Ревью 16.10 P2-1: ошибка ОДНОГО offer'а (мусорный SDP оператора)
        // закрывает только ЕГО пира — глобальный FAIL (мост → все каналы всех
        // операторов мертвы до конца сеанса) оставлен фатальным ошибкам страницы.
        const ice = !iceServers.length && iceReason ? ` (ice: ${iceReason})` : '';
        console.warn(`agent-bridge: offer op=${op} отклонён (${err?.message ?? err}${ice}) — пира закрываю`);
        closePeer(op);
      });
  }

  function openPeer(offerSdp, op) {
    let peer = peers.get(op);
    if (peer) {
      // ренеготиация того же оператора (повторный offer / терминальный re-offer)
      answerChain(op, offerSdp);
      return;
    }
    // iceServers приходят до offer (ICE_CONFIG, общий); TURN нужен в NAT-сетях,
    // LAN работает и без него. Живые сети — MANUAL-QA.
    const pc = new RTCPeerConnection({ iceServers });
    peer = { pc, dcs: new Map(), videoAttached: false, videoDenied: false, paused: false, videoSender: null, adaptive: { target: TOP_BITRATE, lastChangeAt: 0 } };
    peers.set(op, peer);
    pc.onicecandidate = (e) => {
      if (e.candidate) api.sendIce(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate, op);
    };
    pc.onconnectionstatechange = () => {
      // оператор ушёл/обрыв: pc доживает до приказа main (DC_TO close) — но если
      // соединение окончательно мертво, не держим энкодер/каналы до него
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(op);
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (!ch || !LABELS.has(ch.label)) {
        try { ch?.close(); } catch { /* уже закрыт */ }
        return;
      }
      ch.binaryType = 'arraybuffer'; // бинарные чанки файлов (W-U6) без потерь
      peer.dcs.set(ch.label, ch);
      ch.onopen = () => {
        api.dcOpened(ch.label, op);
        // деградация без видео (W-C5): сказать честно, как только канал открыт
        if (ch.label === 'input' && peer.videoDenied) {
          try { ch.send(SESSION_INFO_VIDEO_FULL); } catch { /* канал закрывается */ }
        }
      };
      ch.onmessage = (m) => {
        try {
          if (typeof m.data === 'string') api.dcFrom(ch.label, m.data, op);
          else api.dcFrom(ch.label, new Uint8Array(m.data), op);
        } catch { /* канал закрывается — кусок теряется, передача честно не сойдётся */ }
      };
      ch.onclose = () => {
        // Волна G (баг-2): закрывается СТАРОЕ поколение канала, а новое уже
        // зарегистрировано — молчим: поздний DC_CLOSED в релее dropAdapter'ом
        // убил бы живой переоткрытый канал. Текущее поколение — честно наружу.
        if (peer.dcs.get(ch.label) === ch) {
          peer.dcs.delete(ch.label);
          api.dcClosed(ch.label, op);
        }
      };
      ch.bufferedAmountLowThreshold = LOW_WATER;
      ch.onbufferedamountlow = () => {
        if (peer.paused) {
          peer.paused = false;
          api.resume(op);
        }
      };
      if (ch.readyState === 'open') ch.onopen?.();
    };
    answerChain(op, offerSdp);
  }

  api.onOffer((payload) => {
    // новый формат {op, sdp}; легаси-строка — primary
    if (typeof payload === 'string') openPeer(payload, 'primary');
    else if (payload && typeof payload.sdp === 'string') openPeer(payload.sdp, opOf(payload.op));
  });
  api.onIce((payload) => {
    // новый формат {op, candidate}; легаси-кандидат — primary
    const wrapped = payload && typeof payload === 'object' && typeof payload.op === 'string' && payload.candidate != null;
    const op = wrapped ? opOf(payload.op) : 'primary';
    const c = wrapped ? payload.candidate : payload;
    const pc = peers.get(op)?.pc;
    if (pc) pc.addIceCandidate(c).catch(() => { /* устаревший кандидат */ });
  });
  api.onToDc((payload) => {
    const { label, data } = payload ?? {};
    // Приказ main закрыть (W-C2 closeOp + волна G баг-2): с label — один
    // канал оператора (host закрыл свой адаптер: term после idle/«Закрыть» —
    // раньше реальный DC страницы оставался открытым и его поздний onclose
    // убивал уже переоткрытый канал), без label — весь pc оператора.
    if (payload?.close === true) {
      const targetOp = opOf(payload.op);
      if (typeof label === 'string') {
        const peer = peers.get(targetOp);
        const ch = peer?.dcs.get(label);
        if (ch && ch.readyState !== 'closed') { try { ch.close(); } catch { /* уже закрыт */ } }
        return;
      }
      closePeer(targetOp);
      return;
    }
    // Фикс регрессии волны C (живая приёмка C+D, 16.10): локальный opOf(v) ждёт
    // СТРОКУ-op (payload.op), а не payload-объект — opOf(payload) всегда давал
    // 'primary', пир оператора не находился, и весь исходящий DC_TO ({opened},
    // вывод терминала, input-гранты) молча отбрасывался при живом claimId-теге.
    const op = opOf(payload.op);
    const peer = peers.get(op);
    const ch = peer?.dcs.get(label);
    if (!ch || ch.readyState !== 'open') return;
    try {
      ch.send(data);
      if (!peer.paused && ch.bufferedAmount > HIGH_WATER) {
        peer.paused = true;
        api.pause(op);
      }
    } catch { /* канал закрывается */ }
  });
}

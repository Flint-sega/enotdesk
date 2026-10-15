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

  function closePeer(op) {
    const peer = peers.get(op);
    if (!peer) return;
    peers.delete(op);
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
    const vt = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');
    if (!vt) return; // offer ещё не применён — повторим на следующем кадре
    try {
      await vt.sender.replaceTrack(videoTrack);
      peer.videoAttached = true;
    } catch (e) {
      console.warn(`agent-bridge: replaceTrack отказал (${e?.message ?? e}) — повторим`);
    }
  }

  async function drawVideoFrame(jpeg) {
    try {
      const seq = ++videoSeq;
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      if (seq !== videoSeq) { bitmap.close?.(); return; }
      if (!videoCanvas) {
        videoCanvas = document.createElement('canvas');
        videoCanvas.width = bitmap.width;
        videoCanvas.height = bitmap.height;
        videoCtx = videoCanvas.getContext('2d');
        videoTrack = videoCanvas.captureStream(24).getVideoTracks()[0] ?? null;
      } else if (videoCanvas.width !== bitmap.width || videoCanvas.height !== bitmap.height) {
        videoCanvas.width = bitmap.width;
        videoCanvas.height = bitmap.height;
      }
      videoCtx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      for (const op of peers.keys()) await attachVideoTrack(op);
    } catch { /* битый кадр пропускаем — следующий будет */ }
  }

  api.onVideoFrame?.((jpeg) => { void drawVideoFrame(jpeg); });

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
        const vt = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
        if (vt) {
          if (videoAllowed(videoPeerCount())) {
            vt.direction = 'sendonly';
            void attachVideoTrack(op); // кадры могли прийти раньше offer'а (гонка)
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
        // честный отказ: при пустом iceServers добавляем причину, почему TURN не был
        const ice = !iceServers.length && iceReason ? ` (ice: ${iceReason})` : '';
        api.fail(`rtc: ${err?.message ?? err}${ice}`);
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
    peer = { pc, dcs: new Map(), videoAttached: false, videoDenied: false, paused: false };
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
        peer.dcs.delete(ch.label);
        api.dcClosed(ch.label, op);
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
    // приказ main закрыть pc оператора (W-C2 closeOp): расширение payload DC_TO,
    // отдельного close-канала в BRIDGE_IPC нет (имена менять нельзя)
    if (payload?.close === true) {
      closePeer(opOf(payload));
      return;
    }
    const op = opOf(payload);
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

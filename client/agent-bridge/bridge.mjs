// Страница-мост терминала (R09): RTCPeerConnection есть только в renderer,
// поэтому pc агента живёт в этом скрытом окне. Сигналинг (offer/answer/ICE)
// и данные DataChannel релеются в main через preload (agentRtc; имена каналов —
// BRIDGE_IPC в relay.mjs). Бэкпрешшн: при переполнении dc.bufferedAmount просим
// main приостановить отправку (PAUSE), после опустошения (bufferedamountlow) —
// возобновить.

const api = window.agentRtc;
if (!api) {
  // preload не предоставил мост — честно сообщить некому, остаётся консоль окна
  console.error('agent-bridge: preload не предоставил agentRtc');
} else {
  let pc = null;
  let dc = null;
  let paused = false;
  // TURN-конфиг приходит из main до offer (ICE_CONFIG); пусто или сбой —
  // прямое LAN-соединение, причина честно видна в логе окна и в сообщении об отказе.
  let iceServers = [];
  let iceReason = null;
  const HIGH_WATER = 1 << 20; // байт в буфере DataChannel — просим main притормозить
  const LOW_WATER = 256 * 1024; // опустело ниже — разрешаем снова

  api.onIceConfig?.((cfg) => {
    iceServers = Array.isArray(cfg?.iceServers) ? cfg.iceServers : [];
    iceReason = typeof cfg?.reason === 'string' && cfg.reason ? cfg.reason : null;
    if (iceReason) console.warn(`agent-bridge: ${iceReason}`);
  });

  function openPeer(offerSdp) {
    if (pc) return;
    // iceServers приходят до offer (ICE_CONFIG); TURN нужен в NAT-сетях, LAN
    // работает и без него. Живые сети — MANUAL-QA.
    pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) api.sendIce(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (!ch || ch.label !== 'term') {
        try { ch?.close(); } catch { /* уже закрыт */ }
        return;
      }
      dc = ch;
      dc.onopen = () => api.dcOpened(dc.label);
      dc.onmessage = (m) => {
        const s = typeof m.data === 'string' ? m.data : new TextDecoder().decode(m.data);
        api.dcFrom(s);
      };
      dc.onclose = () => { dc = null; api.dcClosed(); };
      dc.bufferedAmountLowThreshold = LOW_WATER;
      dc.onbufferedamountlow = () => {
        if (paused) {
          paused = false;
          api.resume();
        }
      };
    };
    pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => api.sendAnswer(pc.localDescription.sdp))
      .catch((err) => {
        // честный отказ: при пустом iceServers добавляем причину, почему TURN не был
        const ice = !iceServers.length && iceReason ? ` (ice: ${iceReason})` : '';
        api.fail(`rtc: ${err?.message ?? err}${ice}`);
      });
  }

  api.onOffer((sdp) => openPeer(sdp));
  api.onIce((c) => {
    if (pc) pc.addIceCandidate(c).catch(() => { /* устаревший кандидат */ });
  });
  api.onToDc((data) => {
    if (!dc || dc.readyState !== 'open') return;
    try {
      dc.send(data);
      if (!paused && dc.bufferedAmount > HIGH_WATER) {
        paused = true;
        api.pause();
      }
    } catch { /* канал закрывается */ }
  });
}

// Релей main ↔ скрытый мост терминала (R09). Electron-независимый шов:
// тестируется на фейках без запуска Electron (client/test/agent-bridge-relay.test.mjs).
//
// В main-процессе Electron нет RTCPeerConnection, в renderer есть, поэтому
// терминальный pc агента живёт в скрытом BrowserWindow (client/agent-bridge/).
// Релей превращает IPC-обмен с мостом в pc-подобный объект для createAgent
// (setRemoteDescription/createAnswer/…) и в DC-адаптер для createTermHost.
// Бэкпрешшн: мост следит за dc.bufferedAmount и просит main приостановить
// отправку (PAUSE/RESUME); релей в паузе держит очередь с потолком.

export const BRIDGE_IPC = Object.freeze({
  OFFER: 'enot:rtc-offer', // main → мост: sdp offer оператора
  ICE: 'enot:rtc-ice', // в обе стороны: candidate (объект вида toJSON())
  ANSWER: 'enot:rtc-answer', // мост → main: sdp answer
  DC_OPEN: 'enot:term-dc-open', // мост → main: открыт канал (label)
  DC_FROM: 'enot:term-dc-from', // мост → main: сырое сообщение от оператора
  DC_TO: 'enot:term-dc-to', // main → мост: сырое сообщение оператору
  DC_CLOSED: 'enot:term-dc-closed', // мост → main: канал закрыт
  PAUSE: 'enot:term-dc-pause', // мост → main: приостановить отправку
  RESUME: 'enot:term-dc-resume', // мост → main: возобновить отправку
  FAIL: 'enot:bridge-fail', // мост → main: честная ошибка моста
});

const DC_QUEUE_CAP = 1 << 20; // потолок очереди паузы, байт (сверх — роняем свежий кусок)

const byteLength = (s) => new TextEncoder().encode(s).length; // среда-нейтрально: main и тесты

export function createBridgeRelay({ send, log = console, onClosed = null } = {}) {
  // send(channel, payload) — доставка main → мост (обёртка над webContents.send)
  if (typeof send !== 'function') throw new Error('createBridgeRelay: нужна send(channel, payload)');

  let closed = false;
  let readyFlag = false; // мост готов получать (did-finish-load); флаг важен и до первого whenReady
  let readyResolve = null;
  let answerWait = null;
  let pendingAnswerSdp = null; // answer пришёл раньше createAnswer — не теряем
  let bridgeFailMessage = null; // честная ошибка моста, ждущим createAnswer
  let lastAnswerSdp = null;
  let adapter = null; // DC-адаптер, видимый termHost как обычный канал
  let paused = false;
  let queue = [];
  let queuedBytes = 0;

  const markReady = () => {
    readyFlag = true;
    readyResolve?.();
  };
  let readyPromise = null;
  const whenReady = () => {
    if (readyFlag) return Promise.resolve();
    readyPromise ??= new Promise((resolve) => { readyResolve = resolve; });
    return readyPromise;
  };

  function dropAdapter() {
    if (!adapter) return;
    const a = adapter;
    adapter = null;
    queue = [];
    queuedBytes = 0;
    a.markClosed();
  }

  function flush() {
    while (!paused && queue.length) {
      const item = queue.shift();
      queuedBytes -= item.bytes;
      send(BRIDGE_IPC.DC_TO, item.data);
    }
  }

  function makeAdapter() {
    const ch = {
      label: 'term',
      readyState: 'open',
      onopen: null,
      onmessage: null,
      onclose: null,
      send(obj) {
        if (closed || ch.readyState !== 'open' || adapter !== ch) return;
        const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
        if (paused) {
          const bytes = byteLength(data);
          if (queuedBytes + bytes > DC_QUEUE_CAP) return; // переполнено: свежий кусок роняем, кольцо терминала хранит хвост
          queue.push({ data, bytes });
          queuedBytes += bytes;
          return;
        }
        send(BRIDGE_IPC.DC_TO, data);
      },
      close() {
        if (closed) return;
        send(BRIDGE_IPC.DC_CLOSED);
        ch.markClosed();
      },
      // внутреннее: мост умер или релей закрыт — честно закрыть канал
      markClosed() {
        if (ch.readyState !== 'open') return;
        ch.readyState = 'closed';
        try { ch.onclose?.(); } catch { /* обработчик не должен ронять релей */ }
      },
    };
    return ch;
  }

  const pcLike = {
    onicecandidate: null,
    ondatachannel: null,
    // offer уходит в мост только когда страница загрузилась (did-finish-load)
    setRemoteDescription: async (d) => {
      await whenReady();
      if (!closed) send(BRIDGE_IPC.OFFER, d.sdp);
    },
    createAnswer: () => (async () => {
      await whenReady();
      if (closed) throw new Error('мост закрыт');
      if (bridgeFailMessage) throw new Error(bridgeFailMessage);
      if (pendingAnswerSdp != null) {
        const sdp = pendingAnswerSdp; // ответ уже лежит — отдаём сразу
        pendingAnswerSdp = null;
        return { type: 'answer', sdp };
      }
      return new Promise((resolve, reject) => { answerWait = { resolve, reject }; });
    })(),
    setLocalDescription: async (d) => { lastAnswerSdp = d.sdp; },
    addIceCandidate: async (c) => {
      await whenReady();
      if (!closed) send(BRIDGE_IPC.ICE, c);
    },
    get localDescription() {
      return lastAnswerSdp == null ? null : { type: 'answer', sdp: lastAnswerSdp };
    },
    close: () => destroy(),
  };

  function destroy() {
    if (closed) return;
    closed = true;
    markReady(); // ждущие «готовности» выйдут и упрутся в closed
    dropAdapter();
    if (answerWait) {
      const w = answerWait;
      answerWait = null;
      w.reject(new Error('мост закрыт'));
    }
    try { onClosed?.(); } catch { /* очистка окна не должна ронять destroy */ }
  }

  // Входящие из моста (bridge → main); main привязывает это к ipcMain с проверкой
  // отправителя. Посторонние каналы не проходят allowlist.
  function handleMessage(channel, payload) {
    if (closed) return;
    switch (channel) {
      case BRIDGE_IPC.ANSWER:
        // ответ может прийти раньше, чем агент вызовет createAnswer (IPC-гонка) — кэшируем
        if (typeof payload === 'string') {
          lastAnswerSdp = payload;
          if (answerWait) {
            const w = answerWait;
            answerWait = null;
            w.resolve({ type: 'answer', sdp: payload });
          } else {
            pendingAnswerSdp = payload;
          }
        }
        return;
      case BRIDGE_IPC.ICE:
        try { pcLike.onicecandidate?.({ candidate: payload }); } catch (e) { log.warn?.(`мост ice: ${e.message}`); }
        return;
      case BRIDGE_IPC.DC_OPEN:
        if (!adapter && payload === 'term') {
          adapter = makeAdapter();
          try { pcLike.ondatachannel?.({ channel: adapter }); } catch (e) { log.warn?.(`мост dc: ${e.message}`); }
          try { adapter.onopen?.(); } catch (e) { log.warn?.(`мост dc open: ${e.message}`); }
        }
        return;
      case BRIDGE_IPC.DC_FROM:
        if (adapter && typeof payload === 'string') {
          try { adapter.onmessage?.({ data: payload }); } catch (e) { log.warn?.(`мост dc msg: ${e.message}`); }
        }
        return;
      case BRIDGE_IPC.DC_CLOSED:
        dropAdapter();
        return;
      case BRIDGE_IPC.PAUSE:
        paused = true;
        return;
      case BRIDGE_IPC.RESUME:
        paused = false;
        flush();
        return;
      case BRIDGE_IPC.FAIL:
        bridgeFailMessage = typeof payload === 'string' ? payload : 'ошибка моста';
        dropAdapter();
        if (answerWait) {
          const w = answerWait;
          answerWait = null;
          w.reject(new Error(bridgeFailMessage));
        }
        return;
      default:
        return;
    }
  }

  return {
    pcLike,
    handleMessage,
    markReady,
    destroy,
    isClosed: () => closed,
    hasAdapter: () => adapter != null,
  };
}

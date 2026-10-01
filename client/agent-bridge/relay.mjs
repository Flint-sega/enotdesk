// Релей main ↔ скрытый мост терминала (R09). Electron-независимый шов:
// тестируется на фейках без запуска Electron (client/test/agent-bridge-relay.test.mjs).
//
// В main-процессе Electron нет RTCPeerConnection, в renderer есть, поэтому
// pc агента живёт в скрытом BrowserWindow (client/agent-bridge/). Релей
// превращает IPC-обмен с мостом в pc-подобный объект для createAgent
// (setRemoteDescription/createAnswer/…) и в DC-адаптеры по метке канала —
// term (createTermHost) и chat/file (machine-services, W-U6); бинарные чанки
// файлов идут через IPC как Uint8Array (structured clone), строки — как строки.
// Бэкпрешшн: мост следит за dc.bufferedAmount и просит main приостановить
// отправку (PAUSE/RESUME); релей в паузе держит очередь с потолком — хвост ≤
// капа (свежие куски), кусок крупнее капа роняется целиком.

export const BRIDGE_IPC = Object.freeze({
  OFFER: 'enot:rtc-offer', // main → мост: sdp offer оператора
  ICE: 'enot:rtc-ice', // в обе стороны: candidate (объект вида toJSON())
  ICE_CONFIG: 'enot:rtc-ice-config', // main → мост: {iceServers, reason|null} — TURN для pc терминала
  ANSWER: 'enot:rtc-answer', // мост → main: sdp answer
  DC_OPEN: 'enot:term-dc-open', // мост → main: открыт канал (label)
  DC_FROM: 'enot:term-dc-from', // мост → main: {label, data} — сообщение от оператора (string | Uint8Array)
  DC_TO: 'enot:term-dc-to', // main → мост: {label, data} — сообщение оператору
  DC_CLOSED: 'enot:term-dc-closed', // мост → main: канал закрыт (label)
  VIDEO_FRAME: 'enot:video-frame', // main → мост: jpeg-кадр хелпера (Uint8Array) — ADR 0027
  PAUSE: 'enot:term-dc-pause', // мост → main: приостановить отправку
  RESUME: 'enot:term-dc-resume', // мост → main: возобновить отправку
  FAIL: 'enot:bridge-fail', // мост → main: честная ошибка моста
});

// Allowlist меток каналов (v0.5, W-U6): term — терминал, chat/file — сервисы
// machine-сеанса. Всё прочее мост не открывает и в main не передаёт.
export const BRIDGE_DC_LABELS = Object.freeze(['term', 'chat', 'file']);

const DC_QUEUE_CAP = 1 << 20; // потолок очереди паузы, байт; хранится хвост ≤ капа, кусок крупнее капа роняется

const dataBytes = (data) =>
  typeof data === 'string'
    ? new TextEncoder().encode(data).length
    : (data.byteLength ?? 0);

export function createBridgeRelay({ send, log = console, onClosed = null, fetchIceServers = null } = {}) {
  // send(channel, payload) — доставка main → мост (обёртка над webContents.send)
  // fetchIceServers — async-крючок main: достаёт iceServers через GET /rtc-config
  // с токеном сеанса машины (делает вызывающий в main; токены в мост не утекают —
  // уходит только конфиг TURN).
  if (typeof send !== 'function') throw new Error('createBridgeRelay: нужна send(channel, payload)');

  let closed = false;
  let readyFlag = false; // мост готов получать (did-finish-load); флаг важен и до первого whenReady
  let readyResolve = null;
  let answerWait = null;
  let pendingAnswerSdp = null; // answer пришёл раньше createAnswer — не теряем
  let bridgeFailMessage = null; // честная ошибка моста, ждущим createAnswer
  let lastAnswerSdp = null;
  let iceSent = false; // rtc-config запрашивается один раз за релей — одно открытие терминала
  let iceInfo = { iceServers: [], reason: null }; // последний честный статус TURN для моста
  const adapters = new Map(); // label → DC-адаптер (виден потребителям как обычный канал)
  let paused = false;
  let queue = []; // {label, data, bytes} — общая очередь паузы, порядок каналов сохраняется
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

  function dropAdapter(label) {
    const a = adapters.get(label);
    if (!a) return;
    adapters.delete(label);
    a.markClosed();
  }

  function dropAllAdapters() {
    for (const label of [...adapters.keys()]) dropAdapter(label);
    queue = [];
    queuedBytes = 0;
  }

  function flush() {
    while (!paused && queue.length) {
      const item = queue.shift();
      queuedBytes -= item.bytes;
      send(BRIDGE_IPC.DC_TO, { label: item.label, data: item.data });
    }
  }

  function makeAdapter(label) {
    const ch = {
      label,
      readyState: 'open',
      onopen: null,
      onmessage: null,
      onclose: null,
      send(obj) {
        if (closed || ch.readyState !== 'open' || adapters.get(label) !== ch) return;
        // строки и бинарные куски идут как есть; прочие объекты — JSON (контракт termHost)
        const data = typeof obj === 'string' || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer
          ? obj
          : JSON.stringify(obj);
        if (paused) {
          const bytes = dataBytes(data);
          if (bytes > DC_QUEUE_CAP) return; // кусок сам больше капа — роняем целиком
          while (queuedBytes + bytes > DC_QUEUE_CAP && queue.length) {
            const old = queue.shift(); // хвост важнее головы: старые куски выбрасываются
            queuedBytes -= old.bytes;
          }
          queue.push({ label, data, bytes });
          queuedBytes += bytes;
          return;
        }
        send(BRIDGE_IPC.DC_TO, { label, data });
      },
      close() {
        if (closed) return;
        send(BRIDGE_IPC.DC_CLOSED, label);
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

  // rtc-config: перед первым offer main по fetchIceServers() достаёт TURN-конфиг
  // (endpoint уже принимает host-токен машины) и релей доставляет его мосту ДО
  // offer — pc создаётся сразу с iceServers. Недоступен/пуст — мост получает
  // iceServers:[] и честную причину; терминал остаётся рабочим по LAN.
  async function pushIceConfig() {
    if (iceSent) return;
    iceSent = true;
    if (typeof fetchIceServers !== 'function') return; // main ещё не подключил rtc-config — мост живёт с []
    let info;
    try {
      const cfg = await fetchIceServers();
      const servers = Array.isArray(cfg?.iceServers) ? cfg.iceServers : [];
      const reason = typeof cfg?.reason === 'string' && cfg.reason
        ? cfg.reason
        : (servers.length ? null : 'rtc-config пуст: TURN не настроен');
      info = { iceServers: servers, reason };
    } catch (e) {
      info = { iceServers: [], reason: `rtc-config недоступен: ${e?.message ?? e}` };
      log.warn?.(`мост: ${info.reason}`);
    }
    iceInfo = info;
    if (!closed) send(BRIDGE_IPC.ICE_CONFIG, info);
  }

  const pcLike = {
    onicecandidate: null,
    ondatachannel: null,
    // offer уходит в мост только когда страница загрузилась (did-finish-load)
    setRemoteDescription: async (d) => {
      await whenReady();
      if (closed) return;
      await pushIceConfig();
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
    dropAllAdapters();
    if (answerWait) {
      const w = answerWait;
      answerWait = null;
      w.reject(new Error('мост закрыт'));
    }
    try { onClosed?.(); } catch { /* очистка окна не должна ронять destroy */ }
  }

  // Входящие из моста (bridge → main); main привязывает это к ipcMain с проверкой
  // отправителя. Метки каналов проходят только по allowlist BRIDGE_DC_LABELS.
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
        if (BRIDGE_DC_LABELS.includes(payload) && !adapters.has(payload)) {
          const adapter = makeAdapter(payload);
          adapters.set(payload, adapter);
          try { pcLike.ondatachannel?.({ channel: adapter }); } catch (e) { log.warn?.(`мост dc: ${e.message}`); }
          try { adapter.onopen?.(); } catch (e) { log.warn?.(`мост dc open: ${e.message}`); }
        }
        return;
      case BRIDGE_IPC.DC_FROM: {
        const { label, data } = payload ?? {};
        const adapter = adapters.get(label);
        if (adapter && (typeof data === 'string' || ArrayBuffer.isView(data) || data instanceof ArrayBuffer)) {
          try { adapter.onmessage?.({ data }); } catch (e) { log.warn?.(`мост dc msg: ${e.message}`); }
        }
        return;
      }
      case BRIDGE_IPC.DC_CLOSED:
        if (typeof payload === 'string') dropAdapter(payload);
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
        dropAllAdapters();
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
    hasAdapter: () => adapters.size > 0,
    hasTermAdapter: () => adapters.has('term'),
    // main → мост (кадры видео-хелпера): только пока мост жив (ADR 0027)
    sendToBridge: (channel, payload) => { if (!closed) send(channel, payload); },
    iceServersInfo: () => iceInfo, // для честного лога main: какой TURN ушёл мосту и почему, если пусто
  };
}

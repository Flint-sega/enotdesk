// Релей main ↔ скрытый мост терминала (R09). Electron-независимый шов:
// тестируется на фейках без запуска Electron (client/test/agent-bridge-relay.test.mjs).
//
// В main-процессе Electron нет RTCPeerConnection, в renderer есть, поэтому
// pc агента живёт в скрытом BrowserWindow (client/agent-bridge/). Релей
// превращает IPC-обмен с мостом в pc-подобные объекты для createAgent
// (setRemoteDescription/createAnswer/…) и в DC-адаптеры по метке канала —
// term (createTermHost) и chat/file (machine-services, W-U6); бинарные чанки
// файлов идут через IPC как Uint8Array (structured clone), строки — как строки.
// Бэкпрешшн: мост следит за dc.bufferedAmount и просит main приостановить
// отправку (PAUSE/RESUME); релей в паузе держит очередь с потолком — хвост ≤
// капа (свежие куски), кусок крупнее капа роняется целиком.
//
// Мультиоператор (волна C, W-C2): у моста N pc в ОДНОМ окне — по одному на
// оператора. Имена IPC-каналов (BRIDGE_IPC) не меняются (sandbox-preload
// не может импортировать этот модуль), адресация — полем `op` (claimId) в
// payload сообщений pc/каналов. Отсутствие op = 'primary' — обратная
// совместимость шимов/тестов. ICE_CONFIG и VIDEO_FRAME — общие без op
// (TURN-конфиг один, canvas один). PAUSE/RESUME — per-op. Закрытие pc одного
// оператора — closeOp(op): локальная чистка + DC_TO {op, close:true} мосту
// (расширение payload существующего канала: отдельного close-канала в
// BRIDGE_IPC нет и имена менять нельзя).

export const BRIDGE_IPC = Object.freeze({
  OFFER: 'enot:rtc-offer', // main → мост: {op, sdp} | sdp (legacy=primary) — offer оператора
  ICE: 'enot:rtc-ice', // в обе стороны: {op, candidate} | candidate (legacy=primary)
  ICE_CONFIG: 'enot:rtc-ice-config', // main → мост: {iceServers, reason|null} — TURN для всех pc (общий)
  ANSWER: 'enot:rtc-answer', // мост → main: {op, sdp} | sdp (legacy=primary)
  DC_OPEN: 'enot:term-dc-open', // мост → main: {op, label} | label (legacy=primary)
  DC_FROM: 'enot:term-dc-from', // мост → main: {op, label, data} — сообщение от оператора (string | Uint8Array)
  DC_TO: 'enot:term-dc-to', // main → мост: {op, label, data} | {op, close:true} — сообщение оператору / закрыть pc оператора
  DC_CLOSED: 'enot:term-dc-closed', // мост → main: {op, label} | label (legacy=primary)
  VIDEO_FRAME: 'enot:video-frame', // main → мост: jpeg-кадр хелпера (Uint8Array) — общий, ADR 0027
  PAUSE: 'enot:term-dc-pause', // мост → main: приостановить отправку (op)
  RESUME: 'enot:term-dc-resume', // мост → main: возобновить отправку (op)
  FAIL: 'enot:bridge-fail', // мост → main: честная ошибка моста (страница умерла — все pc)
});

// Allowlist меток каналов (v0.5 W-U6 + v0.6 ADR 0027): term — терминал,
// chat/file — сервисы machine-сеанса, input — ввод/privacy оператора → хелпер.
// Всё прочее мост не открывает и в main не передаёт. Зеркалится в bridge.mjs.
export const BRIDGE_DC_LABELS = Object.freeze(['term', 'chat', 'file', 'input']);

export const OP_PRIMARY = 'primary'; // отсутствие op в payload (легаси-шимы/тесты)

const DC_QUEUE_CAP = 1 << 20; // потолок очереди паузы, байт; хранится хвост ≤ капа, кусок крупнее капа роняется

const dataBytes = (data) =>
  typeof data === 'string'
    ? new TextEncoder().encode(data).length
    : (data.byteLength ?? 0);

// Разбор payload с op-адресацией: новый формат {op, …} и легаси без op.
const opOf = (payload) => (typeof payload?.op === 'string' && payload.op ? payload.op : OP_PRIMARY);

export function createBridgeRelay({ send, log = console, onClosed = null, fetchIceServers = null } = {}) {
  // send(channel, payload) — доставка main → мост (обёртка над webContents.send)
  // fetchIceServers — async-крючок main: достаёт iceServers через GET /rtc-config
  // с токеном сеанса машины (делает вызывающий в main; токены в мост не утекают —
  // уходит только конфиг TURN).
  if (typeof send !== 'function') throw new Error('createBridgeRelay: нужна send(channel, payload)');

  let closed = false;
  let readyFlag = false; // мост готов получать (did-finish-load); флаг важен и до первого whenReady
  let readyResolve = null;
  let bridgeFailMessage = null; // честная ошибка моста, ждущим createAnswer (глобально: страница одна)
  let iceSent = false; // rtc-config запрашивается один раз за релей — конфиг общий для всех pc
  let iceInfo = { iceServers: [], reason: null }; // последний честный статус TURN для моста

  // Per-op состояние моста (W-C2): op → {answerWait, pendingAnswerSdp,
  // lastAnswerSdp, adapters: Map<label, adapter>, paused, queue, queuedBytes}
  const ops = new Map();
  // Кэш pcLike per op: onicecandidate/ondatachannel назначаются один раз
  const pcLikes = new Map();

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

  function opState(op, create = false) {
    let st = ops.get(op);
    if (!st && create && !closed) {
      st = { answerWait: null, pendingAnswerSdp: null, lastAnswerSdp: null, adapters: new Map(), paused: false, queue: [], queuedBytes: 0 };
      ops.set(op, st);
    }
    return st ?? null;
  }

  function dropAdapter(op, label) {
    const st = opState(op);
    const a = st?.adapters.get(label);
    if (!a) return;
    st.adapters.delete(label);
    a.markClosed();
  }

  function closeOpState(op, reason = 'pc оператора закрыт') {
    const st = opState(op);
    if (!st) return;
    ops.delete(op);
    for (const a of [...st.adapters.values()]) a.markClosed();
    if (st.answerWait) {
      const w = st.answerWait;
      st.answerWait = null;
      w.reject(new Error(reason));
    }
  }

  function flushOp(st) {
    while (!st.paused && st.queue.length) {
      const item = st.queue.shift();
      st.queuedBytes -= item.bytes;
      send(BRIDGE_IPC.DC_TO, { op: item.op, label: item.label, data: item.data });
    }
  }

  function makeAdapter(op, label) {
    const ch = {
      label,
      readyState: 'open',
      onopen: null,
      onmessage: null,
      onclose: null,
      send(obj) {
        const st = opState(op);
        if (closed || !st || ch.readyState !== 'open' || st.adapters.get(label) !== ch) return;
        // строки и бинарные куски идут как есть; прочие объекты — JSON (контракт termHost)
        const data = typeof obj === 'string' || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer
          ? obj
          : JSON.stringify(obj);
        if (st.paused) {
          const bytes = dataBytes(data);
          if (bytes > DC_QUEUE_CAP) return; // кусок сам больше капа — роняем целиком
          while (st.queuedBytes + bytes > DC_QUEUE_CAP && st.queue.length) {
            const old = st.queue.shift(); // хвост важнее головы: старые куски выбрасываются
            st.queuedBytes -= old.bytes;
          }
          st.queue.push({ op, label, data, bytes });
          st.queuedBytes += bytes;
          return;
        }
        send(BRIDGE_IPC.DC_TO, { op, label, data });
      },
      close() {
        if (closed) return;
        send(BRIDGE_IPC.DC_CLOSED, { op, label });
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
  // offer — pc создаётся сразу с iceServers (конфиг общий на все pc операторов:
  // эфемерные креды TTL 1 ч — хватает на сеанс). Недоступен/пуст — мост получает
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

  function makePcLike(op) {
    // tombstone: closeOp/destroy этого op (или всего релея) закрывает и ТОТ
    // createAnswer, что ещё в пути — гонка «close раньше зависания answerWait»
    // иначе оставляла вечный промис (W-C2)
    const tomb = { dead: false };
    const pcLike = {
      onicecandidate: null,
      ondatachannel: null,
      op,
      // offer уходит в мост только когда страница загрузилась (did-finish-load)
      setRemoteDescription: async (d) => {
        await whenReady();
        if (closed || tomb.dead) return;
        await pushIceConfig();
        if (!closed) send(BRIDGE_IPC.OFFER, { op, sdp: d.sdp });
      },
      createAnswer: () => (async () => {
        await whenReady();
        if (closed) throw new Error('мост закрыт');
        if (tomb.dead) throw new Error('pc оператора закрыт');
        if (bridgeFailMessage) throw new Error(bridgeFailMessage);
        const st = opState(op, true); // слот pc может ещё не существовать — создаём
        if (!st) throw new Error('мост закрыт');
        if (st.pendingAnswerSdp != null) {
          const sdp = st.pendingAnswerSdp; // ответ уже лежит — отдаём сразу
          st.pendingAnswerSdp = null;
          return { type: 'answer', sdp };
        }
        return new Promise((resolve, reject) => { st.answerWait = { resolve, reject }; });
      })(),
      setLocalDescription: async (d) => {
        const st = opState(op);
        if (st) st.lastAnswerSdp = d.sdp;
      },
      addIceCandidate: async (c) => {
        await whenReady();
        if (!closed && !tomb.dead) send(BRIDGE_IPC.ICE, { op, candidate: c });
      },
      get localDescription() {
        const st = opState(op);
        return st?.lastAnswerSdp == null ? null : { type: 'answer', sdp: st.lastAnswerSdp };
      },
      close: () => closeOp(op),
      __tomb: tomb,
    };
    return pcLike;
  }

  function destroy() {
    if (closed) return;
    closed = true;
    markReady(); // ждущие «готовности» выйдут и упрутся в closed
    for (const op of [...ops.keys()]) closeOpState(op, 'мост закрыт');
    for (const pc of pcLikes.values()) pc.__tomb.dead = true;
    pcLikes.clear();
    try { onClosed?.(); } catch { /* очистка окна не должна ронять destroy */ }
  }

  // pc оператора закрывается (уход/обрыв): локальная чистка + приказ мосту.
  // Мост закрывает peers.get(op) и его каналы; прочие операторы не затрагиваются.
  function closeOp(op) {
    const key = typeof op === 'string' && op ? op : OP_PRIMARY;
    const st = opState(key);
    const pc = pcLikes.get(key);
    if (!st && !pc) return;
    closeOpState(key);
    if (pc) {
      pc.__tomb.dead = true; // ждущий createAnswer этого pc честно отклонится
      pcLikes.delete(key);
    }
    if (!closed) send(BRIDGE_IPC.DC_TO, { op: key, close: true });
  }

  // Входящие из моста (bridge → main); main привязывает это к ipcMain с проверкой
  // отправителя. Метки каналов проходят только по allowlist BRIDGE_DC_LABELS.
  // Payload с op-адресацией; легаси-форматы (строка sdp/label, кандидат без
  // конверта) трактуются как primary.
  function handleMessage(channel, payload) {
    if (closed) return;
    switch (channel) {
      case BRIDGE_IPC.ANSWER: {
        // ответ может прийти раньше, чем агент вызовет createAnswer (IPC-гонка) — кэшируем per-op
        const op = typeof payload === 'string' ? OP_PRIMARY
          : (typeof payload?.sdp === 'string' ? opOf(payload) : null);
        const sdp = typeof payload === 'string' ? payload : payload?.sdp;
        if (op == null || typeof sdp !== 'string') return;
        const st = opState(op, true);
        st.lastAnswerSdp = sdp;
        if (st.answerWait) {
          const w = st.answerWait;
          st.answerWait = null;
          w.resolve({ type: 'answer', sdp });
        } else {
          st.pendingAnswerSdp = sdp;
        }
        return;
      }
      case BRIDGE_IPC.ICE: {
        // новый формат {op, candidate}; легаси — сам кандидат (primary)
        const isWrapped = payload && typeof payload === 'object' && typeof payload.op === 'string'
          && payload.candidate != null;
        const op = isWrapped ? opOf(payload) : OP_PRIMARY;
        const candidate = isWrapped ? payload.candidate : payload;
        if (candidate == null) return;
        const pcLike = pcLikes.get(op);
        if (!pcLike) return; // pc этого оператора неизвестен — чужой кандидат молча
        try { pcLike.onicecandidate?.({ candidate }); } catch (e) { log.warn?.(`мост ice: ${e.message}`); }
        return;
      }
      case BRIDGE_IPC.DC_OPEN: {
        const op = typeof payload === 'string' ? OP_PRIMARY : opOf(payload);
        const label = typeof payload === 'string' ? payload : payload?.label;
        if (typeof label !== 'string' || !BRIDGE_DC_LABELS.includes(label)) return;
        const st = opState(op, true);
        if (st.adapters.has(label)) return; // дубликат открытия — канал уже жив
        const adapter = makeAdapter(op, label);
        st.adapters.set(label, adapter);
        const pcLike = pcLikes.get(op);
        if (pcLike) {
          try { pcLike.ondatachannel?.({ channel: adapter }); } catch (e) { log.warn?.(`мост dc: ${e.message}`); }
        }
        try { adapter.onopen?.(); } catch (e) { log.warn?.(`мост dc open: ${e.message}`); }
        return;
      }
      case BRIDGE_IPC.DC_FROM: {
        const { label, data } = payload ?? {};
        const st = opState(opOf(payload));
        const adapter = st?.adapters.get(label);
        if (adapter && (typeof data === 'string' || ArrayBuffer.isView(data) || data instanceof ArrayBuffer)) {
          try { adapter.onmessage?.({ data }); } catch (e) { log.warn?.(`мост dc msg: ${e.message}`); }
        }
        return;
      }
      case BRIDGE_IPC.DC_CLOSED: {
        const op = typeof payload === 'string' ? OP_PRIMARY : opOf(payload);
        const label = typeof payload === 'string' ? payload : payload?.label;
        if (typeof label === 'string') dropAdapter(op, label);
        return;
      }
      case BRIDGE_IPC.PAUSE: {
        const st = opState(typeof payload === 'string' ? payload : opOf(payload));
        if (st) st.paused = true;
        return;
      }
      case BRIDGE_IPC.RESUME: {
        const st = opState(typeof payload === 'string' ? payload : opOf(payload));
        if (st) { st.paused = false; flushOp(st); }
        return;
      }
      case BRIDGE_IPC.FAIL:
        bridgeFailMessage = typeof payload === 'string' ? payload : 'ошибка моста';
        for (const op of [...ops.keys()]) {
          const st = ops.get(op);
          for (const a of [...st.adapters.values()]) a.markClosed();
          if (st.answerWait) {
            const w = st.answerWait;
            st.answerWait = null;
            w.reject(new Error(bridgeFailMessage));
          }
          ops.delete(op);
        }
        return;
      default:
        return;
    }
  }

  const primaryPcLike = makePcLike(OP_PRIMARY);
  pcLikes.set(OP_PRIMARY, primaryPcLike);

  return {
    pcLike: primaryPcLike, // легаси-контракт (primary); N-pc — getPcLike(op)
    getPcLike: (op) => {
      const key = typeof op === 'string' && op ? op : OP_PRIMARY;
      let pc = pcLikes.get(key);
      if (!pc && !closed) {
        pc = makePcLike(key);
        pcLikes.set(key, pc);
      }
      return pc ?? null;
    },
    closeOp,
    ops: () => [...ops.keys()],
    handleMessage,
    markReady,
    destroy,
    isClosed: () => closed,
    hasAdapter: () => [...ops.values()].some((st) => st.adapters.size > 0),
    hasTermAdapter: () => [...ops.values()].some((st) => st.adapters.has('term')),
    // main → мост (кадры видео-хелпера): только пока мост жив (ADR 0027)
    sendToBridge: (channel, payload) => { if (!closed) send(channel, payload); },
    iceServersInfo: () => iceInfo, // для честного лога main: какой TURN ушёл мосту и почему, если пусто
  };
}

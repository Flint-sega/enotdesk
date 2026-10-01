// Хост видео-хелпера (ADR 0027, v0.6): запуск enotdesk-video в консольном
// сеансе (createSessionSpawner), подключение к named pipe, двоичный протокол
// [u32 LE magic 'ENOT'][u8 type][u32 LE len][payload] — type 0=hello(токен),
// 1=frame(jpeg), 2=status(json), 3=command(json). Хост честно деградирует:
// нет хелпера/сеанса/пайпа — статус с причиной, machine-сеанс живёт без видео.
// net/spawner/killer инъекцией — юнит-тесты без Electron и без сети.

export const PIPE_NAME = '\\\\.\\pipe\\enotdesk-video';
export const FRAME_MAGIC = 0x454e4f54; // 'ENOT' little-endian
export const MSG = Object.freeze({ HELLO: 0, FRAME: 1, STATUS: 2, COMMAND: 3 });
const HEADER = 9; // 4 magic + 1 type + 4 len
const CONNECT_TIMEOUT_MS = 4000;
const CONNECT_RETRIES = 3;
const MAX_FRAME_BYTES = 6 * 1024 * 1024; // 720p JPEG много меньше; больше — протокол сломан

export function encodeMessage(type, payload = Buffer.alloc(0)) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(HEADER);
  head.writeUInt32LE(FRAME_MAGIC, 0);
  head.writeUInt8(type, 4);
  head.writeUInt32LE(body.length, 5);
  return Buffer.concat([head, body]);
}

// Дозреватель потока в сообщения: feed(chunk) → [{type, payload}]; мусорный
// magic или гигантский len — честная ошибка протокола (сброс буфера).
export function createFrameReader() {
  let buf = Buffer.alloc(0);
  return {
    feed(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      for (;;) {
        if (buf.length < HEADER) return out;
        const magic = buf.readUInt32LE(0);
        if (magic !== FRAME_MAGIC) {
          const e = new Error('bad-magic');
          e.code = 'EPROTO';
          buf = Buffer.alloc(0);
          throw e;
        }
        const type = buf.readUInt8(4);
        const len = buf.readUInt32LE(5);
        if (len > MAX_FRAME_BYTES) {
          const e = new Error('frame-too-large');
          e.code = 'EPROTO';
          buf = Buffer.alloc(0);
          throw e;
        }
        if (buf.length < HEADER + len) return out;
        out.push({ type, payload: buf.subarray(HEADER, HEADER + len) });
        buf = buf.subarray(HEADER + len);
      }
    },
  };
}

export function createVideoHost({
  spawner, netFactory, killer = null, pipeName = PIPE_NAME,
  exePath, commandLine,
  token, log = console,
  onFrame = () => {}, onStatus = () => {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS, connectRetries = CONNECT_RETRIES,
} = {}) {
  let state = 'off'; // off|spawning|connecting|running|error
  let sock = null;
  let pid = null;
  let stopped = true;
  const setStatus = (s, extra) => {
    state = s;
    try { onStatus({ state, ...extra }); } catch { /* потребитель не роняет хост */ }
  };

  function connectPipe(attempt) {
    if (stopped) return;
    const socket = netFactory(pipeName);
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch { /* уже мёртв */ }
      retryOr('connect-timeout');
    }, connectTimeoutMs);
    const fail = (reason) => {
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* уже мёртв */ }
      retryOr(reason);
    };
    const retryOr = (reason) => {
      if (stopped) return;
      if (attempt + 1 < connectRetries) {
        setTimeout(() => connectPipe(attempt + 1), 400);
        return;
      }
      sock = null;
      setStatus('error', { reason: `pipe-${reason}` });
    };
    socket.on('connect', () => {
      if (stopped) { socket.destroy(); return; }
      clearTimeout(timer);
      sock = socket;
      // Первый кадр в пайп — hello с одноразовым токеном (хелпер ждёт его,
      // чужой клиент без токена отбрасывается).
      socket.write(encodeMessage(MSG.HELLO, token));
      setStatus('running');
    });
    const reader = createFrameReader();
    socket.on('data', (chunk) => {
      let msgs;
      try { msgs = reader.feed(chunk); } catch (e) {
        log.warn?.(`video-host: протокол хелпера сломан (${e.message})`);
        fail('protocol');
        return;
      }
      for (const m of msgs) {
        if (m.type === MSG.FRAME) onFrame(m.payload);
        else if (m.type === MSG.STATUS) {
          let st;
          try { st = JSON.parse(m.payload.toString('utf8')); } catch { st = null; }
          if (st) onStatus({ state, helper: st });
        }
      }
    });
    socket.on('error', () => fail('error'));
    socket.on('close', () => {
      clearTimeout(timer);
      // Разрыв сообщаем только для активного сокета: попытки, упавшие на
      // connect/error, никогда не становились sock и уже отчитались сами.
      if (sock === socket) {
        sock = null;
        if (!stopped) setStatus('error', { reason: 'pipe-closed' });
      }
    });
  }

  return {
    get state() { return state; },
    get pid() { return pid; },
    async start() {
      if (!stopped) return;
      stopped = false;
      setStatus('spawning');
      const r = await spawner.spawnInConsoleSession({ exePath, commandLine });
      if (!r.ok) {
        setStatus('error', { reason: `spawn-${r.reason}` });
        return;
      }
      pid = r.pid;
      connectPipe(0);
    },
    // Команда хелперу (input/wake/sleep/quality); не-running — false, не фейк.
    sendCommand(obj) {
      if (state !== 'running' || !sock) return false;
      try { sock.write(encodeMessage(MSG.COMMAND, JSON.stringify(obj))); return true; }
      catch { return false; }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // Privacy-гигиена: перед смертью хелпер уже мёртв или умирает — вернуть
      // дисплей нечем; поэтому wake шлём ДО закрытия, если канал жив.
      if (state === 'running') this.sendCommand({ cmd: 'wake' });
      try { sock?.destroy(); } catch { /* уже мёртв */ }
      sock = null;
      if (pid != null) {
        try { killer?.(pid); } catch (e) { log.warn?.(`video-host: kill ${pid} (${e?.message ?? e})`); }
      }
      pid = null;
      setStatus('off');
    },
  };
}

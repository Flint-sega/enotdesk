// Протокол передачи файлов поверх DataChannel (ADR 0014).
// Управление — JSON-строки, полезная нагрузка — бинарные чанки тем же каналом.
// Оператор→клиент только после явного «Принять»; лимиты жёсткие, имя — basename.

export const FILE_CHUNK = 64 * 1024;
export const FILE_MAX = 200 * 1024 * 1024; // потолок одного файла
export const FILE_ID_RE = /^[a-z0-9-]{1,40}$/;

export function makeFileId() {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Только имя файла: пути, '..' и управляющие символы вырезаются/отбрасываются.
export function sanitizeFileName(raw) {
  if (typeof raw !== 'string') return '';
  const base = String(raw).split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return cleaned === '.' || cleaned === '..' ? '' : cleaned.slice(0, 120);
}

function parseJson(raw) {
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// Управляющие сообщения file-канала: meta / accept / reject / done.
export function parseFileControl(raw) {
  const msg = parseJson(raw);
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'file-meta') {
    const id = typeof msg.id === 'string' && FILE_ID_RE.test(msg.id) ? msg.id : null;
    const name = sanitizeFileName(msg.name);
    if (!id || !name) return null;
    if (!Number.isInteger(msg.size) || msg.size < 1 || msg.size > FILE_MAX) return null;
    return { kind: 'meta', id, name, size: msg.size };
  }
  if (msg.type === 'file-accept' || msg.type === 'file-reject' || msg.type === 'file-done') {
    if (typeof msg.id !== 'string' || !FILE_ID_RE.test(msg.id)) return null;
    return { kind: msg.type.slice(5), id: msg.id };
  }
  return null;
}

export const fileMeta = (id, name, size) => JSON.stringify({ type: 'file-meta', id, name, size });
export const fileAccept = (id) => JSON.stringify({ type: 'file-accept', id });
export const fileReject = (id) => JSON.stringify({ type: 'file-reject', id });
export const fileDone = (id) => JSON.stringify({ type: 'file-done', id });

// Приёмник: копит чанки по порядку, выдаёт Blob строго заявленного размера.
// Лишние байты — ошибка протокола, приёмник сбрасывается.
export function createFileReceiver(meta) {
  let received = 0;
  const parts = [];
  return {
    meta,
    push(chunk) {
      const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
      if (!bytes || received + bytes.byteLength > meta.size) return false;
      parts.push(bytes);
      received += bytes.byteLength;
      return true;
    },
    get received() { return received; },
    complete() {
      if (received !== meta.size) return null;
      return new Blob(parts, { type: 'application/octet-stream' });
    },
  };
}

// Отправитель: читает файл чанками, держит буфер DC в границах (backpressure).
// onDone вызывается после подтверждения file-done получателем.
export function createFileSender({ file, dc, id, chunkSize = FILE_CHUNK, highWater = 1024 * 1024 }) {
  let offset = 0;
  let reading = false;
  let doneSent = false;

  function pump() {
    if (reading || offset >= file.size) return;
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > highWater) return; // ждём bufferedamountlow
    reading = true;
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size));
    slice.arrayBuffer().then((buf) => {
      offset += buf.byteLength;
      try { dc.send(buf); } catch { /* канал закрыт — отправка прекращена */ }
      reading = false;
      if (offset >= file.size) {
        if (!doneSent) { doneSent = true; try { dc.send(fileDone(id)); } catch { /* закрыт */ } }
        return;
      }
      pump();
    }).catch(() => { reading = false; });
  }

  dc.bufferedAmountLowThreshold = Math.floor(highWater / 2);
  dc.addEventListener('bufferedamountlow', () => pump());
  return {
    get offset() { return offset; },
    start() { pump(); },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFileControl, createFileReceiver, createFileSender,
  fileMeta, fileAccept, fileReject, fileDone, sanitizeFileName, FILE_MAX,
} from '../lib/file-transfer.mjs';

test('имя файла: только basename, без путей и управляющих символов', () => {
  assert.equal(sanitizeFileName('отчёт.pdf'), 'отчёт.pdf');
  assert.equal(sanitizeFileName('C:\\evil\\..\\x.exe'), 'x.exe');
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..'), '');
  assert.equal(sanitizeFileName(''), '');
  assert.equal(sanitizeFileName(42), '');
  assert.equal(sanitizeFileName('a\nb<c>'), 'abc');
});

test('file-meta: id/имя/размер валидируются; путь сводится к basename; гигант отклонён', () => {
  assert.deepEqual(parseFileControl(fileMeta('f-abc', 'док.pdf', 1024)), { kind: 'meta', id: 'f-abc', name: 'док.pdf', size: 1024 });
  assert.deepEqual(parseFileControl(fileMeta('f-abc', '../../etc/passwd', 1)), { kind: 'meta', id: 'f-abc', name: 'passwd', size: 1 }, 'путь срезается до basename');
  assert.equal(parseFileControl(fileMeta('ПЛОХОЙ-ID', 'a', 1)), null);
  assert.equal(parseFileControl(fileMeta('f-abc', '..', 1)), null);
  assert.equal(parseFileControl(fileMeta('f-abc', 'ok.bin', FILE_MAX + 1)), null);
  assert.equal(parseFileControl(fileMeta('f-abc', 'ok.bin', 0)), null);
  assert.equal(parseFileControl(fileMeta('f-abc', 'ok.bin', 1.5)), null);
});

test('управляющие сообщения: accept/reject/done с тем же id; мусор отбрасывается', () => {
  assert.deepEqual(parseFileControl(fileAccept('f-x1')), { kind: 'accept', id: 'f-x1' });
  assert.deepEqual(parseFileControl(fileReject('f-x1')), { kind: 'reject', id: 'f-x1' });
  assert.deepEqual(parseFileControl(fileDone('f-x1')), { kind: 'done', id: 'f-x1' });
  assert.equal(parseFileControl('not json'), null);
  assert.equal(parseFileControl(JSON.stringify({ type: 'exec', id: 'f-x1' })), null);
  assert.equal(parseFileControl(fileAccept('злой id')), null);
});

test('приёмник: копит чанки по порядку и выдаёт Blob точного размера; перелив — отказ', async () => {
  const meta = { kind: 'meta', id: 'f-1', name: 'байты.bin', size: 11 };
  const rx = createFileReceiver(meta);
  assert.equal(rx.push(new Uint8Array([1, 2, 3, 4])), true);
  assert.equal(rx.push(new Uint8Array(new ArrayBuffer(7))), true, 'ArrayBuffer тоже принимается');
  assert.equal(rx.push(new Uint8Array(1)), false, 'байт сверх заявленного размера отклонён');
  const blob = rx.complete();
  assert.ok(blob);
  assert.equal(blob.size, 11);
  const expected = Buffer.concat([Buffer.from([1, 2, 3, 4]), Buffer.alloc(7)]);
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), expected.toString());
});

test('приёмник: incomplete до всех байтов — complete() возвращает null', () => {
  const rx = createFileReceiver({ kind: 'meta', id: 'f-2', name: 'x', size: 5 });
  rx.push(new Uint8Array(2));
  assert.equal(rx.complete(), null);
});

test('отправитель: файл уходит чанками и завершается file-done (мок DC)', async () => {
  const sent = [];
  const listeners = {};
  const dc = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    send: (data) => sent.push(data),
    addEventListener: (_ev, cb) => { (listeners[_ev] ??= []).push(cb); },
  };
  const payload = Buffer.alloc(150_000, 7); // 3 чанка по 64К
  const file = new Blob([payload]);
  Object.defineProperty(file, 'size', { value: payload.length });

  const sender = createFileSender({ file, dc, id: 'f-9', chunkSize: 64 * 1024, highWater: 1024 * 1024 });
  sender.start();
  await new Promise((r) => setTimeout(r, 30));

  const binary = sent.filter((d) => d instanceof ArrayBuffer);
  const controls = sent.filter((d) => typeof d === 'string').map((s) => parseFileControl(s));
  assert.equal(binary.length, 3);
  assert.equal(binary.reduce((n, b) => n + b.byteLength, 0), 150_000);
  assert.deepEqual(controls, [{ kind: 'done', id: 'f-9' }]);

  // приёмник собирает ровно то, что отправлено
  const rx = createFileReceiver({ kind: 'meta', id: 'f-9', name: 'x', size: 150_000 });
  for (const b of binary) assert.equal(rx.push(new Uint8Array(b)), true);
  assert.equal((await rx.complete()).size, 150_000);
  void listeners;
});

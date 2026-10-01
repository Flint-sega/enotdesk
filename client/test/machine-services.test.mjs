// machine-services (W-U6, v0.5): чат-тост и приём файлов в machine-сеансе.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createMachineServices, machineFilesDir, CHAT_TOAST_MAX,
} from '../lib/machine-services.mjs';
import { chatMessage, CHAT_MAX } from '../lib/chat.mjs';
import { fileMeta, fileDone } from '../lib/file-transfer.mjs';

function fakeDc() {
  return {
    sent: [],
    binaryType: undefined,
    onmessage: null,
    send(d) { this.sent.push(d); },
  };
}

function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync(p) { files.set(`dir:${p}`, true); },
    writeFileSync(p, buf) { files.set(p, Buffer.from(buf)); },
    existsSync(p) { return files.has(p); },
  };
}

function services(over = {}) {
  const calls = { notify: [], warn: [] };
  const fsImpl = over.fsImpl ?? fakeFs();
  const svc = createMachineServices({
    platform: 'win32',
    env: { PUBLIC: 'C:\\Shared' },
    fsImpl,
    notify: (t) => calls.notify.push(t),
    log: { warn: (...a) => calls.warn.push(a.join(' ')) },
    ...over,
  });
  return { svc, calls, fsImpl };
}

test('файлы: dir win32 — %PUBLIC%\\EnotDesk Files, без PUBLIC — дефолт; posix — home', () => {
  // сравнение через тот же path.join — тест платформо-нейтрален
  assert.equal(machineFilesDir({ platform: 'win32', env: { PUBLIC: 'C:\\Shared' } }), path.join('C:\\Shared', 'EnotDesk Files'));
  assert.equal(machineFilesDir({ platform: 'win32', env: {} }), path.join('C:\\Users\\Public', 'EnotDesk Files'));
  assert.equal(machineFilesDir({ platform: 'linux', env: {}, home: '/home/u' }), path.join('/home/u', 'EnotDesk Files'));
});

test('чат: текст оператора → тост; мусор и перегруз — тишина; длинный — обрезан до лимита', () => {
  const { svc, calls } = services();
  const ch = fakeDc();
  assert.equal(svc.handleChannel('chat', ch), true);
  ch.onmessage({ data: chatMessage('привет') });
  assert.deepEqual(calls.notify, ['💬 привет']);
  ch.onmessage({ data: 'не json' });
  ch.onmessage({ data: JSON.stringify({ type: 'chat', text: '' }) });
  assert.equal(calls.notify.length, 1, 'мусор не тостится');
  const long = 'ж'.repeat(Math.min(CHAT_MAX, 1200));
  ch.onmessage({ data: chatMessage(long) });
  const last = calls.notify.at(-1);
  assert.ok(last.startsWith('💬'));
  // «💬 » — 3 юнита (эмодзи 2 + пробел) поверх среза текста
  assert.ok(last.length <= CHAT_TOAST_MAX + 3, `тост обрезан (${last.length})`);
});

test('неизвестный канал — false (агент его закроет)', () => {
  const { svc } = services();
  assert.equal(svc.handleChannel('clip', fakeDc()), false);
  assert.equal(svc.handleChannel('term', null), false);
});

test('файлы: meta→accept, чанки, done→запись+тост; коллизия имён — суффикс', async () => {
  const fsImpl = fakeFs();
  const { svc, calls } = services({ fsImpl });
  const ch = fakeDc();
  assert.equal(svc.handleChannel('file', ch), true);
  assert.equal(ch.binaryType, 'arraybuffer');

  ch.onmessage({ data: fileMeta('abc123', 'отчёт.txt', 5) });
  assert.deepEqual(JSON.parse(ch.sent[0]), { type: 'file-accept', id: 'abc123' });
  ch.onmessage({ data: new Uint8Array([1, 2, 3, 4, 5]).buffer });
  ch.onmessage({ data: fileDone('abc123') });
  await new Promise((r) => setImmediate(r));

  // ожидание строится тем же path.join — тест платформо-нейтрален
  const target = path.join(svc.filesDir, 'отчёт.txt');
  assert.deepEqual([...fsImpl.files.get(target)], [1, 2, 3, 4, 5]);
  assert.ok(calls.notify.at(-1).includes('отчёт.txt'), 'тост с именем файла');

  // второй файл с тем же именем → -1
  ch.onmessage({ data: fileMeta('abc124', 'отчёт.txt', 1) });
  ch.onmessage({ data: new Uint8Array([9]).buffer });
  ch.onmessage({ data: fileDone('abc124') });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...fsImpl.files.get(path.join(svc.filesDir, 'отчёт-1.txt'))], [9]);
});

test('файлы: второй meta в процессе — reject; занятый rx не путается; недобор — честный тост', async () => {
  const { svc, calls } = services();
  const ch = fakeDc();
  svc.handleChannel('file', ch);

  ch.onmessage({ data: fileMeta('aa1', 'f.bin', 4) });
  ch.onmessage({ data: fileMeta('aa2', 'g.bin', 4) });
  assert.deepEqual(JSON.parse(ch.sent.at(-1)), { type: 'file-reject', id: 'aa2' }, 'занято — reject');
  assert.ok(calls.warn.at(-1).includes('уже принимается'));

  // rx остался у aa1: done без байтов — приём сброшен с честным тостом
  ch.onmessage({ data: fileDone('aa1') });
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.notify.at(-1).includes('повреждён'), 'недобор — не фейковый успех');

  // новый приём после ошибки возможен (rx сброшен); oversize-meta отсекает
  // сам parseFileControl (до сервиса не доходит) — accept на валидный meta
  ch.onmessage({ data: fileMeta('cc2', 'ok.bin', 1) });
  assert.deepEqual(JSON.parse(ch.sent.at(-1)), { type: 'file-accept', id: 'cc2' });
});

test('файлы: мусорное имя/путь в name — basename+санитизация, запись не вне папки', async () => {
  const fsImpl = fakeFs();
  const { svc } = services({ fsImpl });
  const ch = fakeDc();
  svc.handleChannel('file', ch);
  ch.onmessage({ data: fileMeta('dd1', '..\\..\\windows\\evil<>.txt', 2) });
  ch.onmessage({ data: new Uint8Array([7, 8]).buffer });
  ch.onmessage({ data: fileDone('dd1') });
  await new Promise((r) => setImmediate(r));
  const keys = [...fsImpl.files.keys()].filter((k) => !k.startsWith('dir:'));
  assert.equal(keys.length, 1);
  assert.equal(keys[0], path.join(svc.filesDir, 'evil.txt'), 'запись только в общую папку, путь нейтрализован');
});

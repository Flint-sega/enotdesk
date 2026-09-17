// Шов IPC-релея скрытого моста терминала (R09, dos-условие 4): фейковое
// «окно» — sends[] вместо webContents.send, сообщения моста подаются через
// handleMessage. Цепочка: offer пришёл → answer ушёл; данные ходят в обе
// стороны; бэкпрешшн PAUSE/RESUME; отказ моста и destroy — честные.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeRelay, BRIDGE_IPC } from '../agent-bridge/relay.mjs';

function makeRelay(overrides = {}) {
  const sends = [];
  const relay = createBridgeRelay({
    send: (channel, payload) => sends.push([channel, payload]),
    ...overrides,
  });
  return { relay, sends };
}
const dcTos = (sends) => sends.filter(([ch]) => ch === BRIDGE_IPC.DC_TO);

test('offer пришёл → answer ушёл: сигналинг через релей в обе стороны', async () => {
  const { relay, sends } = makeRelay();
  relay.markReady(); // did-finish-load
  await relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0 op-offer' });
  assert.deepEqual(sends[0], [BRIDGE_IPC.OFFER, 'v=0 op-offer']);

  const answerPromise = relay.pcLike.createAnswer();
  relay.handleMessage(BRIDGE_IPC.ANSWER, 'v=0 bridge-answer'); // мост ответил
  const answer = await answerPromise;
  assert.deepEqual(answer, { type: 'answer', sdp: 'v=0 bridge-answer' });
  await relay.pcLike.setLocalDescription(answer);
  assert.deepEqual(relay.pcLike.localDescription, { type: 'answer', sdp: 'v=0 bridge-answer' });

  // ICE в обе стороны
  let gotIce = null;
  relay.pcLike.onicecandidate = (e) => { gotIce = e.candidate; };
  relay.handleMessage(BRIDGE_IPC.ICE, { candidate: 'cand-1' });
  assert.deepEqual(gotIce, { candidate: 'cand-1' });
  await relay.pcLike.addIceCandidate({ candidate: 'cand-op' });
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.ICE, { candidate: 'cand-op' }]);
});

test('до готовности моста offer не уходит; после destroy — createAnswer честно падает', async () => {
  const { relay, sends } = makeRelay();
  const pending = relay.pcLike.createAnswer(); // ждёт готовности и answer
  const offer = relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0' });
  await new Promise((r) => setTimeout(r, 0)); // микротаски прошли — готовности ещё нет
  assert.ok(!sends.some(([ch]) => ch === BRIDGE_IPC.OFFER), 'offer ушёл до загрузки моста');
  relay.markReady();
  await offer;
  assert.ok(sends.some(([ch, p]) => ch === BRIDGE_IPC.OFFER && p === 'v=0'), 'после готовности offer ушёл');
  relay.destroy();
  await assert.rejects(pending, /мост закрыт/);
});

test('данные ходят в обе стороны: канал term открыт, out → мост, from → termHost', () => {
  const { relay, sends } = makeRelay();
  let channel = null;
  let opened = false;
  let incoming = null;
  relay.pcLike.ondatachannel = (e) => {
    channel = e.channel;
    channel.onopen = () => { opened = true; };
    channel.onmessage = (m) => { incoming = m.data; };
  };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  assert.ok(channel, 'адаптер канала не создан');
  assert.equal(opened, true); // onopen сработал сразу после проводки
  relay.handleMessage(BRIDGE_IPC.DC_FROM, '{"type":"in","data":"dir\\r"}');
  assert.equal(incoming, '{"type":"in","data":"dir\\r"}');
  channel.send({ type: 'out', data: 'C:\\> ' });
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.DC_TO, '{"type":"out","data":"C:\\\\> "}']);
  assert.equal(relay.hasAdapter(), true);
  relay.handleMessage(BRIDGE_IPC.DC_CLOSED);
  assert.equal(relay.hasAdapter(), false);
  assert.equal(channel.readyState, 'closed');
  // посторонний канал не проходит
  let rogue = null;
  relay.pcLike.ondatachannel = (e) => { rogue = e.channel; };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'chat');
  assert.equal(rogue, null);
});

test('бэкпрешшн: PAUSE ставит отправку в очередь с потолком, RESUME вымывает по порядку', () => {
  const { relay, sends } = makeRelay();
  let channel = null;
  relay.pcLike.ondatachannel = (e) => { channel = e.channel; };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  assert.ok(channel, 'канал для бэкпрешшна не создан');

  relay.handleMessage(BRIDGE_IPC.PAUSE);
  channel.send({ type: 'out', data: 'a'.repeat(1024) });
  channel.send({ type: 'out', data: 'b'.repeat(1024) });
  assert.equal(dcTos(sends).length, 0, 'в паузе данные ушли сразу');
  relay.handleMessage(BRIDGE_IPC.RESUME);
  const flushed = dcTos(sends).map(([, p]) => JSON.parse(p).data[0]);
  assert.deepEqual(flushed, ['a', 'b']); // порядок очереди сохранён
});

test('кап очереди: после переполнения остаётся точный хвост ≤ 1 МБ, свежий кусок свыше капа роняется', () => {
  const { relay, sends } = makeRelay();
  let channel = null;
  relay.pcLike.ondatachannel = (e) => { channel = e.channel; };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  assert.ok(channel, 'канал для капа не создан');

  relay.handleMessage(BRIDGE_IPC.PAUSE);
  const chunk = (i) => `k${String(i).padStart(3, '0')}${'x'.repeat(99_996)}`; // ровно 100000 символов
  const chunkBytes = 100_024; // {"type":"out","data":""} — 24 байта обёртки + 100000 данных
  for (let i = 1; i <= 12; i += 1) channel.send({ type: 'out', data: chunk(i) }); // 12 × 100024 > кап
  channel.send({ type: 'out', data: `BIG${'y'.repeat(1_500_000)}` }); // сам больше капа — роняется целиком
  relay.handleMessage(BRIDGE_IPC.RESUME);

  const flushed = dcTos(sends).map(([, p]) => JSON.parse(p).data);
  assert.equal(flushed.length, 10, `в очереди ${flushed.length} кусков — кап не держит хвост ≤ 1 МБ`);
  assert.ok(flushed[0].startsWith('k003'), `хвост должен начинаться с k003, а начался с ${flushed[0].slice(0, 4)}`);
  assert.ok(flushed.at(-1).startsWith('k012'), 'хвост должен заканчиваться на k012');
  assert.ok(flushed.every((d) => !d.startsWith('BIG')), 'кусок крупнее капа попал в очередь');
  // точная сумма хвоста (10 кусков × 100024 байта, посчитано вручную), а не «что-то ≤ 1.5 МБ»:
  // без капа в очереди 13 кусков (1.3 МБ+), при «роняем свежий» — голова k001 — оба красные
  assert.equal(flushed.length * chunkBytes, 1_000_240, 'сумма хвоста не 10 кусков — кап или куски сломались');
  assert.ok(flushed.length * chunkBytes <= 1 << 20, 'хвост превысил кап 1 МБ');
});

test('rtc-config: iceServers уходят мосту до offer, один раз за релей', async () => {
  const ice = [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }];
  const { relay, sends } = makeRelay({ fetchIceServers: async () => ({ iceServers: ice }) });
  relay.markReady();
  await relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0 op-offer' });
  const idxCfg = sends.findIndex(([ch]) => ch === BRIDGE_IPC.ICE_CONFIG);
  const idxOffer = sends.findIndex(([ch]) => ch === BRIDGE_IPC.OFFER);
  assert.ok(idxCfg !== -1, 'iceServers не дошли до моста');
  assert.ok(idxCfg < idxOffer, 'конфиг ушёл позже offer — мост создаст pc без TURN');
  assert.deepEqual(sends[idxCfg][1], { iceServers: ice, reason: null });
  assert.deepEqual(relay.iceServersInfo(), { iceServers: ice, reason: null });
  // повторный offer не перезапрашивает rtc-config — одно открытие терминала
  await relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0 again' });
  assert.equal(sends.filter(([ch]) => ch === BRIDGE_IPC.ICE_CONFIG).length, 1);
});

test('rtc-config недоступен/пуст — мост получает iceServers:[] с честной причиной, offer не теряется', async () => {
  const fail = makeRelay({ fetchIceServers: async () => { throw new Error('сеть недоступна'); } });
  fail.relay.markReady();
  await fail.relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0' });
  const cfg = fail.sends.find(([ch]) => ch === BRIDGE_IPC.ICE_CONFIG)?.[1];
  assert.deepEqual(cfg, { iceServers: [], reason: 'rtc-config недоступен: сеть недоступна' });
  assert.ok(fail.sends.some(([ch, p]) => ch === BRIDGE_IPC.OFFER && p === 'v=0'), 'offer потерян после сбоя rtc-config');
  assert.deepEqual(fail.relay.iceServersInfo().iceServers, []);

  const empty = makeRelay({ fetchIceServers: async () => ({ iceServers: [] }) });
  empty.relay.markReady();
  await empty.relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0' });
  assert.deepEqual(empty.sends.find(([ch]) => ch === BRIDGE_IPC.ICE_CONFIG)?.[1], {
    iceServers: [],
    reason: 'rtc-config пуст: TURN не настроен',
  });
});

test('без fetchIceServers релей ведёт себя как прежде: конфиг не уходит, offer доходит', async () => {
  const { relay, sends } = makeRelay();
  relay.markReady();
  await relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0' });
  assert.equal(sends.filter(([ch]) => ch === BRIDGE_IPC.ICE_CONFIG).length, 0);
  assert.ok(sends.some(([ch, p]) => ch === BRIDGE_IPC.OFFER && p === 'v=0'));
});

test('гонка: ANSWER пришёл раньше createAnswer — ранний ответ применяется, кэш одноразовый', async () => {
  const { relay } = makeRelay();
  relay.markReady();
  relay.handleMessage(BRIDGE_IPC.ANSWER, 'v=0 early-answer'); // мост ответил раньше запроса
  let boom;
  try {
    const early = await Promise.race([
      relay.pcLike.createAnswer(),
      new Promise((_, rej) => { boom = setTimeout(() => rej(new Error('createAnswer завис: ранний answer потерян')), 500); }),
    ]);
    assert.deepEqual(early, { type: 'answer', sdp: 'v=0 early-answer' });
  } finally {
    clearTimeout(boom); // страховка от зависания не тормозит зелёный прогон
  }
  // кэш одноразовый: следующий createAnswer ждёт свежий answer моста
  let late = null;
  const second = relay.pcLike.createAnswer().then((a) => { late = a; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(late, null, 'ранний answer применился дважды');
  relay.handleMessage(BRIDGE_IPC.ANSWER, 'v=0 second-answer');
  await second;
  assert.deepEqual(late, { type: 'answer', sdp: 'v=0 second-answer' });
});

test('отказ моста (FAIL) честно отклоняет ждущий answer и закрывает канал', async () => {
  const { relay } = makeRelay();
  relay.markReady();
  await relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0' });
  const pending = relay.pcLike.createAnswer();
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  relay.handleMessage(BRIDGE_IPC.FAIL, 'rtc: no bindings');
  await assert.rejects(pending, /no bindings/);
  assert.equal(relay.hasAdapter(), false);
});

test('destroy закрывает канал; после него сообщения моста игнорируются', () => {
  let closedCalls = 0;
  const { relay } = makeRelay({
    onClosed() { closedCalls += 1; }, // main гасит скрытое окно здесь
  });
  let channel = null;
  relay.pcLike.ondatachannel = (e) => {
    channel = e.channel;
    channel.onclose = () => { closedCalls += 10; };
  };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  assert.ok(channel);
  relay.destroy();
  assert.equal(relay.isClosed(), true);
  assert.equal(closedCalls, 11); // onclose канала + хук onClosed
  relay.handleMessage(BRIDGE_IPC.DC_FROM, 'junk'); // после destroy — тишина
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  assert.equal(relay.hasAdapter(), false);
});

test('посторонние IPC-каналы не проходят allowlist', () => {
  const { relay, sends } = makeRelay();
  relay.markReady();
  relay.handleMessage('enot:evil', { evil: true });
  assert.ok(!sends.some(([ch]) => ch !== BRIDGE_IPC.OFFER));
});

// Паритет каналов моста: единый источник имён — BRIDGE_IPC в relay.mjs. preload.cjs
// живёт в sandbox-preload (main.mjs: sandbox true) и не может подключить общий
// модуль, поэтому имена там — литералы; контракт сверяет их по исходнику файла.
test('паритет каналов: литералы preload.cjs повторяют Object.values(BRIDGE_IPC) один в один', () => {
  const declared = [...new Set(Object.values(BRIDGE_IPC))].sort();
  assert.ok(declared.length >= 10, 'BRIDGE_IPC подозрительно пуст');

  const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-bridge', 'preload.cjs');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const used = [...new Set(preload.match(/'enot:[a-z-]+'/g)?.map((s) => s.slice(1, -1)) ?? [])].sort();
  assert.deepEqual(
    used,
    declared,
    'preload.cjs разошёлся с BRIDGE_IPC: переименовали канал в одном месте без сверки — сообщение молча пропадёт',
  );
});

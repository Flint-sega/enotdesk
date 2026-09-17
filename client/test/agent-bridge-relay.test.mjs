// Шов IPC-релея скрытого моста терминала (R09, dos-условие 4): фейковое
// «окно» — sends[] вместо webContents.send, сообщения моста подаются через
// handleMessage. Цепочка: offer пришёл → answer ушёл; данные ходят в обе
// стороны; бэкпрешшн PAUSE/RESUME; отказ моста и destroy — честные.

import test from 'node:test';
import assert from 'node:assert/strict';
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

  // потолок очереди: сверх 1 МБ свежие куски роняются (хвост хранит кольцо терминала)
  relay.handleMessage(BRIDGE_IPC.PAUSE);
  const big = 'x'.repeat(700 * 1024);
  channel.send({ type: 'out', data: big });
  channel.send({ type: 'out', data: big }); // 1.4 МБ > капа — этот и следующие роняются
  relay.handleMessage(BRIDGE_IPC.RESUME);
  const total = dcTos(sends).map(([, p]) => JSON.parse(p).data.length).reduce((s, n) => s + n, 0);
  assert.ok(total <= 1.5 * 1024 * 1024, `очередь превысила кап: ${total}`);
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

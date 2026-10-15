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
  // W-C2: исходящие payload несут op (primary — легаси-путь pcLike)
  assert.deepEqual(sends[0], [BRIDGE_IPC.OFFER, { op: 'primary', sdp: 'v=0 op-offer' }]);

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
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.ICE, { op: 'primary', candidate: { candidate: 'cand-op' } }]);
});

test('до готовности моста offer не уходит; после destroy — createAnswer честно падает', async () => {
  const { relay, sends } = makeRelay();
  const pending = relay.pcLike.createAnswer(); // ждёт готовности и answer
  const offer = relay.pcLike.setRemoteDescription({ type: 'offer', sdp: 'v=0' });
  await new Promise((r) => setTimeout(r, 0)); // микротаски прошли — готовности ещё нет
  assert.ok(!sends.some(([ch]) => ch === BRIDGE_IPC.OFFER), 'offer ушёл до загрузки моста');
  relay.markReady();
  await offer;
  assert.ok(sends.some(([ch, p]) => ch === BRIDGE_IPC.OFFER && p?.sdp === 'v=0'), 'после готовности offer ушёл');
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
  relay.handleMessage(BRIDGE_IPC.DC_FROM, { label: 'term', data: '{"type":"in","data":"dir\\r"}' });
  assert.equal(incoming, '{"type":"in","data":"dir\\r"}');
  channel.send({ type: 'out', data: 'C:\\> ' });
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.DC_TO, { op: 'primary', label: 'term', data: '{"type":"out","data":"C:\\\\> "}'}]);
  assert.equal(relay.hasAdapter(), true);
  assert.equal(relay.hasTermAdapter(), true);
  relay.handleMessage(BRIDGE_IPC.DC_CLOSED, 'term');
  assert.equal(relay.hasAdapter(), false);
  assert.equal(channel.readyState, 'closed');
  // посторонняя метка не проходит allowlist (сторонние каналы мост закрывает сам)
  let rogue = null;
  relay.pcLike.ondatachannel = (e) => { rogue = e.channel; };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'garbage');
  assert.equal(rogue, null);
});

test('мультиканальность W-U6: chat/file поднимаются параллельно term, бинарные куски без потерь', () => {
  const { relay, sends } = makeRelay();
  const channels = new Map();
  const labels = [];
  relay.pcLike.ondatachannel = (e) => {
    channels.set(e.channel.label, e.channel);
    labels.push(e.channel.label);
    e.channel.onmessage = (m) => { e.channel.lastSeen = m.data; };
  };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'chat');
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'file');
  assert.deepEqual(labels, ['term', 'chat', 'file'], 'все три канала дошли до потребителя');
  assert.equal(relay.hasTermAdapter(), true);

  // строки — чат
  relay.handleMessage(BRIDGE_IPC.DC_FROM, { label: 'chat', data: '{"type":"chat","text":"привет"}' });
  assert.equal(channels.get('chat').lastSeen, '{"type":"chat","text":"привет"}');
  // бинарные — чанки файла: typed array проходит как есть, без TextDecoder
  const chunk = new Uint8Array([0, 255, 1, 254, 128]);
  relay.handleMessage(BRIDGE_IPC.DC_FROM, { label: 'file', data: chunk });
  assert.ok(channels.get('file').lastSeen instanceof Uint8Array);
  assert.deepEqual([...channels.get('file').lastSeen], [0, 255, 1, 254, 128]);

  // исходящий бинарный кусок уходит с op и меткой канала (W-C2)
  channels.get('file').send(new Uint8Array([9, 8, 7]));
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.DC_TO, { op: 'primary', label: 'file', data: new Uint8Array([9, 8, 7]) }]);

  // закрытие одного канала не роняет остальные
  relay.handleMessage(BRIDGE_IPC.DC_CLOSED, 'chat');
  assert.equal(channels.get('chat').readyState, 'closed');
  assert.equal(channels.get('term').readyState, 'open');
  assert.equal(channels.get('file').readyState, 'open');
  assert.equal(relay.hasAdapter(), true, 'term и file ещё живы');
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
  const flushed = dcTos(sends).map(([, p]) => JSON.parse(p.data).data[0]);
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

  const flushed = dcTos(sends).map(([, p]) => JSON.parse(p.data).data);
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
  assert.ok(fail.sends.some(([ch, p]) => ch === BRIDGE_IPC.OFFER && p?.sdp === 'v=0'), 'offer потерян после сбоя rtc-config');
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
  assert.ok(sends.some(([ch, p]) => ch === BRIDGE_IPC.OFFER && p?.sdp === 'v=0'));
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

// ---- W-C2 (волна C): N pc в одном мосту — payload-адресация полем op ----

test('W-C2: два op — два независимых answerWait; OFFER(op1)+OFFER(op2) → ANSWER(op1)+ANSWER(op2)', async () => {
  const { relay, sends } = makeRelay();
  relay.markReady();
  const pc1 = relay.getPcLike('op-1');
  const pc2 = relay.getPcLike('op-2');
  await pc1.setRemoteDescription({ type: 'offer', sdp: 'v=0 offer-1' });
  await pc2.setRemoteDescription({ type: 'offer', sdp: 'v=0 offer-2' });
  assert.deepEqual(sends.find(([ch, p]) => ch === BRIDGE_IPC.OFFER && p?.op === 'op-1')?.[1],
    { op: 'op-1', sdp: 'v=0 offer-1' });
  assert.deepEqual(sends.find(([ch, p]) => ch === BRIDGE_IPC.OFFER && p?.op === 'op-2')?.[1],
    { op: 'op-2', sdp: 'v=0 offer-2' });

  // оба ждут свой answer независимо
  const a1 = pc1.createAnswer();
  const a2 = pc2.createAnswer();
  // ответы приходят в ОБРАТНОМ порядке — каждый резолвится своим
  relay.handleMessage(BRIDGE_IPC.ANSWER, { op: 'op-2', sdp: 'v=0 answer-2' });
  relay.handleMessage(BRIDGE_IPC.ANSWER, { op: 'op-1', sdp: 'v=0 answer-1' });
  assert.deepEqual(await a2, { type: 'answer', sdp: 'v=0 answer-2' });
  assert.deepEqual(await a1, { type: 'answer', sdp: 'v=0 answer-1' });
  await pc1.setLocalDescription({ type: 'answer', sdp: 'v=0 answer-1' });
  await pc2.setLocalDescription({ type: 'answer', sdp: 'v=0 answer-2' });
  assert.deepEqual(pc1.localDescription, { type: 'answer', sdp: 'v=0 answer-1' });
  assert.deepEqual(pc2.localDescription, { type: 'answer', sdp: 'v=0 answer-2' });
});

test('W-C2: ICE(op2) не попадает в op1; входящий ICE адресуется по op', async () => {
  const { relay, sends } = makeRelay();
  relay.markReady();
  const pc1 = relay.getPcLike('op-1');
  const pc2 = relay.getPcLike('op-2');
  let ice1 = null;
  let ice2 = null;
  pc1.onicecandidate = (e) => { ice1 = e.candidate; };
  pc2.onicecandidate = (e) => { ice2 = e.candidate; };
  relay.handleMessage(BRIDGE_IPC.ICE, { op: 'op-2', candidate: { candidate: 'c2' } });
  assert.equal(ice1, null, 'кандидат op2 доехал до pc1');
  assert.deepEqual(ice2, { candidate: 'c2' });
  // легаси-кандидат без конверта — primary
  let icePrimary = null;
  relay.pcLike.onicecandidate = (e) => { icePrimary = e.candidate; };
  relay.handleMessage(BRIDGE_IPC.ICE, { candidate: 'cp' });
  assert.deepEqual(icePrimary, { candidate: 'cp' });
  // исходящие ICE несут op
  await pc1.addIceCandidate({ candidate: 'c1-out' });
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.ICE, { op: 'op-1', candidate: { candidate: 'c1-out' } }]);
});

test('W-C2: DC_OPEN/DC_FROM/DC_CLOSED keyed op — pcLike оператора получает только его каналы', () => {
  const { relay } = makeRelay();
  const seen = new Map();
  const pc1 = relay.getPcLike('op-1');
  const pc2 = relay.getPcLike('op-2');
  pc1.ondatachannel = (e) => { seen.set('op1:' + e.channel.label, e.channel); };
  pc2.ondatachannel = (e) => { seen.set('op2:' + e.channel.label, e.channel); };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-1', label: 'term' });
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-2', label: 'term' });
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-2', label: 'chat' });
  assert.deepEqual([...seen.keys()].sort(), ['op1:term', 'op2:chat', 'op2:term']);
  let got = null;
  seen.get('op1:term').onmessage = (m) => { got = m.data; };
  relay.handleMessage(BRIDGE_IPC.DC_FROM, { op: 'op-2', label: 'term', data: 'x' });
  assert.equal(got, null, 'сообщение op2 доехало в канал op1');
  relay.handleMessage(BRIDGE_IPC.DC_FROM, { op: 'op-1', label: 'term', data: 'y' });
  assert.equal(got, 'y');
  // закрытие канала op2 не трогает op1
  relay.handleMessage(BRIDGE_IPC.DC_CLOSED, { op: 'op-2', label: 'term' });
  assert.equal(seen.get('op2:term').readyState, 'closed');
  assert.equal(seen.get('op1:term').readyState, 'open');
  assert.equal(relay.hasTermAdapter(), true, 'term op1 жив');
});

test('W-C2: PAUSE(op1) не останавливает очередь op2', () => {
  const { relay, sends } = makeRelay();
  let ch1 = null;
  let ch2 = null;
  relay.getPcLike('op-1').ondatachannel = (e) => { ch1 = e.channel; };
  relay.getPcLike('op-2').ondatachannel = (e) => { ch2 = e.channel; };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-1', label: 'term' });
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-2', label: 'term' });
  relay.handleMessage(BRIDGE_IPC.PAUSE, 'op-1');
  ch1.send({ type: 'out', data: 'a' });
  ch2.send({ type: 'out', data: 'b' });
  const out = dcTos(sends).filter(([, p]) => !p.close).map(([, p]) => [p.op, p.data]);
  assert.deepEqual(out, [['op-2', '{"type":"out","data":"b"}']], 'op1 в паузе, op2 отправляет сразу');
  relay.handleMessage(BRIDGE_IPC.RESUME, 'op-1');
  assert.deepEqual(dcTos(sends).at(-1), [BRIDGE_IPC.DC_TO, { op: 'op-1', label: 'term', data: '{"type":"out","data":"a"}' }],
    'RESUME(op1) вымывает только очередь op1');
});

test('W-C2: closeOp(op1) изолирует op1 (адаптеры/ждущий answer/приказ мосту) и не трогает op2', async () => {
  const { relay, sends } = makeRelay();
  relay.markReady();
  const pc1 = relay.getPcLike('op-1');
  const pc2 = relay.getPcLike('op-2');
  let ch1 = null;
  let ch1Closed = false;
  let ch2 = null;
  pc1.ondatachannel = (e) => { ch1 = e.channel; ch1.onclose = () => { ch1Closed = true; }; };
  pc2.ondatachannel = (e) => { ch2 = e.channel; };
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-1', label: 'term' });
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, { op: 'op-2', label: 'term' });
  await pc1.setRemoteDescription({ type: 'offer', sdp: 'v=0 o1' });
  const pending1 = pc1.createAnswer(); // ждёт answer моста

  relay.closeOp('op-1');
  await assert.rejects(pending1, /pc оператора закрыт/);
  assert.equal(ch1Closed, true, 'адаптер op1 закрыт');
  assert.equal(ch2.readyState, 'open', 'канал op2 жив');
  assert.deepEqual(sends.at(-1), [BRIDGE_IPC.DC_TO, { op: 'op-1', close: true }],
    'closeOp приказывает мосту закрыть pc оператора (расширение payload DC_TO)');
  assert.deepEqual(relay.ops().sort(), ['op-2']);

  // op2 продолжает работать после ухода op1
  let got = null;
  ch2.onmessage = (m) => { got = m.data; };
  relay.handleMessage(BRIDGE_IPC.DC_FROM, { op: 'op-2', label: 'term', data: 'still-here' });
  assert.equal(got, 'still-here');
});

test('W-C2: hasAdapter/hasTermAdapter учитывают все op; легаси-формат payload трактуется как primary', () => {
  const { relay } = makeRelay();
  let primaryCh = null;
  relay.pcLike.ondatachannel = (e) => { primaryCh = e.channel; };
  // легаси: DC_OPEN строкой, ANSWER строкой, PAUSE без payload
  relay.handleMessage(BRIDGE_IPC.DC_OPEN, 'term');
  assert.ok(primaryCh, 'легаси DC_OPEN открыл канал primary');
  assert.equal(relay.hasTermAdapter(), true);
  relay.handleMessage(BRIDGE_IPC.DC_CLOSED, 'term');
  assert.equal(relay.hasAdapter(), false);
});

// bridge.mjs — DOM-страница (юнит-тест невозможен): структурный контракт по
// исходнику защищает регресс N-pc-механики моста (живая приёмка — MANUAL-QA).
test('W-C2/W-C5: страница моста держит N pc (peers Map), per-op видео-кап и close-приказ', () => {
  const bridgePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-bridge', 'bridge.mjs');
  const src = fs.readFileSync(bridgePath, 'utf8');
  assert.match(src, /const peers = new Map\(\)/, 'мост держит Map<op, peer> вместо одного pc');
  assert.match(src, /api\.sendAnswer\(pc\.localDescription\.sdp, op\)/, 'answer уходит с op');
  assert.match(src, /payload\?\.close === true/, 'мост понимает приказ closeOp (DC_TO {op, close:true})');
  assert.match(src, /MULTIOP_VIDEO_CAP|videoAllowed\(/, 'мост соблюдает cap видеослотов (W-C5)');
  assert.match(src, /direction = 'inactive'/, 'сверх cap видеотрансивер inactive (W-C5)');
  assert.match(src, /video-slots-full/, 'честный session-info о занятых слотах (W-C5)');
});

// Паритет каналов моста: единый источник имён — BRIDGE_IPC в relay.mjs. preload.cjs
// живёт в sandbox-preload (main.mjs: sandbox true) и не может подключить общий
// модуль, поэтому имена там — литералы; контракт сверяет их по исходнику файла.
// Допуск (ADR 0031): enot:video-mode (main→мост, вкл. Linux-захвата) и
// enot:bridge-gdm (мост→main, статус захвата) — однонаправленные статусы
// gdm-пути, вне pc/канальной механики BRIDGE_IPC.
test('паритет каналов: литералы preload.cjs повторяют Object.values(BRIDGE_IPC) один в один', () => {
  const declared = [...new Set(Object.values(BRIDGE_IPC))].sort();
  assert.ok(declared.length >= 10, 'BRIDGE_IPC подозрительно пуст');

  const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-bridge', 'preload.cjs');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const extras = new Set(['enot:video-mode', 'enot:bridge-gdm']);
  const used = [...new Set(preload.match(/'enot:[a-z-]+'/g)?.map((s) => s.slice(1, -1)) ?? [])]
    .filter((c) => !extras.has(c))
    .sort();
  assert.deepEqual(
    used,
    declared,
    'preload.cjs разошёлся с BRIDGE_IPC: переименовали канал в одном месте без сверки — сообщение молча пропадёт',
  );
});

// ADR 0031 (волна D): Linux-захват без хелпера — структурный контракт по
// исходникам (DOM-страница юнит-тестом не покрывается; живая приёмка VM103).
test('волна D: gdm-захват в мосту — приоритет хелпера, честные статусы, вкл. только linux', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const bridge = fs.readFileSync(path.join(dir, '..', 'agent-bridge', 'bridge.mjs'), 'utf8');
  const main = fs.readFileSync(path.join(dir, '..', 'main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(dir, '..', 'agent-bridge', 'preload.cjs'), 'utf8');
  // мост: захват тем же canvas-конвейером, приоритет кадров хелпера
  assert.match(bridge, /getDisplayMedia\(\{ video: true, audio: false \}\)/, 'gdm-захват запрашивается');
  assert.match(bridge, /requestVideoFrameCallback/, 'кадры качаются через rVFC в общий canvas');
  assert.match(bridge, /helperLive/, 'живой флаг приоритета хелпера');
  assert.match(bridge, /stopGdm\('helper'\)/, 'кадры хелпера останавливают gdm');
  assert.match(bridge, /gdmStatus\?\.\('unavailable'/, 'отказ захвата честно репортится');
  // main: хендлер авто-экрана только в агент-режиме на linux + env-выключатель
  assert.match(main, /process\.platform === 'linux'[\s\S]{0,400}setDisplayMediaRequestHandler/, 'хендлер ставится на linux');
  assert.match(main, /getPrimaryDisplay\(\)/, 'авто-выбор первичного экрана');
  assert.match(main, /EDESK_AGENT_VIDEO !== 'off'/, "env-выключатель EDESK_AGENT_VIDEO=off");
  assert.match(main, /'enot:bridge-gdm'/, 'статус gdm слушается и пишется в svc-diag');
  // preload: каналы объявлены
  assert.match(preload, /onVideoMode/, 'main→мост video-mode');
  assert.match(preload, /gdmStatus/, 'мост→main gdmStatus');
});

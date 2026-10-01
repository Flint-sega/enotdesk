import test from 'node:test';
import assert from 'node:assert/strict';
import { macToBytes, magicPacket, broadcastsFor, createWakeSender } from '../lib/wol.mjs';

// Wake-on-LAN (R10): чистый модуль без сети — dgram инъекцией фейком.
// Ожидания из таска: payload = 6×0xFF + 16×MAC, сокет и 3 отправки на каждый
// broadcast, мусорный MAC — честный throw.

function fakeDgram({ failAddr = null } = {}) {
  const sockets = [];
  return {
    sockets,
    createSocket(type) {
      const sock = {
        type,
        bound: false,
        closed: false,
        broadcastFlags: [],
        sends: [],
        bind(cb) { this.bound = true; queueMicrotask(cb); },
        setBroadcast(v) { this.broadcastFlags.push(v); },
        send(buf, port, addr, cb) {
          this.sends.push({ bytes: Uint8Array.from(buf), port, addr });
          queueMicrotask(() => cb(addr === failAddr ? new Error('send failed') : null));
        },
        close() { this.closed = true; },
      };
      sockets.push(sock);
      return sock;
    },
  };
}

test('macToBytes/magicPacket: байтовая структура — 6×0xFF + 16 повторов MAC', () => {
  const bytes = macToBytes('AA:BB:CC:DD:EE:FF');
  assert.deepEqual([...bytes], [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  // нижний регистр тоже валиден — формат один
  assert.deepEqual([...macToBytes('aa:bb:cc:dd:ee:ff')], [...bytes]);

  const payload = magicPacket('AA:BB:CC:DD:EE:FF');
  assert.equal(payload.length, 102, '6 синхробайт + 16×6 байт MAC');
  for (let i = 0; i < 6; i++) assert.equal(payload[i], 0xff, `байт ${i} — 0xFF`);
  for (let i = 0; i < 16; i++) {
    assert.deepEqual([...payload.slice(6 + i * 6, 6 + (i + 1) * 6)], [...bytes], `повтор ${i + 1} — точный MAC`);
  }
});

test('macToBytes: мусорный MAC — честный throw', () => {
  for (const junk of ['AA-BB-CC-DD-EE-FF', 'AA:BB:CC:DD:EE', 'AA:BB:CC:DD:EE:F', 'AA:BB:CC:DD:EE:GG', 'мусор', '', 42, null, undefined]) {
    assert.throws(() => macToBytes(junk), `должен бросить на ${JSON.stringify(junk)}`);
    assert.throws(() => magicPacket(junk));
  }
});

test('broadcastsFor: общий 255 первым, directed broadcast по подсетям, мусор пропускается', () => {
  assert.deepEqual(broadcastsFor(['192.168.1.10', '10.0.0.5']), ['255.255.255.255', '192.168.1.255', '10.0.0.255']);
  // дубликат подсети схлопывается
  assert.deepEqual(broadcastsFor(['192.168.1.10', '192.168.1.20']), ['255.255.255.255', '192.168.1.255']);
  // не-IPv4 и мусор — молча пропущены
  assert.deepEqual(broadcastsFor(['::1', '300.1.2.3', 'мусор', 42, null]), ['255.255.255.255']);
  assert.deepEqual(broadcastsFor(undefined), ['255.255.255.255']);
});

test('sendMagicPacket: сокет и 3 отправки на каждый broadcast, порт 9', async () => {
  const dgram = fakeDgram();
  const wol = createWakeSender({ dgramFactory: dgram });
  const result = await wol.sendMagicPacket('AA:BB:CC:DD:EE:FF', {
    broadcasts: ['255.255.255.255', '192.168.1.255'],
    intervalMs: 1,
  });
  assert.deepEqual(result, { broadcasts: 2, packets: 6, failed: [] });
  assert.equal(dgram.sockets.length, 2, 'по сокету на адрес');
  for (const sock of dgram.sockets) {
    assert.equal(sock.type, 'udp4');
    assert.equal(sock.bound, true, 'сокет привязан перед отправкой');
    assert.deepEqual(sock.broadcastFlags, [true], 'SO_BROADCAST включён');
    assert.equal(sock.sends.length, 3, 'по 3 повтора на адрес');
    for (const s of sock.sends) {
      assert.equal(s.port, 9);
      assert.equal(s.bytes.length, 102, 'полный magic packet в каждый send');
      assert.equal(s.bytes[0], 0xff);
    }
    assert.equal(sock.closed, true, 'сокет закрывается после рассылки');
  }
});

test('sendMagicPacket: без broadcasts — один общий 255.255.255.255', async () => {
  const dgram = fakeDgram();
  const wol = createWakeSender({ dgramFactory: dgram });
  const result = await wol.sendMagicPacket('AA:BB:CC:DD:EE:FF', { intervalMs: 1 });
  assert.equal(result.broadcasts, 1);
  assert.equal(dgram.sockets.length, 1);
  assert.equal(dgram.sockets[0].sends[0].addr, '255.255.255.255');
});

test('sendMagicPacket: сбой адреса собирается в failed, остальные адреса живут', async () => {
  const dgram = fakeDgram({ failAddr: '192.168.1.255' });
  const wol = createWakeSender({ dgramFactory: dgram });
  const result = await wol.sendMagicPacket('AA:BB:CC:DD:EE:FF', {
    broadcasts: ['255.255.255.255', '192.168.1.255'],
    intervalMs: 1,
  });
  assert.deepEqual(result.failed, ['192.168.1.255'], 'упавший адрес — в failed');
  assert.equal(result.packets, 3, 'живой адрес отправил все 3 повтора');
  const good = dgram.sockets.find((s) => s.sends[0]?.addr === '255.255.255.255');
  assert.equal(good.sends.length, 3);
});

test('sendMagicPacket: мусорный MAC — честный throw без создания сокетов', async () => {
  const dgram = fakeDgram();
  const wol = createWakeSender({ dgramFactory: dgram });
  await assert.rejects(() => wol.sendMagicPacket('мусор'));
  assert.equal(dgram.sockets.length, 0, 'до валидации MAC ни один сокет не создаётся');
});

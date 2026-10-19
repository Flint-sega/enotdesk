import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStats, formatQuality } from '../lib/rtc-stats.mjs';

const REPORT = {
  'pair-1': { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.045 },
  'pair-2': { type: 'candidate-pair', state: 'failed', currentRoundTripTime: 9 },
  'in-1': { type: 'inbound-rtp', kind: 'video', packetsLost: 3, packetsReceived: 297 },
  'in-2': { type: 'inbound-rtp', kind: 'audio', packetsLost: 100, packetsReceived: 1 }, // аудио не считаем
};

test('качество: rtt из успешной пары, потери только по видео, процент округлён', () => {
  assert.deepEqual(summarizeStats(REPORT), { rttMs: 45, lossPct: 1 });
});

test('качество: Map-подобный report (настоящий RTCStatsReport) тоже понимается', () => {
  const map = new Map(Object.entries(REPORT));
  assert.deepEqual(summarizeStats(map), { rttMs: 45, lossPct: 1 });
});

// Реальная форма отчёта отправителя (Chrome): remote-inbound-rtp несёт
// накопительный packetsLost и fractionLost за последний интервал RTCP, но НЕ
// packetsReceived. Прежний тест подкладывал packetsReceived и прятал дефект:
// после первой потери lossPct навсегда становился 100% (замер 19.10, VM103).
test('host-сторона: потери своего видео — fractionLost последнего интервала из remote-inbound-rtp', () => {
  assert.deepEqual(summarizeStats({
    pair: { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.045 },
    rin: { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 838, fractionLost: 0.1 },
  }), { rttMs: 45, lossPct: 10 });
});

test('host-сторона (регресс 19.10): потери в прошлом при чистом текущем интервале — 0%, а не 100%', () => {
  assert.deepEqual(summarizeStats({
    pair: { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.002 },
    rin: { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 838, fractionLost: 0 },
  }), { rttMs: 2, lossPct: 0 });
});

test('host-сторона: remote-inbound-rtp без fractionLost — потерь не выдумываем', () => {
  assert.deepEqual(summarizeStats({
    pair: { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.01 },
    rin: { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 5 },
  }), { rttMs: 10, lossPct: 0 });
});

test('качество: пустой/кривой отчёт → null, без потерь → 0%', () => {
  assert.equal(summarizeStats({}), null);
  assert.equal(summarizeStats(undefined), null);
  assert.deepEqual(summarizeStats({
    p: { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.1 },
    v: { type: 'inbound-rtp', kind: 'video', packetsLost: 0, packetsReceived: 50 },
  }), { rttMs: 100, lossPct: 0 });
});

test('формат статуса: база + метрики через «·», без данных — голая база', () => {
  assert.equal(formatQuality('Подключено', { rttMs: 45, lossPct: 1 }), 'Подключено · 45 мс · 1% потерь');
  assert.equal(formatQuality('Подключено', null), 'Подключено');
});

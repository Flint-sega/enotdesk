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

test('host-сторона: потери своего исходящего видео — из remote-inbound-rtp (отчёт приёмника)', () => {
  assert.deepEqual(summarizeStats({
    pair: { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.045 },
    rin: { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 10, packetsReceived: 90 },
  }), { rttMs: 45, lossPct: 10 });
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

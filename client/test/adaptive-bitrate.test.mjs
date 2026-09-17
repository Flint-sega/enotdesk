import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTarget } from '../lib/adaptive-bitrate.mjs';

// Пороги и ступени — из спецификации: 2500/1200/600 кбит/с; вниз при потерях ≥5%
// или rtt > 400 мс; вверх при потерях <2% И rtt < 150 мс, не раньше 15 с
// после последнего изменения.

test('понижение по потерям: ≥5% — на ступень вниз, по одной за раз', () => {
  assert.deepEqual(nextTarget({ lossPct: 6, rttMs: 80 }, 2_500_000, 0, 1_000), { target: 1_200_000, changed: true });
  assert.deepEqual(nextTarget({ lossPct: 6, rttMs: 80 }, 1_200_000, 0, 2_000), { target: 600_000, changed: true });
});

test('понижение по rtt: >400 мс понижает даже при нулевых потерях', () => {
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: 450 }, 2_500_000, 0, 1_000), { target: 1_200_000, changed: true });
});

test('границы порогов: ровно 5% потерь понижает, ровно 400 мс — ещё нет', () => {
  assert.deepEqual(nextTarget({ lossPct: 5, rttMs: 100 }, 2_500_000, 0, 1_000), { target: 1_200_000, changed: true });
  assert.deepEqual(nextTarget({ lossPct: 4, rttMs: 400 }, 2_500_000, 0, 1_000), { target: 2_500_000, changed: false });
});

test('нижняя ступень: ниже некуда — держим 600к без изменений', () => {
  assert.deepEqual(nextTarget({ lossPct: 40, rttMs: 900 }, 600_000, 0, 1_000), { target: 600_000, changed: false });
});

test('восстановление: хорошая сеть через 15 с после понижения — на ступень вверх', () => {
  const t0 = 100_000;
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: 50 }, 600_000, t0, t0 + 15_000), { target: 1_200_000, changed: true });
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: 50 }, 1_200_000, t0 + 15_000, t0 + 30_000), { target: 2_500_000, changed: true });
});

test('гистерезис: попытка подъёма раньше 15 с после понижения не меняет', () => {
  const t0 = 100_000;
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: 50 }, 600_000, t0, t0 + 14_999), { target: 600_000, changed: false });
  // ровно 15 с — уже можно
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: 50 }, 600_000, t0, t0 + 15_000), { target: 1_200_000, changed: true });
});

test('верхняя ступень: выше некуда — держим 2.5М без изменений', () => {
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: 50 }, 2_500_000, 0, 60_000), { target: 2_500_000, changed: false });
});

test('восстановление требует оба сигнала: потери <2% И rtt <150', () => {
  const t0 = 100_000;
  const late = t0 + 20_000;
  assert.deepEqual(nextTarget({ lossPct: 1, rttMs: 200 }, 600_000, t0, late), { target: 600_000, changed: false });
  assert.deepEqual(nextTarget({ lossPct: 3, rttMs: 50 }, 600_000, t0, late), { target: 600_000, changed: false });
});

test('понижение гистерезиса не ждёт: сразу после подъёма потери снова понижают', () => {
  const t0 = 100_000;
  assert.deepEqual(nextTarget({ lossPct: 10, rttMs: 100 }, 1_200_000, t0, t0 + 1_000), { target: 600_000, changed: true });
});

test('мусорные stats: null, кривые объекты, NaN — держим текущий без изменений', () => {
  const garbage = [
    null, undefined, {},
    { lossPct: NaN, rttMs: NaN },
    { lossPct: '6', rttMs: '80' },
    { rttMs: Infinity },
    { lossPct: null, rttMs: null },
  ];
  for (const stats of garbage) {
    assert.deepEqual(nextTarget(stats, 1_200_000, 0, 1_000), { target: 1_200_000, changed: false });
  }
});

test('частичные данные: потери без rtt — вниз работают, вверх требуют rtt', () => {
  assert.deepEqual(nextTarget({ lossPct: 8 }, 1_200_000, 0, 1_000), { target: 600_000, changed: true });
  assert.deepEqual(nextTarget({ lossPct: 0, rttMs: null }, 600_000, 0, 60_000), { target: 600_000, changed: false });
  assert.deepEqual(nextTarget({ lossPct: 0 }, 600_000, 0, 60_000), { target: 600_000, changed: false });
});

test('нет данных о последнем изменении — выжидать нечего, подъём разрешён', () => {
  assert.deepEqual(nextTarget({ lossPct: 1, rttMs: 100 }, 600_000, undefined, 5_000), { target: 1_200_000, changed: true });
});

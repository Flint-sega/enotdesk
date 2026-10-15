import test from 'node:test';
import assert from 'node:assert/strict';
import { MULTIOP_VIDEO_CAP, videoAllowed } from '../lib/multiop-limits.mjs';

// W-C5 (волна C): cap видеослотов хоста. Хост строит персональный pc каждому
// оператору — без потолка память/CPU росли бы без ограничений; сверх cap pc
// строится без видео, оператор получает честный session-info.

test('MULTIOP_VIDEO_CAP — 3 (зафиксированное решение волны C)', () => {
  assert.equal(MULTIOP_VIDEO_CAP, 3);
});

test('videoAllowed: слоты 0..cap-1 свободны, cap и выше — заняты', () => {
  assert.equal(videoAllowed(0), true, 'первый оператор всегда получает видео');
  assert.equal(videoAllowed(1), true);
  assert.equal(videoAllowed(2), true);
  assert.equal(videoAllowed(3), false, 'четвёртый видео-энкодер — за капом');
  assert.equal(videoAllowed(4), false);
  assert.equal(videoAllowed(MULTIOP_VIDEO_CAP), false);
});

test('videoAllowed: настраиваемый cap и честный отказ на мусорном входе', () => {
  assert.equal(videoAllowed(0, 1), true);
  assert.equal(videoAllowed(1, 1), false, 'cap=1 — только один видео-оператор');
  assert.equal(videoAllowed(0, 0), false, 'cap=0 — видео выключено вовсе');
  // мусор не даёт видеослотов (fail-closed), NaN не проходит как число
  assert.equal(videoAllowed(-1), false);
  assert.equal(videoAllowed(Number.NaN), false);
  assert.equal(videoAllowed('2'), true, 'числоподобная строка приведётся (безопасный путь)');
  assert.equal(videoAllowed(2, Number.NaN), false);
  assert.equal(videoAllowed(undefined), false);
});

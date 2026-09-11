import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeInput, inertAdapter, waylandAdapterProbe } from '../lib/native-input.mjs';

// Шов из interfaces.md: «Desktop input validation and native adapters separate module
// test with inert adapter only». Реальный OS-ввод здесь не тестируется и не подделывается.

test('инертный адаптер честно сообщает о недоступности нативного ввода', () => {
  const ni = createNativeInput({ adapter: inertAdapter() });
  const r = ni.dispatch({ type: 'move', x: 0.5, y: 0.5 }, { width: 1000, height: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'native-unavailable');
  assert.equal(ni.status().available, false);
});

test('диспетчер: нормализованные координаты переводятся в пиксели границ экрана', () => {
  // Ожидание считается вручную: x=0.25*1280=320, y=0.5*800=400 — не из кода под тестом.
  const calls = [];
  const adapter = {
    available: true,
    platform: 'test',
    move(pxX, pxY) { calls.push(['move', pxX, pxY]); },
    button() {},
    key() {},
    scroll() {},
  };
  const ni = createNativeInput({ adapter });
  const r = ni.dispatch({ type: 'move', x: 0.25, y: 0.5 }, { width: 1280, height: 800 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls[0], ['move', 320, 400]);
});

test('зажатые клавиши и кнопки отпускаются при end() — даже без парных down', () => {
  const calls = [];
  const adapter = {
    available: true, platform: 'test',
    move() {},
    button(btn, down) { calls.push(['button', btn, down]); },
    key(k, down) { calls.push(['key', k, down]); },
    scroll() {},
  };
  const ni = createNativeInput({ adapter });
  ni.dispatch({ type: 'button', button: 'left', down: true }, { width: 1, height: 1 });
  ni.dispatch({ type: 'key', key: 'shift', down: true }, { width: 1, height: 1 });
  calls.length = 0;
  ni.end(); // сеанс завершён — всё зажатое должно уйти как down:false
  assert.deepEqual(calls, [['button', 'left', false], ['key', 'shift', false]]);
  calls.length = 0;
  ni.end(); // повторный end ничего не шлёт
  assert.deepEqual(calls, []);
});

test('невалидные события отбрасываются до адаптера (доверенная граница)', () => {
  let reached = 0;
  const adapter = { available: true, platform: 'test', move() {}, button() {}, key() {}, scroll() {} };
  adapter.move = () => { reached += 1; };
  const ni = createNativeInput({ adapter });
  assert.equal(ni.dispatch({ type: 'move', x: 2, y: 0 }, { width: 1, height: 1 }).ok, false);
  assert.equal(ni.dispatch({ type: 'exec', cmd: 'x' }, { width: 1, height: 1 }).ok, false);
  assert.equal(reached, 0);
});

test('частота ввода ограничена: события сверх лимита отбрасываются', () => {
  const adapter = { available: true, platform: 'test', move() {}, button() {}, key() {}, scroll() {} };
  const ni = createNativeInput({ adapter, maxPerWindow: 5, windowMs: 1000 });
  let accepted = 0;
  for (let i = 0; i < 50; i += 1) {
    const r = ni.dispatch({ type: 'move', x: i / 100, y: 0 }, { width: 1, height: 1 });
    if (r.ok) accepted += 1;
  }
  assert.equal(accepted, 5);
});

test('Wayland диагностируется как без управления вводом, честно', () => {
  const probe = waylandAdapterProbe({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'wayland-unsupported-control');
});

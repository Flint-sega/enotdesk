import test from 'node:test';
import assert from 'node:assert/strict';

// Шов браузерного оператора (история 15): DOM-события → события desktop-протокола.
// Ожидаемые значения — из документированного allowlist (protocol.mjs: типы move/
// button/key/scroll, кнопки left/middle/right, колесо 40px = строка), не из кода.

import { wireBrowserInput } from '../../web/input-source.mjs';
import { INPUT_KEYS } from '../../client/lib/protocol.mjs';

// Фейковый элемент-видео: принимает обработчики, отдаёт честный rect.
// document-шима: клавиатура слушается на document (ревью GLM-5.3 #2) —
// над/вне видео управляется флагом через pointerenter/pointerleave.
function fakeVideo({ withDocument = true } = {}) {
  const listeners = new Map();
  if (withDocument) {
    globalThis.document = {
      listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      removeEventListener(type) { this.listeners.delete(type); },
      dispatch(ev) { this.listeners.get(ev.type)?.(ev); },
    };
  }
  return {
    listeners,
    rect: { left: 0, top: 0, width: 100, height: 100 },
    getBoundingClientRect() { return this.rect; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    dispatch(ev) { listeners.get(ev.type)?.(ev); },
  };
}

const ev = (type, props = {}) => ({
  type,
  clientX: 0, clientY: 0, button: 0, deltaX: 0, deltaY: 0, code: '', key: '',
  preventDefault() { this.prevented = true; },
  ...props,
});

test('pointermove нормализуется в координаты 0..1 протокола', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('pointermove', { clientX: 25, clientY: 50 }));
  assert.deepEqual(sent, [{ type: 'move', x: 0.25, y: 0.5 }]);
});

test('координаты вне элемента зажимаются в границы 0..1', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('pointermove', { clientX: -30, clientY: 170 }));
  assert.deepEqual(sent, [{ type: 'move', x: 0, y: 1 }]);
});

test('pointerdown/up кнопок мыши: левая/средняя/правая, клик шлёт move перед button с координатами', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('pointerdown', { button: 0, clientX: 10, clientY: 20 }));
  assert.deepEqual(sent, [
    { type: 'move', x: 0.1, y: 0.2 },
    // №18: кнопка несёт координаты клика — пакет хоста идёт в точку цели
    { type: 'button', button: 'left', down: true, x: 0.1, y: 0.2 },
  ]);
  sent.length = 0;
  video.dispatch(ev('pointerup', { button: 2, clientX: 10, clientY: 20 }));
  assert.deepEqual(sent, [
    { type: 'move', x: 0.1, y: 0.2 },
    { type: 'button', button: 'right', down: false, x: 0.1, y: 0.2 },
  ]);
  sent.length = 0;
  video.dispatch(ev('pointerdown', { button: 1, clientX: 0, clientY: 0 }));
  assert.deepEqual(sent, [
    { type: 'move', x: 0, y: 0 },
    { type: 'button', button: 'middle', down: true, x: 0, y: 0 },
  ]);
});

test('неизвестная кнопка (4 = назад) протокол не проходит', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('pointerdown', { button: 4 }));
  video.dispatch(ev('pointerup', { button: 4 }));
  assert.deepEqual(sent, []);
});

test('pointercancel отпускает зажатую кнопку — тач-жест планшета не залипает', () => {
  // перехваченный браузером жест даёт pointercancel без последующего pointerup:
  // без релиза здесь кнопка оставалась зажатой на хосте до конца сеанса (ревью v0.4.6)
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('pointerdown', { button: 0, clientX: 10, clientY: 20, pointerId: 7 }));
  sent.length = 0;
  video.dispatch(ev('pointercancel', { clientX: 12, clientY: 22, pointerId: 7 }));
  assert.deepEqual(sent, [
    { type: 'move', x: 0.12, y: 0.22 },
    { type: 'button', button: 'left', down: false, x: 0.12, y: 0.22 },
  ]);
});

test('wheel: 120px по вертикали = 3 строки, мелкий тачпад-жест гасится', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('wheel', { deltaY: 120 }));
  assert.deepEqual(sent, [{ type: 'scroll', dx: 0, dy: 3 }]);
  sent.length = 0;
  video.dispatch(ev('wheel', { deltaX: 40, deltaY: 5 }));
  assert.deepEqual(sent, [{ type: 'scroll', dx: 1, dy: 0 }]);
});

test('клавиатурный маршрут: onKeyboardRoute remote/local + onVideoPointerDown при клике', () => {
  const video = fakeVideo();
  const sent = [];
  const events = [];
  const blurTargets = [];
  const active = { tagName: 'INPUT', blur() { blurTargets.push('input'); } };
  Object.defineProperty(globalThis.document, 'activeElement', { configurable: true, get: () => active });
  const wire = wireBrowserInput(video, (m) => sent.push(m), {
    keys: new Set(['a']),
    onVideoPointerDown: () => blurTargets.push('callback'),
    onKeyboardRoute: (m) => events.push(m),
  });
  video.dispatch(ev('pointermove', { clientX: 30, clientY: 30 }));
  video.dispatch(ev('pointerdown', { clientX: 30, clientY: 30, button: 0 }));
  assert.deepEqual(blurTargets, ['callback']);
  // фокус в поле оператора: клавиша уходит в 'local' и НЕ в канал
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'a', target: active }));
  assert.equal(sent.filter((m) => m.type === 'key').length, 0);
  assert.ok(events.includes('local'));
  // blur (поле больше не поле) → клавиша уходит, route 'remote'
  active.tagName = 'DIV';
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'a' }));
  assert.ok(sent.some((m) => m.type === 'key' && m.key === 'a' && m.down === true));
  assert.ok(events.includes('remote'));
  wire.detach();
});

test('клавиатура по физическому коду: KeyA → key a (раскладка не важна)', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  video.dispatch(ev('pointerenter'));
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'ф' }));
  document.dispatch(ev('keyup', { code: 'KeyA', key: 'ф' }));
  assert.deepEqual(sent, [
    { type: 'key', key: 'a', down: true },
    { type: 'key', key: 'a', down: false },
  ]);
  document.dispatch(ev('keydown', { code: 'Space', key: ' ' }));
  assert.deepEqual(sent.slice(2), [{ type: 'key', key: 'space', down: true }]);
});

test('клавиша вне allowlist-кода не отправляется, сообщается через onUnsupported', () => {
  const video = fakeVideo();
  const sent = [];
  const unsupported = [];
  wireBrowserInput(video, (m) => sent.push(m), {
    keys: INPUT_KEYS, throttleMs: 0, onUnsupported: (k) => unsupported.push(k),
  });
  video.dispatch(ev('pointerenter'));
  document.dispatch(ev('keydown', { code: 'F5', key: 'F5' }));
  document.dispatch(ev('keyup', { code: 'F5', key: 'F5' }));
  assert.deepEqual(sent, []);
  assert.deepEqual(unsupported, ['F5', 'F5']);
});

test('клавиша, запрещённая переданным набором keys, не отправляется', () => {
  const video = fakeVideo();
  const sent = [];
  const unsupported = [];
  wireBrowserInput(video, (m) => sent.push(m), {
    keys: new Set(['a', 'enter']), throttleMs: 0, onUnsupported: (k) => unsupported.push(k),
  });
  video.dispatch(ev('pointerenter'));
  document.dispatch(ev('keydown', { code: 'KeyB', key: 'b' }));
  document.dispatch(ev('keydown', { code: 'Enter', key: 'Enter' }));
  assert.deepEqual(sent, [{ type: 'key', key: 'enter', down: true }]);
  assert.deepEqual(unsupported, ['b']);
});

test('move-события троттлятся: пачка между тиками даёт одно событие', () => {
  const video = fakeVideo();
  const sent = [];
  wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS });
  video.dispatch(ev('pointermove', { clientX: 10, clientY: 10 }));
  video.dispatch(ev('pointermove', { clientX: 20, clientY: 20 }));
  video.dispatch(ev('pointermove', { clientX: 30, clientY: 30 }));
  assert.equal(sent.length, 1);
});

test('обработанные события preventDefault-ятся: страница не скроллится и не даёт меню', () => {
  const video = fakeVideo();
  wireBrowserInput(video, () => {}, { keys: INPUT_KEYS, throttleMs: 0 });
  const wheel = ev('wheel', { deltaY: 120 });
  video.dispatch(wheel);
  assert.equal(wheel.prevented, true);
  const ctx = ev('contextmenu');
  video.dispatch(ctx);
  assert.equal(ctx.prevented, true);
  video.dispatch(ev('pointerenter'));
  const key = ev('keydown', { code: 'Enter', key: 'Enter' });
  document.dispatch(key);
  assert.equal(key.prevented, true);
  // вне видео клавиши не перехватываются: страница работает как обычно
  video.dispatch(ev('pointerleave'));
  const off = ev('keydown', { code: 'Enter', key: 'Enter' });
  document.dispatch(off);
  assert.equal(off.prevented, undefined);
});

test('detach снимает обработчики: после него ничего не отправляется', () => {
  const video = fakeVideo();
  const sent = [];
  const w = wireBrowserInput(video, (m) => sent.push(m), { keys: INPUT_KEYS, throttleMs: 0 });
  w.detach();
  video.dispatch(ev('pointermove', { clientX: 50, clientY: 50 }));
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'a' }));
  assert.deepEqual(sent, []);
});

test('keyup в поле оператора не шлёт сиротский up (ревью GLM-5.3)', () => {
  const video = fakeVideo();
  const sent = [];
  const events = [];
  const active = { tagName: 'INPUT', blur() {} };
  Object.defineProperty(globalThis.document, 'activeElement', { configurable: true, get: () => active });
  const wire = wireBrowserInput(video, (m) => sent.push(m), {
    keys: new Set(['a']),
    onVideoPointerDown: () => {},
    onKeyboardRoute: (m) => events.push(m),
  });
  video.dispatch(ev('pointerenter'));
  // печать в своём поле при курсоре над видео: ни down, ни up не уходят на хост
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'a', target: active }));
  document.dispatch(ev('keyup', { code: 'KeyA', key: 'a', target: active }));
  assert.deepEqual(sent, []);
  assert.ok(events.includes('local'));
  wire.detach();
});

test('клавиша, зажатая над видео и отпущенная в поле, всё же получает up (не залипает)', () => {
  const video = fakeVideo();
  const sent = [];
  const active = { tagName: 'INPUT', blur() {} };
  Object.defineProperty(globalThis.document, 'activeElement', { configurable: true, get: () => active });
  const wire = wireBrowserInput(video, (m) => sent.push(m), { keys: new Set(['a']) });
  video.dispatch(ev('pointerenter'));
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'a' })); // над видео — down ушёл
  assert.deepEqual(sent, [{ type: 'key', key: 'a', down: true }]);
  document.dispatch(ev('keyup', { code: 'KeyA', key: 'a', target: active })); // отпустили в поле
  assert.deepEqual(sent, [
    { type: 'key', key: 'a', down: true },
    { type: 'key', key: 'a', down: false },
  ]);
  wire.detach();
});

test('detach отпускает незакрытые клавиши — пересборка pc не залипает на хосте', () => {
  const video = fakeVideo();
  const sent = [];
  const w = wireBrowserInput(video, (m) => sent.push(m), { keys: new Set(['a']) });
  video.dispatch(ev('pointerenter'));
  document.dispatch(ev('keydown', { code: 'KeyA', key: 'a' }));
  sent.length = 0;
  w.detach();
  assert.deepEqual(sent, [{ type: 'key', key: 'a', down: false }]);
});

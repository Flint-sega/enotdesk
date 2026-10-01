import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputEventToCommands } from '../lib/input-translate.mjs';

test('input-translate: move → mouse move с клампом координат', () => {
  assert.deepEqual(inputEventToCommands({ type: 'move', x: 0.5, y: 0.25 }),
    [{ cmd: 'mouse', x: 0.5, y: 0.25, buttons: 'move' }]);
  assert.deepEqual(inputEventToCommands({ type: 'move', x: 2, y: -1 }),
    [{ cmd: 'mouse', x: 1, y: 0, buttons: 'move' }]);
  assert.deepEqual(inputEventToCommands({ type: 'move', x: 'мусор', y: NaN }),
    [{ cmd: 'mouse', x: 0, y: 0, buttons: 'move' }]);
});

test('input-translate: button → down/up, неизвестная кнопка → left', () => {
  assert.deepEqual(inputEventToCommands({ type: 'button', button: 'right', down: true, x: 0.1, y: 0.9 }),
    [{ cmd: 'mouse', x: 0.1, y: 0.9, buttons: 'down', button: 'right' }]);
  assert.deepEqual(inputEventToCommands({ type: 'button', button: 'left', down: false }),
    [{ cmd: 'mouse', x: 0, y: 0, buttons: 'up', button: 'left' }]);
  assert.deepEqual(inputEventToCommands({ type: 'button', button: 'x', down: true }),
    [{ cmd: 'mouse', x: 0, y: 0, buttons: 'down', button: 'left' }]);
});

test('input-translate: scroll (строки) → wheel в дельтах ×40, dx отброшен', () => {
  // v0.6.0 баг: кейс ловил несуществующий тип 'wheel' — скролл оператора
  // молча терялся (protocol.mjs выдаёт только 'scroll')
  assert.deepEqual(inputEventToCommands({ type: 'scroll', dx: 2, dy: 3 }), [{ cmd: 'wheel', dy: 120 }]);
  assert.deepEqual(inputEventToCommands({ type: 'scroll', dx: 0, dy: -1.4 }), [{ cmd: 'wheel', dy: -40 }]);
  assert.deepEqual(inputEventToCommands({ type: 'scroll', dx: 0, dy: 'мусор' }), [{ cmd: 'wheel', dy: 0 }]);
  assert.deepEqual(inputEventToCommands({ type: 'scroll', dy: Infinity }), [{ cmd: 'wheel', dy: 0 }]);
});

test('input-translate: key → команда с down, пустой ключ отброшен', () => {
  assert.deepEqual(inputEventToCommands({ type: 'key', key: 'a', down: true }), [{ cmd: 'key', key: 'a', down: true }]);
  assert.deepEqual(inputEventToCommands({ type: 'key', key: '', down: true }), []);
  assert.deepEqual(inputEventToCommands({ type: 'key', down: true }), []);
});

test('input-translate: мусор → пустой список', () => {
  assert.deepEqual(inputEventToCommands(null), []);
  assert.deepEqual(inputEventToCommands({}), []);
  assert.deepEqual(inputEventToCommands({ type: 'wheel' }), []); // протокол такой тип не выдаёт
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentInputSink } from '../lib/agent-input.mjs';

// Шов ввода agent-режима (v0.6.4): DataChannel 'input' → dispatch нативного
// адаптера. Реального X11 здесь нет — dispatch подменяется шпионом; на этом
// шве проверяется только то, что НЕ внутри dispatch: форма потока, display-
// гашение и политика шум/тишина вокруг throttle.

function fakeChannel() {
  const ch = { onmessage: null };
  ch.emit = (data) => ch.onmessage({ data });
  return ch;
}

function spyInput(log = []) {
  return {
    dispatch: (ev, bounds) => { log.push({ ev, bounds }); return { ok: true }; },
  };
}

test('move: нормализованные координаты уходят в dispatch вместе с bounds из getBounds', () => {
  const calls = [];
  const sink = createAgentInputSink({
    nativeInput: spyInput(calls),
    getBounds: () => ({ width: 1920, height: 1080 }),
  });
  const ch = fakeChannel();
  sink.handleChannel(ch);
  ch.emit(JSON.stringify({ type: 'move', x: 0.5, y: 0.25 }));
  assert.deepEqual(calls, [
    { ev: { type: 'move', x: 0.5, y: 0.25 }, bounds: { width: 1920, height: 1080 } },
  ]);
});

test('мусор не доезжает до dispatch: не-строка и не-JSON молча отбрасываются', () => {
  const calls = [];
  const sink = createAgentInputSink({ nativeInput: spyInput(calls), getBounds: () => null });
  const ch = fakeChannel();
  sink.handleChannel(ch);
  ch.emit('not json'); // строка, но не JSON
  ch.emit({ type: 'move', x: 1 }); // не строка вовсе
  assert.deepEqual(calls, []);
});

test('display off/on — гашение дисплея хелпера: на Linux не поддерживается, в dispatch не уходит', () => {
  const calls = [];
  const sink = createAgentInputSink({ nativeInput: spyInput(calls), getBounds: () => null });
  const ch = fakeChannel();
  sink.handleChannel(ch);
  ch.emit(JSON.stringify({ display: 'off' }));
  ch.emit(JSON.stringify({ display: 'on' }));
  assert.deepEqual(calls, []);
});

test('отказ dispatch виден в warn — кроме throttled (норма движения мыши, не шумим)', () => {
  const warns = [];
  const sink = createAgentInputSink({
    nativeInput: { dispatch: () => ({ ok: false, reason: 'no-bounds' }) },
    getBounds: () => null,
    log: { warn: (msg) => warns.push(msg) },
  });
  const ch = fakeChannel();
  sink.handleChannel(ch);
  ch.emit(JSON.stringify({ type: 'key', key: 'a', down: true }));
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes('no-bounds'), 'причина отказа доходит в лог');

  const quiet = [];
  const throttling = createAgentInputSink({
    nativeInput: { dispatch: () => ({ ok: false, reason: 'throttled' }) },
    getBounds: () => null,
    log: { warn: (msg) => quiet.push(msg) },
  });
  const ch2 = fakeChannel();
  throttling.handleChannel(ch2);
  ch2.emit(JSON.stringify({ type: 'move', x: 0.5, y: 0.5 }));
  assert.deepEqual(quiet, [], 'throttle не логируется');
});

test('getBounds не передан: dispatch получает null bounds — масштабирование честно не состоится', () => {
  const calls = [];
  const sink = createAgentInputSink({ nativeInput: spyInput(calls) });
  const ch = fakeChannel();
  sink.handleChannel(ch);
  ch.emit(JSON.stringify({ type: 'scroll', dx: 0, dy: 3 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bounds, null);
});

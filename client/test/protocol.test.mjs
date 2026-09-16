import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInputEvent, validateOutgoingSignal, createInputGate, wheelToLines } from '../lib/protocol.mjs';

// Ожидания заданы из frozen-контракта interfaces.md, не из кода под тестом:
// move x:0..1 y:0..1; button left|right|middle down:bool; key allowlist down:bool; scroll dx,dy bounded.

test('validateInputEvent: допустимые события контракта проходят', () => {
  assert.deepEqual(validateInputEvent({ type: 'move', x: 0.5, y: 1 }), { ok: true });
  assert.deepEqual(validateInputEvent({ type: 'move', x: 0, y: 0 }), { ok: true });
  assert.deepEqual(validateInputEvent({ type: 'button', button: 'left', down: true }), { ok: true });
  assert.deepEqual(validateInputEvent({ type: 'button', button: 'middle', down: false }), { ok: true });
  assert.deepEqual(validateInputEvent({ type: 'key', key: 'a', down: true }), { ok: true });
  assert.deepEqual(validateInputEvent({ type: 'key', key: 'ArrowLeft', down: false }), { ok: true });
  assert.deepEqual(validateInputEvent({ type: 'scroll', dx: -300, dy: 300 }), { ok: true });
});

test('validateInputEvent: координаты вне 0..1, не числа, NaN отклоняются', () => {
  for (const bad of [
    { type: 'move', x: -0.01, y: 0.5 },
    { type: 'move', x: 0.5, y: 1.0001 },
    { type: 'move', x: '0.5', y: 0.5 },
    { type: 'move', x: NaN, y: 0.5 },
    { type: 'move', x: 0.5 },
  ]) assert.equal(validateInputEvent(bad).ok, false, JSON.stringify(bad));
});

test('validateInputEvent: кнопки вне enum и клавиши вне allowlist отклоняются', () => {
  assert.equal(validateInputEvent({ type: 'button', button: 'left', down: 'yes' }).ok, false);
  assert.equal(validateInputEvent({ type: 'button', button: 'side', down: true }).ok, false);
  // произвольные клавиши/сканкоды запрещены контрактом
  assert.equal(validateInputEvent({ type: 'key', key: 'F12', down: true }).ok, false);
  assert.equal(validateInputEvent({ type: 'key', key: 'a; rm -rf /', down: true }).ok, false);
  assert.equal(validateInputEvent({ type: 'key', key: 'KeyA', down: true }).ok, false);
  assert.equal(validateInputEvent({ type: 'scancode', code: 30 }).ok, false);
  assert.equal(validateInputEvent(null).ok, false);
  assert.equal(validateInputEvent({ type: 'exec', cmd: 'ls' }).ok, false);
  assert.equal(validateInputEvent({ type: 'scroll', dx: 1e9, dy: 0 }).ok, false);
});

test('validateOutgoingSignal: только описание offer/answer или candidate, с ограничением размера', () => {
  assert.equal(validateOutgoingSignal({ type: 'signal', data: { description: { type: 'offer', sdp: 'v=0...' } } }).ok, true);
  assert.equal(validateOutgoingSignal({ type: 'signal', data: { candidate: { candidate: 'candidate:1' } } }).ok, true);
  assert.equal(validateOutgoingSignal({ type: 'signal', data: { description: { type: 'renegotiate', sdp: 'x' } } }).ok, false);
  assert.equal(validateOutgoingSignal({ type: 'signal', data: { arbitrary: true } }).ok, false);
  assert.equal(validateOutgoingSignal({ type: 'signal', data: { description: { type: 'offer', sdp: 'x'.repeat(64 * 1024 + 1) } } }).ok, false);
  assert.equal(validateOutgoingSignal({ type: 'auth', token: 'leak' }).ok, false);
});

test('input gate: открывается только для host после реального approved и закрывается при ended/close', () => {
  const gate = createInputGate();
  assert.equal(gate.isOpen(), false);
  gate.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'waiting' });
  assert.equal(gate.isOpen(), false); // waiting — нет согласия
  gate.onSignal({ type: 'claim', claimId: 'c1', operator: { id: 'u', name: 'Оператор' } });
  assert.equal(gate.isOpen(), false); // pending-consent — нет согласия
  gate.onSignal({ type: 'approved', claimId: 'c1' });
  assert.equal(gate.isOpen(), true);
  gate.onSignal({ type: 'ended', reason: 'host-lost' });
  assert.equal(gate.isOpen(), false);
});

test('input gate: для оператора никогда не открыт; сброс открытого состояния помечает needInputReset', () => {
  const gate = createInputGate();
  gate.onSignal({ type: 'ready', role: 'operator', sessionId: 1, state: 'pending-consent' });
  gate.onSignal({ type: 'approved', claimId: 'c1' });
  assert.equal(gate.isOpen(), false);
  assert.equal(gate.needInputReset(), false);

  const g2 = createInputGate();
  g2.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'waiting' });
  g2.onSignal({ type: 'approved', claimId: 'c1' });
  assert.equal(g2.isOpen(), true);
  assert.equal(g2.needInputReset(), false);
  g2.onSignal({ type: 'ended', reason: 'denied' });
  assert.equal(g2.needInputReset(), true, 'переход открыт->закрыт требует сброса зажатых клавиш');
  assert.equal(g2.needInputReset(), false, 'сброс одноразовый');
  g2.close();
  assert.equal(g2.isOpen(), false);
});

test('input gate: транзиентные ошибки сервера (rate_limited, bad_signal) управление не рвут', () => {
  const gate = createInputGate();
  gate.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'waiting' });
  gate.onSignal({ type: 'approved', claimId: 'c1' });
  assert.equal(gate.isOpen(), true);
  gate.onSignal({ type: 'error', code: 'rate_limited', message: 'Слишком частая передача сигналов' });
  assert.equal(gate.isOpen(), true, 'бурст ICE не должен отнимать управление');
  gate.onSignal({ type: 'error', code: 'bad_signal', message: 'Некорректный сигнал' });
  assert.equal(gate.isOpen(), true);
  gate.onSignal({ type: 'heartbeat' }); // посторонние типы тоже не трогают
  assert.equal(gate.isOpen(), true);
  // закрыть ворота может только ended (или закрытие соединения → close())
  gate.onSignal({ type: 'ended', reason: 'operator-lost' });
  assert.equal(gate.isOpen(), false);
});

test('wheelToLines: пиксели колеса → строки, мелкий тачпад гасится, клэмп ±50', () => {
  assert.equal(wheelToLines(0), 0);
  assert.equal(wheelToLines(10), 0, 'микродвижение тачпада не скроллит');
  assert.equal(wheelToLines(-10), 0);
  assert.equal(wheelToLines(120), 3, 'щелчок мыши ≈ 3 строки');
  assert.equal(wheelToLines(-120), -3);
  assert.equal(wheelToLines(1e9), 50, 'верхний клэмп');
  assert.equal(wheelToLines(-1e9), -50, 'нижний клэмп');
  assert.equal(wheelToLines(NaN), 0);
  assert.equal(wheelToLines('100'), 0);
});

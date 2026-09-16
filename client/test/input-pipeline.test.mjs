import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputGate, validateInputEvent, INPUT_KEYS } from '../lib/protocol.mjs';
import { createNativeInput, inertAdapter } from '../lib/native-input.mjs';
import { createInputPipeline, createHostChannel } from '../lib/input-pipeline.mjs';

// Шов: канал оператора (datachannel) → main-ворота (input-gate по реальному
// approved) → диспетчер нативного адаптера. Приёмник — инертный адаптер:
// reason 'native-unavailable' доказывает, что событие прошло ворота и дошло
// до диспетчера (в отличие от 'gate-closed', когда ворота закрыты).

function makePipeline() {
  const gate = createInputGate();
  const nativeInput = createNativeInput({ adapter: inertAdapter() });
  const pipeline = createInputPipeline({ gate, nativeInput });
  const channel = createHostChannel({ handle: (ev) => pipeline.handle(ev, { width: 800, height: 600 }) });
  return { gate, nativeInput, pipeline, channel };
}

test('событие оператора до approved не проходит ворота', () => {
  const { gate, channel } = makePipeline();
  gate.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'pending-consent' });
  const r = channel.onMessage(JSON.stringify({ type: 'move', x: 0.5, y: 0.5 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gate-closed');
});

test('после реального approved хотя бы одно событие доходит до диспетчера адаптера', () => {
  const { gate, channel } = makePipeline();
  gate.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'waiting' });
  gate.onSignal({ type: 'claim', claimId: 'c1', operator: { id: 'u', name: 'Оператор' } });
  gate.onSignal({ type: 'approved', claimId: 'c1' }); // реальное WS-событие, не флаг рендерера
  const r = channel.onMessage(JSON.stringify({ type: 'move', x: 0.5, y: 0.5 }));
  assert.equal(r.ok, false, 'инертный адаптер не исполняет ввод');
  assert.equal(r.reason, 'native-unavailable', 'событие прошло ворота и достигло диспетчера');
  const r2 = channel.onMessage(JSON.stringify({ type: 'button', button: 'left', down: true }));
  assert.equal(r2.reason, 'native-unavailable');
});

test('мусор в канале отбраковывается до ворот (плохой JSON, не объект, запрещённый тип)', () => {
  const { channel } = makePipeline();
  assert.equal(channel.onMessage('not json{').reason, 'bad-json');
  assert.equal(channel.onMessage('42').reason, 'shape');
  assert.equal(channel.onMessage(JSON.stringify({ type: 'exec', cmd: 'ls' })).reason, 'invalid:type-not-allowed');
});

test('move без реальных границ дисплея отклоняется (no-bounds), кнопки не зависят от границ', () => {
  const gate = createInputGate();
  const nativeInput = createNativeInput({ adapter: inertAdapter() });
  const pipeline = createInputPipeline({ gate, nativeInput });
  gate.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'waiting' });
  gate.onSignal({ type: 'approved', claimId: 'c1' });

  assert.equal(pipeline.handle({ type: 'move', x: 0.5, y: 0.5 }, { width: 0, height: 0 }).reason, 'no-bounds');
  assert.equal(pipeline.handle({ type: 'move', x: 0.5, y: 0.5 }, undefined).reason, 'no-bounds');
  // кнопке координаты не нужны: она доходит до диспетчера (инертный — native-unavailable)
  assert.equal(pipeline.handle({ type: 'button', button: 'left', down: true }, { width: 0, height: 0 }).reason, 'native-unavailable');
});

test('allowlist клавиш — единственный источник: export согласован с validateInputEvent', () => {
  assert.ok(INPUT_KEYS instanceof Set && INPUT_KEYS.size > 20);
  for (const key of INPUT_KEYS) {
    assert.equal(validateInputEvent({ type: 'key', key, down: true }).ok, true, key);
  }
  // известные неподдерживаемые клавиши честно отклоняются (кириллица, F-клавиши)
  assert.equal(validateInputEvent({ type: 'key', key: 'ф', down: true }).ok, false);
  assert.equal(validateInputEvent({ type: 'key', key: 'F12', down: true }).ok, false);
});

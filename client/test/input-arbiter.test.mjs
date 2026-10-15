import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputArbiter } from '../lib/input-arbiter.mjs';

// Арбитраж ввода мультиоператора (W-C4, волна C): чистый модуль без Electron.
// Правила: одинокий оператор получает ввод автоматически; при >1 — только
// захвативший; release/drop активного сбрасывают активного БЕЗ автопередачи.

test('авто-выдача первому: attach при отсутствии активного делает его активным', () => {
  const events = [];
  const a = createInputArbiter({ onChange: (op, ops) => events.push([op, ops]) });
  a.attach('op-1');
  assert.equal(a.active(), 'op-1');
  assert.equal(a.isAllowed('op-1'), true);
  assert.deepEqual(events.at(-1), ['op-1', ['op-1']], 'onChange сообщил активного и список');
});

test('claim второго переключает активного; события смены видны обоим', () => {
  const a = createInputArbiter();
  a.attach('op-1');
  a.attach('op-2');
  assert.equal(a.active(), 'op-1', 'второй attach не перебивает активного');
  assert.equal(a.isAllowed('op-2'), false);
  a.claim('op-2');
  assert.equal(a.active(), 'op-2');
  assert.equal(a.isAllowed('op-1'), false, 'первый больше не вводчик');
  assert.equal(a.isAllowed('op-2'), true);
});

test('release активного сбрасывает ввод без автопередачи', () => {
  const a = createInputArbiter();
  a.attach('op-1');
  a.attach('op-2');
  a.claim('op-2');
  a.release('op-2');
  assert.equal(a.active(), null);
  assert.equal(a.isAllowed('op-1'), false, 'автопередачи первому нет — только по явной кнопке');
  assert.equal(a.isAllowed('op-2'), false);
  // повторный захват — любым
  a.claim('op-1');
  assert.equal(a.isAllowed('op-1'), true);
});

test('drop активного сбрасывает ввод; drop не-активного не трогает активного', () => {
  const a = createInputArbiter();
  a.attach('op-1');
  a.attach('op-2');
  a.claim('op-2');
  a.drop('op-1'); // не-активный ушёл
  assert.equal(a.active(), 'op-2', 'уход не-активного не меняет активного');
  assert.deepEqual(a.attached(), ['op-2']);
  a.drop('op-2'); // активный ушёл
  assert.equal(a.active(), null);
  assert.equal(a.attached().length, 0);
});

test('повторный claim того же — no-op (onChange молчит); чужой claim без attach игнорируется', () => {
  const events = [];
  const a = createInputArbiter({ onChange: (op) => events.push(op) });
  a.attach('op-1');
  a.claim('op-1'); // уже активный
  assert.equal(events.length, 1, 'лишнего события смены нет');
  a.claim('ghost'); // не attached
  assert.equal(a.active(), 'op-1');
  assert.equal(events.length, 1, 'чужой claim не породил событие');
});

test('isAllowed для не-активного false; никакой op не разрешён без активного', () => {
  const a = createInputArbiter();
  assert.equal(a.isAllowed('op-1'), false);
  a.attach('op-1');
  a.release('op-1');
  assert.equal(a.isAllowed('op-1'), false, 'после release даже единственный не вводит');
});

test('reset чистит всех (конец сеанса); повторный reset молчит', () => {
  const events = [];
  const a = createInputArbiter({ onChange: () => events.push(1) });
  a.attach('op-1');
  a.attach('op-2');
  a.reset();
  assert.equal(a.active(), null);
  assert.deepEqual(a.attached(), []);
  const seen = events.length;
  a.reset(); // уже пусто — без события
  assert.equal(events.length, seen);
});

test('onChange не должен ронять арбитра (слушатель бросает)', () => {
  const a = createInputArbiter({ onChange: () => { throw new Error('listener boom'); } });
  a.attach('op-1');
  assert.equal(a.active(), 'op-1', 'арбитр жив после исключения слушателя');
});

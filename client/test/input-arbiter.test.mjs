import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputArbiter, participantsMessage, parseControlMessage } from '../lib/input-arbiter.mjs';

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

// ---- этапы 2–3 (ADR 0035): передача конкретному, «только смотреть», список ----

test('pass: активный передаёт ввод конкретному участнику, чужой pass игнорируется', () => {
  const a = createInputArbiter();
  a.attach('op-1');
  a.attach('op-2');
  a.attach('op-3');
  a.pass('op-2', 'op-3');
  assert.equal(a.active(), 'op-1', 'передавать может только активный');
  a.pass('op-1', 'op-9');
  assert.equal(a.active(), 'op-1', 'неизвестному участнику не передаётся');
  a.pass('op-1', 'op-3');
  assert.equal(a.active(), 'op-3');
  assert.equal(a.isAllowed('op-1'), false);
});

test('только смотреть: без автовыдачи, claim и pass не дают ввод, выключение возвращает одинокому', () => {
  const events = [];
  const a = createInputArbiter({ onChange: (_op, _ops, parts) => events.push(parts) });
  a.attach('op-1');
  a.setViewOnly('op-1', true);
  assert.equal(a.active(), null, 'включение снимает ввод с активного');
  a.claim('op-1');
  assert.equal(a.active(), null, 'claim наблюдателя игнорируется');
  a.attach('op-2');
  assert.equal(a.active(), 'op-2', 'новый не-наблюдатель получает свободный ввод');
  a.pass('op-2', 'op-1');
  assert.equal(a.active(), 'op-2', 'наблюдателю ввод не передаётся');
  assert.deepEqual(events.at(-1), [{ op: 'op-1', control: false, viewOnly: true }, { op: 'op-2', control: true, viewOnly: false }]);
  a.drop('op-2');
  a.setViewOnly('op-1', false);
  assert.equal(a.active(), 'op-1', 'остался один — ввод снова его');
});

test('attach наблюдателя после сброса режима не тянет старое состояние', () => {
  const a = createInputArbiter();
  a.attach('op-1');
  a.setViewOnly('op-1', true);
  a.drop('op-1');
  a.attach('op-1');
  assert.equal(a.active(), 'op-1', 'drop забывает режим наблюдателя');
});

test('participantsMessage: имена ставит хост, you — получатель', () => {
  const msg = participantsMessage([{ op: 'c1', control: true, viewOnly: false }, { op: 'c2', control: false, viewOnly: true }], 'c2',
    (op) => ({ c1: 'Анна' })[op]);
  assert.deepEqual(msg, { type: 'participants', you: 'c2', list: [
    { id: 'c1', name: 'Анна', control: true, viewOnly: false },
    { id: 'c2', name: '', control: false, viewOnly: true },
  ] });
});

test('parseControlMessage: служебные claim/release/pass/view-only, остальное — не служебное', () => {
  assert.deepEqual(parseControlMessage('{"type":"claim-input"}'), { type: 'claim-input' });
  assert.deepEqual(parseControlMessage('{"type":"pass-input","to":"c2"}'), { type: 'pass-input', to: 'c2' });
  assert.deepEqual(parseControlMessage('{"type":"view-only","on":true}'), { type: 'view-only', on: true });
  assert.deepEqual(parseControlMessage('{"type":"view-only","on":"yes"}'), { type: 'invalid' });
  assert.deepEqual(parseControlMessage('{"type":"pass-input"}'), { type: 'invalid' });
  assert.equal(parseControlMessage('{"type":"move","x":0.1,"y":0.2}'), null, 'событие ввода — не служебное');
  assert.equal(parseControlMessage('мусор'), null);
  assert.equal(parseControlMessage('x'.repeat(600)), null);
});

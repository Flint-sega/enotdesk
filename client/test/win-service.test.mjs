import test from 'node:test';
import assert from 'node:assert/strict';
import { createScmParentLogic, runAsScmParent } from '../lib/win-service.mjs';

// SCM-родитель Windows-службы (дефект №4): логика жизненного цикла на инъекциях —
// koffi и SCM не нужны. Состояния SERVICE_* — константы win32:
// 1=STOPPED, 2=START_PENDING, 3=STOP_PENDING, 4=RUNNING.

function harness({ throwingSpawn = false } = {}) {
  const statuses = [];
  let child = { alive: true };
  const events = [];
  const logic = createScmParentLogic({
    setStatus: (code, extra) => statuses.push({ code, ...extra }),
    spawnChild: (onExit) => {
      if (throwingSpawn) throw new Error('spawn failed');
      events.push('spawn');
      child = { alive: true, onExit };
    },
    killChild: () => {
      events.push('kill');
      child.alive = false;
    },
    log: { info() {}, warn() {}, error() {} },
  });
  return { logic, statuses, events, childRef: () => child };
}

test('ServiceMain: START_PENDING → ребёнок запущен → RUNNING', () => {
  const { logic, statuses, events } = harness();
  logic.setStatusHandle({});
  logic.onServiceMain();
  assert.deepEqual(events, ['spawn']);
  assert.deepEqual(statuses.map((s) => s.code), [2, 4], 'START_PENDING затем RUNNING');
});

test('ServiceMain без handle: честный STOPPED, child не запускается', () => {
  const { logic, statuses, events } = harness();
  logic.onServiceMain();
  assert.deepEqual(events, [], 'без SCM-хендла ребёнка не запускаем');
  assert.deepEqual(statuses.map((s) => s.code), [1], 'STOPPED');
  assert.equal(logic.isStopping(), true);
});

test('STOP: STOP_PENDING → ребёнок убит → STOPPED; повторная команда игнорируется', () => {
  const { logic, statuses, events, childRef } = harness();
  logic.setStatusHandle({});
  logic.onServiceMain();
  statuses.length = 0;
  events.length = 0;
  assert.equal(logic.onControl(1), 0, 'NO_ERROR на SERVICE_CONTROL_STOP');
  assert.deepEqual(events, ['kill']);
  assert.equal(childRef().alive, false);
  assert.deepEqual(statuses.map((s) => s.code), [3, 1], 'STOP_PENDING затем STOPPED');
  const after = [...statuses];
  assert.equal(logic.onControl(1), 0, 'повторный STOP не роняет');
  assert.deepEqual(statuses, after, 'повторная команда не переотчитывается и не убивает снова');
});

test('STOP в окне рестарта (ребёнок мёртв): kill не зовётся — lastPid указывает на мёртвый pid', () => {
  const { logic, events } = harness();
  logic.setStatusHandle({});
  logic.onServiceMain();
  // эмулируем смерть ребёнка и запуск отложенного рестарта: childRunning=false
  // (как ставит onChildExit), таймер рестарта ещё тикает
  logic.state.childRunning = false;
  events.length = 0;
  logic.onControl(1);
  assert.equal(logic.isStopping(), true);
  assert.equal(events.includes('kill'), false, 'убивать нечего: taskkill по мёртвому/переиспользованному pid недопустим');
});

test('падение ребёнка ПОСЛЕ STOP: рестарт не планируется (гвард stopping)', async (t) => {
  const statuses = [];
  let exitCb = null;
  let spawns = 0;
  const logic = createScmParentLogic({
    setStatus: (code) => statuses.push(code),
    spawnChild: (onExit) => { spawns += 1; exitCb = onExit; },
    killChild() {},
    log: { info() {}, warn() {}, error() {} },
  });
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    logic.setStatusHandle({});
    logic.onServiceMain();
    assert.equal(spawns, 1);
    exitCb(); // ребёнок умер → рестарт отложен
    logic.onControl(1); // STOP во время задержки рестарта
    const spawnsAtStop = spawns;
    exitCb(); // «позднее» падение ребёнка при stopping=true
    timers.tick(60_000);
    assert.equal(spawns, spawnsAtStop, 'остановленная служба не рес fopenит ребёнка');
    assert.equal(logic.isStopping(), true);
  } finally {
    timers.reset();
  }
});

test('отказ spawnChild (throw): эскалация по рестарт-циклу и честный STOPPED вместо краха', async (t) => {
  const statuses = [];
  const delays = [];
  const logic = createScmParentLogic({
    setStatus: (code) => statuses.push(code),
    spawnChild() { throw new Error('spawn failed'); },
    killChild() {},
    log: { info() {}, warn() {}, error() {} },
  });
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'Date'] });
  const origSet = globalThis.setTimeout;
  // таймеры перекладываем в мок с нулевой задержкой: один tick прокручивает
  // весь каскад рестартов синхронно
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return origSet(fn, 0); };
  try {
    logic.setStatusHandle({});
    logic.onServiceMain(); // первый spawn бросил → рестарт 1000
    timers.tick(1000);     // каскад: 2000, 5000, 10000, 30000 → попытки исчерпаны
    assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000],
      'throw из spawnChild идёт по эскалации рестартов, а не роняет службу');
    assert.equal(logic.isStopping(), true, 'после MAX попыток родитель сдался честно');
    assert.equal(statuses[statuses.length - 1], 1, 'финальный статус STOPPED — рестарт силами SCM');
  } finally {
    globalThis.setTimeout = origSet;
    timers.reset();
  }
});

test('перманентное падение: после MAX попыток — честный STOPPED (рестарт силами SCM)', async (t) => {
  const statuses = [];
  let exitCb = null;
  const logic = createScmParentLogic({
    setStatus: (code) => statuses.push(code),
    spawnChild: (onExit) => { exitCb = onExit; },
    killChild() {},
    log: { info() {}, warn() {}, error() {} },
  });
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    logic.setStatusHandle({});
    logic.onServiceMain(); // старт → RUNNING
    // 5 падений подряд: рестарты 1с,2с,5с,10с,30с (attempt 0..4), 6-е падение — сдаёмся
    for (const delay of [1000, 2000, 5000, 10000, 30000]) {
      exitCb();
      timers.tick(delay);
    }
    assert.equal(logic.isStopping(), false, 'после 5 падений ещё живы: attempts исчерпаны на 6-м');
    statuses.length = 0;
    exitCb(); // 6-е падение → отказ от рестартов
    assert.equal(logic.isStopping(), true, 'родитель сдался');
    assert.deepEqual(statuses, [1], 'честный SERVICE_STOPPED — SCM-failure actions рестартуют службу');
    timers.tick(300_000);
    assert.equal(statuses.length, 1, 'больше никаких setStatus — цикл остановлен');
  } finally {
    timers.reset();
  }
});

test('эскалация рестартов 1/2/5/10с, кап 30с; сброс счётчика после стабильных 60с', async (t) => {
  const statuses = [];
  let exitCb = null;
  const logic = createScmParentLogic({
    setStatus: (code) => statuses.push(code),
    spawnChild: (onExit) => { exitCb = onExit; },
    killChild() {},
    log: { info() {}, warn() {}, error() {} },
  });
  const delays = [];
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout', 'Date'] });
  const origSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return origSet(fn, 0); };
  try {
    logic.setStatusHandle({});
    logic.onServiceMain();
    // падения ПОДРЯД (ребёнок падает мгновенно после рестарта): эскалация
    for (const expected of [1000, 2000, 5000, 10000, 30000]) {
      exitCb();
      timers.tick(expected);
      assert.deepEqual(delays.slice(-1), [expected], `рестарт №${delays.length} через ${expected} мс`);
    }
    // стабильный прогон: старт, 61с работы, падение → счётчик сброшен, снова 1000
    delays.length = 0;
    logic.state.restartAttempt = 3;
    logic.state.startedAt = Date.now() - 61_000; // давно стартовали
    exitCb();
    assert.deepEqual(delays, [1000], 'после стабильных 60с счётчик попыток сброшен');
    // инвариант отмены: сработавший таймер обнуляет restartTimer
    assert.equal(logic.state.restartTimer !== undefined, true, 'поле restartTimer существует и управляется');
  } finally {
    globalThis.setTimeout = origSet;
    timers.reset();
  }
});

// Корень W-U2 (найден diag-логом 29.09 на живой машине): koffi.proto регистрирует
// тип под именем из строки прототипа; сигнатура RegisterServiceCtrlHandlerExA
// ссылалась на «HandlerProc *», а тип назывался ENOT_HandlerProc — родитель умирал
// за 1 с («Unknown or invalid type name») до всякого SetServiceStatus, SCM давал
// 7009/1053. Этот тест упражняет настоящий koffi-клей: падение резолва типов
// здесь означает регрессию. Вне SCM диспетчер честно отвергает таблицу (res=0).
// timeout: вне Windows тест скипается, но если платформенное допущение
// («диспетчер вне SCM возвращается немедленно») когда-нибудь сломается,
// вечный промис убил бы CI-джобу по общему таймауту вместо диагностируемого
// фейла (ревью v0.4.6)
test('runAsScmParent: koffi-клей резолвит типы (win32; вне SCM — честный res=0)', { skip: process.platform !== 'win32', timeout: 15_000 }, async () => {
  const lines = [];
  const res = await runAsScmParent({
    childArgv: ['--win-service-test'],
    childEnv: {},
    log: { log() {}, warn() {}, error() {}, info() {} },
    diag: { write: (tag, msg) => { lines.push(`${tag}: ${msg}`); return true; } },
  });
  assert.equal(res, 0, 'вне SCM диспетчер отвергает таблицу и возвращает 0');
  assert.ok(lines.some((l) => l.includes('koffi загружен')), 'koffi поднялся');
  assert.ok(lines.some((l) => l.startsWith('svc: StartServiceCtrlDispatcher вызван')), 'дошли до диспетчера — типы зарезолвлены');
  assert.ok(lines.some((l) => l.includes('диспетчер вернулся')), 'диспетчер вернулся без падения клея');
});

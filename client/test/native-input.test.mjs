import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeInput, inertAdapter, waylandAdapterProbe, linesToWinDelta, linesToClicks, loadPlatformAdapter } from '../lib/native-input.mjs';

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

test('ленивая загрузка: status() не грузит адаптер, непроверенное не выдаётся за доступное', () => {
  let loads = 0;
  const ni = createNativeInput({ getAdapter: () => { loads += 1; return inertAdapter(); } });
  const before = ni.status();
  assert.equal(loads, 0, 'status/permissions не форсируют загрузку нативного модуля');
  assert.equal(before.checked, false);
  assert.equal(before.available, false);
  assert.equal(before.reason, 'native-not-checked');
  ni.load();
  assert.equal(loads, 1);
  assert.equal(ni.status().checked, true);
});

test('ленивая загрузка: первый реальный ввод поднимает адаптер ровно один раз', () => {
  let loads = 0;
  const adapter = { available: true, platform: 'test', move() {}, button() {}, key() {}, scroll() {} };
  const ni = createNativeInput({ getAdapter: () => { loads += 1; return adapter; } });
  assert.equal(ni.dispatch({ type: 'move', x: 0.5, y: 0.5 }, { width: 10, height: 10 }).ok, true);
  assert.equal(loads, 1);
  ni.dispatch({ type: 'move', x: 0.2, y: 0.2 }, { width: 10, height: 10 });
  assert.equal(loads, 1, 'повторный ввод не перезагружает адаптер');
});

test('Wayland диагностируется как без управления вводом, честно', () => {
  const probe = waylandAdapterProbe({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' });
  assert.equal(probe.available, false);
  assert.equal(probe.reason, 'wayland-unsupported-control');
});

// Калибровка скролла: протокол передаёт строки (щелчок мыши ≈ 3 строки).
// Ожидания считаны из констант Windows (WHEEL_DELTA=120) и X11 (кнопки 4/5/6/7).
test('скролл: строки → дельта Windows (40 на строку) и щелчки X11 (3 строки на щелчок)', () => {
  assert.equal(linesToWinDelta(3), 120, 'щелчок мыши = WHEEL_DELTA');
  assert.equal(linesToWinDelta(-1), -40);
  assert.equal(linesToWinDelta(0), 0);

  assert.equal(linesToClicks(0), 0);
  assert.equal(linesToClicks(1), 1, 'меньше строки — всё равно один щелчок');
  assert.equal(linesToClicks(3), 1);
  assert.equal(linesToClicks(-4), 1);
  assert.equal(linesToClicks(7), 2, '7 строк ≈ 2 щелчка');
  assert.equal(linesToClicks(NaN), 0);
});

test('скролл доходит до адаптера в строках без искажений', () => {
  let got = null;
  const adapter = {
    available: true, platform: 'test',
    move() {}, button() {}, key() {},
    scroll(dx, dy) { got = [dx, dy]; },
  };
  const ni = createNativeInput({ adapter });
  assert.deepEqual(ni.dispatch({ type: 'scroll', dx: 0, dy: -6 }, { width: 1, height: 1 }), { ok: true });
  assert.deepEqual(got, [0, -6], 'адаптер получает строки как есть — перевод в единицы ОС внутри адаптера');
});

test('winAdapter: SendInput-буферы с правильными x64-смещениями (dwFlags@20, KEYEVENTF_KEYUP@12)', () => {
  // мок koffi: load() → { func() }, SendInput перехватывает буферы
  const sent = [];
  const fakeKoffi = {
    load() {
      return {
        func(_sig, _opts) {
          return (count, buf) => { sent.push(Buffer.from(buf)); return count; };
        },
      };
    },
  };
  // winAdapter не экспортируется — достаём через loadPlatformAdapter на win32-платформе
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let ad;
  try {
    ad = loadPlatformAdapter(fakeKoffi);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
  assert.equal(ad.platform, 'windows-sendinput', 'win-адаптер собрался на моке');

  // мышь: dwFlags на 20, dx/dy/mouseData нули
  sent.length = 0;
  ad.button('left', true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].readUInt32LE(0), 0, 'INPUT_MOUSE');
  assert.equal(sent[0].readUInt32LE(8), 0, 'dx=0');
  assert.equal(sent[0].readUInt32LE(12), 0, 'dy=0');
  assert.equal(sent[0].readUInt32LE(16), 0, 'mouseData=0');
  assert.equal(sent[0].readUInt32LE(20), 2, 'MOUSEEVENTF_LEFTDOWN@20');
  ad.button('left', false);
  assert.equal(sent[1].readUInt32LE(20), 4, 'MOUSEEVENTF_LEFTUP@20');

  // клавиатура: wVk@8, KEYEVENTF_KEYUP@12 (не 16!)
  sent.length = 0;
  ad.key('a', true);
  assert.equal(sent[0].readUInt32LE(0), 1, 'INPUT_KEYBOARD');
  assert.equal(sent[0].readUInt16LE(8), 0x41, 'VK_A@8');
  assert.equal(sent[0].readUInt32LE(12), 0, 'keydown: dwFlags=0@12');
  ad.key('a', false);
  assert.equal(sent[1].readUInt16LE(8), 0x41);
  assert.equal(sent[1].readUInt32LE(12), 2, 'KEYEVENTF_KEYUP@12');
});

const vkExpect = { '-': 0xbd, '=': 0xbb, '.': 0xbe, ',': 0xbc, '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0 };
test('winAdapter: пунктуация протокола инжектится через VK_OEM, honest false вне карты', () => {
  const sent = [];
  const fakeKoffi = {
    load() {
      return {
        func(_sig) {
          return (count, buf) => { sent.push(Buffer.from(buf)); return count; };
        },
      };
    },
  };
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  let ad;
  try { ad = loadPlatformAdapter(fakeKoffi); } finally { Object.defineProperty(process, 'platform', { value: realPlatform }); }
  const _vkCodes = [];
  for (const k of ['-', '=', '.', ',', '/', ';', "'", '[', ']', '\\', '`']) {
    sent.length = 0;
    assert.equal(ad.key(k, true), true, 'пунктуация ' + JSON.stringify(k) + ' поддержана');
    assert.equal(sent[0].readUInt16LE(8), vkExpect[k], 'VK-код ' + JSON.stringify(k) + '@8');
    assert.equal(sent[0].readUInt32LE(12), 0, 'keydown: dwFlags=0@12');
  }

  // расширенные клавиши: KEYEVENTF_EXTENDEDKEY (0x0004) в down и up
  sent.length = 0;
  ad.key('arrowup', true);
  ad.key('arrowup', false);
  assert.equal(sent[0].readUInt32LE(12) & 4, 4, 'arrow down: EXTENDEDKEY');
  assert.equal(sent[1].readUInt32LE(12), 2 | 4, 'arrow up: KEYUP|EXTENDEDKEY');
  sent.length = 0;
  ad.key('a', true);
  assert.equal(sent[0].readUInt32LE(12) & 4, 0, 'буквы без EXTENDEDKEY');
});

test('dispatch: неподдерживаемая адаптером клавиша — честный key-unsupported, не ok:true', () => {
  const calls = [];
  // 'a' проходит allowlist протокола, но мок-адаптер её не поддерживает —
  // dispatch обязан вернуть честный отказ, а не {ok:true}
  const adapter = { available: true, platform: 'test', key() { calls.push('key'); return false; } };
  const ni = createNativeInput({ adapter });
  const res = ni.dispatch({ type: 'key', key: 'a', down: true }, { width: 100, height: 100 });
  assert.deepEqual(res, { ok: false, reason: 'key-unsupported' });
  assert.deepEqual(calls, ['key'], 'адаптер опрошен');
});

test('dispatch move: originX/originY не-основного дисплея прибавляются', () => {
  const moved = [];
  const adapter = { available: true, platform: 'test', move(x, y) { moved.push([x, y]); } };
  const ni = createNativeInput({ adapter });
  ni.dispatch({ type: 'move', x: 0.5, y: 0.5 }, { width: 1000, height: 800, originX: 1920, originY: -200 });
  assert.deepEqual(moved, [[1920 + 500, -200 + 400]]);
});

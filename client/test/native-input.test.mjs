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

// Честный мок user32 для win-адаптера: GetSystemMetrics по индексам Win32
// (76..79 = SM_X/Y/CX/CYVIRTUALSCREEN), SetCursorPos отдельно от SendInput,
// GetWindowRect отдаёт данными из out-структуры. Без этого мок моделировал
// вырожденный стол 0×0 и ронял Buffer.from на числах (ревью 28.09).
function winUser32Mock({ sent = [], virtualScreen = { x: 0, y: 0, w: 1920, h: 1080 }, windowRect = null, setCursor = [] } = {}) {
  return {
    struct() {},
    load() {
      return {
        func(sig) {
          if (/GetSystemMetrics/.test(sig)) {
            return (idx) => ({ 76: virtualScreen.x, 77: virtualScreen.y, 78: virtualScreen.w, 79: virtualScreen.h }[idx] ?? 0);
          }
          if (/SetCursorPos/.test(sig)) {
            return (x, y) => { setCursor.push([x, y]); return true; };
          }
          if (/GetWindowRect/.test(sig)) {
            return (_hwnd, rect) => {
              if (!windowRect) return 0;
              rect.left = windowRect.x; rect.top = windowRect.y;
              rect.right = windowRect.x + windowRect.w; rect.bottom = windowRect.y + windowRect.h;
              return 1;
            };
          }
          return (count, buf) => { sent.push(Buffer.from(buf)); return count; };
        },
      };
    },
  };
}

function buildWinAdapter(fakeKoffi) {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return loadPlatformAdapter(fakeKoffi);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
}

test('winAdapter: SendInput-буферы с правильными x64-смещениями (dwFlags@20, KEYEVENTF_KEYUP@12)', () => {
  const sent = [];
  const fakeKoffi = winUser32Mock({ sent });
  const ad = buildWinAdapter(fakeKoffi);
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

test('winAdapter: кнопка после move — пакет [абсолютный move][кнопка] (NC-кнопки заголовка)', () => {
  // дефект №10: NC-кнопки («свернуть»/«закрыть») взводятся WM_MOUSEMOVE —
  // «голый» down/up после SetCursorPos окном игнорируется; фикс шлёт оба события
  // одним SendInput-пакетом (ревью 28.09: класс смещений INPUT уже ловили живьём).
  const sent = [];
  const setCursor = [];
  const fakeKoffi = winUser32Mock({ sent, setCursor, virtualScreen: { x: 0, y: 0, w: 1920, h: 1080 } });
  const ad = buildWinAdapter(fakeKoffi);
  ad.move(960, 540);
  assert.deepEqual(setCursor[0], [960, 540], 'move идёт SetCursorPos');
  ad.button('left', true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 80, 'пакет из двух INPUT');
  // первый INPUT — абсолютный move
  assert.equal(sent[0].readUInt32LE(0), 0, 'INPUT_MOUSE');
  assert.equal(sent[0].readUInt32LE(20), 0xc001, 'MOVE|ABSOLUTE|VIRTUALDESK@20');
  assert.equal(sent[0].readUInt32LE(8), Math.round((960 * 65535) / 1919), 'dx нормирован на виртуальный стол');
  assert.equal(sent[0].readUInt32LE(12), Math.round((540 * 65535) / 1079), 'dy нормирован');
  // второй INPUT (база 40) — кнопка
  assert.equal(sent[0].readUInt32LE(40), 0, 'второй INPUT_MOUSE');
  assert.equal(sent[0].readUInt32LE(60), 2, 'dwFlags кнопки @40+20=60');
  ad.button('left', false);
  assert.equal(sent[1].readUInt32LE(60), 4, 'LEFTUP@60');
});

test('winAdapter: кнопка с отрицательным виртуальным столом нормируется от его origin', () => {
  const sent = [];
  const fakeKoffi = winUser32Mock({ sent, virtualScreen: { x: -1920, y: 0, w: 3840, h: 1080 } });
  const ad = buildWinAdapter(fakeKoffi);
  ad.move(0, 540); // левый монитор с отрицательным origin
  ad.button('left', true);
  assert.equal(sent[0].readUInt32LE(8), Math.round(((0 - (-1920)) * 65535) / 3839), 'dx = (x - vsX) * 65535 / (vsW-1)');
  assert.equal(sent[0].readUInt32LE(12), Math.round((540 * 65535) / 1079), 'dy');
});

test('winAdapter: координаты клика приоритетнее lastX/lastY — пакет [abs-move][кнопка] в точку цели (№18)', () => {
  // Регресс ретеста 28–29.09: кнопка несёт координаты КЛИКА, а не полагается на
  // lastX/lastY от последнего move — потерянный/протроттленный move больше не
  // телепортирует курсор по устаревшей позиции («клик уезжал на крестик окна»).
  const sent = [];
  const fakeKoffi = winUser32Mock({ sent, virtualScreen: { x: 0, y: 0, w: 1920, h: 1080 } });
  const ad = buildWinAdapter(fakeKoffi);
  ad.move(960, 540); // stale-позиция (как после потери move в drag'е)
  ad.button('left', true, [100, 200]); // клик по другой точке
  assert.equal(sent[0].readUInt32LE(8), Math.round((100 * 65535) / 1919), 'dx из координат клика, не из lastX');
  assert.equal(sent[0].readUInt32LE(12), Math.round((200 * 65535) / 1079), 'dy из координат клика, не из lastY');
  // lastX/lastY обновились от координат клика: следующая кнопка без at — в ту же точку
  sent.length = 0;
  ad.button('left', false);
  assert.equal(sent[0].readUInt32LE(8), Math.round((100 * 65535) / 1919), 'up без координат — в позицию клика');
});

test('диспетчер: кнопка с координатами конвертирует их в пиксели и передаёт адаптеру', () => {
  const calls = [];
  const adapter = {
    available: true, platform: 'test',
    move() {},
    button(btn, down, at) { calls.push(['button', btn, down, at]); },
    key() {}, scroll() {},
  };
  const ni = createNativeInput({ adapter });
  ni.dispatch({ type: 'button', button: 'left', down: true, x: 0.5, y: 0.25 }, { width: 1000, height: 800, originX: 40, originY: 20 });
  assert.deepEqual(calls[0], ['button', 'left', true, [540, 220]], 'пиксели = x*w+originX / y*h+originY');
  calls.length = 0;
  ni.dispatch({ type: 'button', button: 'left', down: false }, { width: 1000, height: 800 });
  assert.deepEqual(calls[0], ['button', 'left', false, null], 'без координат — at=null (фолбэк lastX/lastY)');
});

test('winAdapter: windowRect по HWND — данные, фильтры вырожденных и минимизированных окон', () => {
  const fakeKoffi = winUser32Mock({ windowRect: { x: 100, y: 50, w: 800, h: 600 } });
  const ad = buildWinAdapter(fakeKoffi);
  assert.deepEqual(ad.windowRect(774), { x: 100, y: 50, w: 800, h: 600 }, 'прямоугольник из GetWindowRect');

  const minimized = buildWinAdapter(winUser32Mock({ windowRect: { x: -32000, y: -32000, w: 160, h: 28 } }));
  assert.equal(minimized.windowRect(1), null, 'минимизированное окно Win32 (-32000) отфильтровано');

  const zero = buildWinAdapter(winUser32Mock({ windowRect: { x: 10, y: 10, w: 0, h: 0 } }));
  assert.equal(zero.windowRect(1), null, 'нулевые размеры отфильтрованы');

  const failed = buildWinAdapter(winUser32Mock({ windowRect: null }));
  assert.equal(failed.windowRect(1), null, 'неуспешный GetWindowRect → null (откат на дисплей)');
});

const vkExpect = { '-': 0xbd, '=': 0xbb, '.': 0xbe, ',': 0xbc, '/': 0xbf, ';': 0xba, "'": 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0 };
test('winAdapter: пунктуация протокола инжектится через VK_OEM, honest false вне карты', () => {
  const sent = [];
  const fakeKoffi = winUser32Mock({ sent });
  const ad = buildWinAdapter(fakeKoffi);
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

// ---- mac/x11 адаптеры (ревью v0.4.6): раньше не покрывались ничем — откат
// №18-at-координат и новых фиксов (флаги мыши, XFlush) проходил весь сюит.

function buildMacAdapter(fakeKoffi) {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try { return loadPlatformAdapter(fakeKoffi); }
  finally { Object.defineProperty(process, 'platform', { value: realPlatform }); }
}

function macCgMock({ created = [], flags = [], posted = [] } = {}) {
  return {
    load() {
      let handle = 1;
      return {
        func(sig) {
          if (/CGEventCreateMouseEvent/.test(sig)) {
            return (_a, type, x, y, btn) => { const ev = { h: handle++, kind: 'mouse', type, x, y, btn }; created.push(ev); return ev; };
          }
          if (/CGEventCreateKeyboardEvent/.test(sig)) {
            return (_a, code, down) => { const ev = { h: handle++, kind: 'key', code, down }; created.push(ev); return ev; };
          }
          if (/CGEventCreateScrollWheelEvent/.test(sig)) {
            return (_a, units, count, val) => { const ev = { h: handle++, kind: 'scroll', val }; created.push(ev); return ev; };
          }
          if (/CGEventSetFlags/.test(sig)) return (ev, f) => { flags.push([ev.h, f]); };
          if (/CGEventPost/.test(sig)) return (_t, ev) => { posted.push(ev); };
          if (/CFRelease/.test(sig)) return () => {};
          throw new Error('unexpected CG sig: ' + sig);
        },
      };
    },
  };
}

test('macAdapter: клик идёт в координаты цели (at, №18) и несёт флаги модификаторов', () => {
  const created = []; const flags = []; const posted = [];
  const ad = buildMacAdapter(macCgMock({ created, flags, posted }));
  assert.equal(ad.platform, 'macos-coregraphics', 'mac-адаптер собрался на моке');

  ad.move(960, 540);
  ad.button('left', true, [100, 200]);
  const mice = created.filter((e) => e.kind === 'mouse');
  assert.deepEqual([mice[0].x, mice[0].y], [960, 540]);
  assert.deepEqual([mice[1].x, mice[1].y], [100, 200], 'клик — в точку цели, не по lastPx (№18)');
  // ревью v0.4.6: каждое mouse-событие сопровождается CGEventSetFlags
  assert.equal(flags.length, mice.length, 'CGEventSetFlags на каждом mouse-событии');

  // shift зажат → следующий клик уходит с kCGEventFlagMaskShift (0x020000):
  // раньше mouse-события уходили с flags=0 и shift-клик терялся
  ad.key('shift', true);
  ad.button('right', true, null);
  assert.equal(flags.at(-1)[1], 0x020000, 'shift-клик несёт флаг модификатора');
  assert.ok(posted.length >= 4, 'все события отправлены');
});

function buildX11Adapter(fakeKoffi) {
  const realPlatform = process.platform;
  // wayland-зонд читает реальный process.env: на машине разработчика с
  // WAYLAND_DISPLAY/сеансом wayland адаптер честно вернёт linux-wayland и тест
  // упадёт без всякой регрессии — изолируем env (ревью v0.4.6 доводка)
  const saved = {
    platform: realPlatform,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
  };
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.XDG_SESSION_TYPE;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try { return loadPlatformAdapter(fakeKoffi); }
  finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    if (saved.WAYLAND_DISPLAY !== undefined) process.env.WAYLAND_DISPLAY = saved.WAYLAND_DISPLAY;
    if (saved.XDG_SESSION_TYPE !== undefined) process.env.XDG_SESSION_TYPE = saved.XDG_SESSION_TYPE;
  }
}

function x11Mock(state) {
  return {
    load(libPath) {
      if (/libX11/.test(libPath)) {
        return {
          func(sig) {
            if (/XOpenDisplay/.test(sig)) return () => 0x1000;
            if (/XCloseDisplay/.test(sig)) return () => 1;
            if (/XFlush/.test(sig)) return () => { state.flushes += 1; return 1; };
            if (/XStringToKeysym/.test(sig)) return () => 0xffe1;
            if (/XKeysymToKeycode/.test(sig)) return () => 50;
            throw new Error('unexpected X11 sig: ' + sig);
          },
        };
      }
      return {
        func(sig) {
          if (/XTestFakeMotionEvent/.test(sig)) return (_d, _s, x, y) => { state.motions.push([x, y]); return 1; };
          if (/XTestFakeButtonEvent/.test(sig)) return (_d, b, press) => { state.buttons.push([b, press]); return 1; };
          if (/XTestFakeKeyEvent/.test(sig)) return (_d, kc, press) => { state.keys.push([kc, press]); return 1; };
          throw new Error('unexpected Xtst sig: ' + sig);
        },
      };
    },
  };
}

test('x11Adapter: координаты цели (at, №18) и XFlush после каждой операции', () => {
  const state = { motions: [], buttons: [], keys: [], flushes: 0 };
  const ad = buildX11Adapter(x11Mock(state));
  assert.equal(ad.platform, 'linux-x11', 'x11-адаптер собрался на моке (wayland-зонд мимо)');

  ad.move(10, 20);
  assert.deepEqual(state.motions.at(-1), [10, 20]);
  const afterMove = state.flushes;
  assert.ok(afterMove >= 1, 'move флашит буфер Xlib — без XFlush ввод доезжал пачками (ревью v0.4.6)');

  ad.button('left', true, [300, 400]);
  assert.deepEqual(state.motions.at(-1), [300, 400], 'перед кнопкой — движение в точку цели (№18)');
  assert.deepEqual(state.buttons.at(-1), [1, 1], 'левая кнопка нажата');
  assert.ok(state.flushes > afterMove, 'button флашит');

  assert.equal(ad.key('a', true), true, 'буква резолвится в keycode');
  assert.deepEqual(state.keys.at(-1), [50, 1]);
});

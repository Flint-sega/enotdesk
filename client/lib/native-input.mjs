// Нативный ввод: доверенная граница. Валидация (protocol.mjs) обязательна до адаптера.
// Адаптеры через koffi (Windows SendInput / macOS CoreGraphics / Linux X11 XTest) подключаются
// лениво; при отсутствии koffi или недоступности API — инертный адаптер и честный статус.
// Wayland диагностируется как unsupported-control, не выдаётся за поддержку.

import { validateInputEvent } from './protocol.mjs';

// Инертный адаптер: ничего не делает, честно сообщает о недоступности.
export function inertAdapter() {
  return { available: false, platform: 'inert', reason: 'native-unavailable' };
}

export function waylandAdapterProbe(env = process.env) {
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) {
    return { available: false, platform: 'linux-wayland', reason: 'wayland-unsupported-control' };
  }
  return null;
}

// Попытка загрузить koffi и собрать адаптер текущей ОС. Любая неудача — инертный режим.
export function loadPlatformAdapter(koffi) {
  if (!koffi) return inertAdapter();
  const wayland = waylandAdapterProbe();
  if (wayland) return wayland;
  try {
    if (process.platform === 'darwin') return macAdapter(koffi);
    if (process.platform === 'win32') return winAdapter(koffi);
    if (process.platform === 'linux') return x11Adapter(koffi);
  } catch {
    // библиотеки ОС могут отсутствовать — честный отказ вместо падения
  }
  return inertAdapter();
}

// macOS CoreGraphics: события мыши/клавиатуры в глобальных пикселях.
function macAdapter(koffi) {
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const CGEventCreateMouseEvent = cg.func('void *CGEventCreateMouseEvent(void *, int, double, double, int)');
  const CGEventCreateKeyboardEvent = cg.func('void *CGEventCreateKeyboardEvent(void *, unsigned short, bool)');
  const CGEventSetFlags = cg.func('void CGEventSetFlags(void *, unsigned long)');
  const CGEventPost = cg.func('void CGEventPost(int, void *)');
  const CFRelease = cg.func('void CFRelease(void *)');
  const CGEventCreateScrollWheelEvent = cg.func('void *CGEventCreateScrollWheelEvent(void *, int, int, int, int)');
  const post = (ev) => { try { CGEventPost(0, ev); } finally { CFRelease(ev); } };
  const held = new Set();
  const lastPx = [0, 0]; // объявлен до использования, обновляется в move()
  const flags = () => {
    let f = 0;
    if (held.has('shift')) f |= 0x020000;
    if (held.has('control')) f |= 0x040000;
    if (held.has('alt')) f |= 0x080000;
    if (held.has('meta')) f |= 0x100000;
    return f;
  };
  // kCGEvent types: mouseMoved=5, leftDown/Up=1/2, rightDown/Up=3/4, other(middle)Down/Up=25/26
  const MOUSE_EVENT = { left: [1, 2], right: [3, 4], middle: [25, 26] };
  const MOUSE_BUTTON = { left: 0, right: 1, middle: 2 };
  const MAC_KEY = {
    a: 0x00, b: 0x0b, c: 0x08, d: 0x02, e: 0x0e, f: 0x03, g: 0x05, h: 0x04,
    i: 0x22, j: 0x26, k: 0x28, l: 0x25, m: 0x2e, n: 0x2d, o: 0x1f, p: 0x23,
    q: 0x0c, r: 0x0f, s: 0x01, t: 0x11, u: 0x20, v: 0x09, w: 0x0d, x: 0x07,
    y: 0x10, z: 0x06, '0': 0x1d, '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15,
    '5': 0x17, '6': 0x16, '7': 0x1a, '8': 0x1c, '9': 0x19,
    space: 0x31, enter: 0x24, tab: 0x30, escape: 0x35, backspace: 0x33, delete: 0x75,
    arrowup: 0x7e, arrowdown: 0x7d, arrowleft: 0x7b, arrowright: 0x7c,
    home: 0x73, end: 0x77, pageup: 0x74, pagedown: 0x79,
    shift: 0x38, control: 0x3b, alt: 0x3a, meta: 0x37,
    '-': 0x1b, '=': 0x18, '.': 0x2f, ',': 0x2b, '/': 0x2c, ';': 0x29, "'": 0x27,
    '[': 0x21, ']': 0x1e, '\\': 0x2a, '`': 0x32,
  };
  return {
    available: true,
    platform: 'macos-coregraphics',
    accessibilityNote: 'требуется разрешение «Универсальный доступ»',
    move(pxX, pxY) {
      lastPx[0] = pxX;
      lastPx[1] = pxY;
      post(CGEventCreateMouseEvent(null, 5, pxX, pxY, MOUSE_BUTTON.left));
    },
    button(btn, down) {
      const type = MOUSE_EVENT[btn]?.[down ? 0 : 1];
      if (type === undefined) return false;
      post(CGEventCreateMouseEvent(null, type, lastPx[0], lastPx[1], MOUSE_BUTTON[btn]));
      return true;
    },
    key(k, down) {
      const code = MAC_KEY[k];
      if (code === undefined) return false;
      if (down) held.add(k); else held.delete(k);
      const ev = CGEventCreateKeyboardEvent(null, code, down);
      CGEventSetFlags(ev, flags());
      post(ev);
      return true;
    },
    scroll(dx, dy) {
      if (dx) post(CGEventCreateScrollWheelEvent(null, 0, 1, 1, -Math.round(dx)));
      if (dy) post(CGEventCreateScrollWheelEvent(null, 0, 1, 1, -Math.round(dy)));
    },
  };
}

// Windows SendInput через koffi.
function winAdapter(koffi) {
  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('unsigned int SendInput(int, void *, int)', { stdcall: true });
  const SetCursorPos = user32.func('bool SetCursorPos(int, int)', { stdcall: true });
  const VK = { shift: 0x10, control: 0x11, alt: 0x12, meta: 0x5b, enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, space: 0x20, delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, arrowup: 0x26, arrowdown: 0x28, arrowleft: 0x25, arrowright: 0x27 };
  const VK_LETTERS = 0x41; // 'A'..'Z'
  const VK_NUMS = 0x30; // '0'..'9'
  const vkFor = (k) => {
    if (k.length === 1 && k >= 'a' && k <= 'z') return VK_LETTERS + (k.charCodeAt(0) - 97);
    if (k.length === 1 && k >= '0' && k <= '9') return VK_NUMS + Number(k);
    return VK[k];
  };
  const keyInput = (vk, down) => {
    const buf = Buffer.alloc(40); // INPUT {type, MOUSEINPUT-or-KEYBDINPUT...}
    buf.writeUInt32LE(1, 0); // INPUT_KEYBOARD
    buf.writeUInt16LE(vk, 8); // wVk
    buf.writeUInt32LE(down ? 0 : 2, 16); // KEYEVENTF_KEYUP
    return buf;
  };
  const mouseFlag = (btn, down) => {
    const map = { left: [2, 4], right: [8, 16], middle: [32, 64] };
    return map[btn][down ? 0 : 1];
  };
  const mouseInput = (flag) => {
    const buf = Buffer.alloc(40);
    buf.writeUInt32LE(0, 0); // INPUT_MOUSE
    buf.writeUInt32LE(flag, 8); // dwFlags
    return buf;
  };
  return {
    available: true,
    platform: 'windows-sendinput',
    move(pxX, pxY) { SetCursorPos(Math.round(pxX), Math.round(pxY)); },
    button(btn, down) { SendInput(1, mouseInput(mouseFlag(btn, down)), 40); },
    key(k, down) {
      const vk = vkFor(k);
      if (vk === undefined) return false;
      SendInput(1, keyInput(vk, down), 40);
      return true;
    },
    scroll(dx, dy) {
      if (dy) { const buf = Buffer.alloc(40); buf.writeUInt32LE(0, 0); buf.writeInt32LE(-Math.round(dy) * 120, 16); buf.writeUInt32LE(0x0800, 20); SendInput(1, buf, 40); }
      if (dx) { const buf = Buffer.alloc(40); buf.writeUInt32LE(0, 0); buf.writeInt32LE(Math.round(dx) * 120, 16); buf.writeUInt32LE(0x1000, 20); SendInput(1, buf, 40); }
    },
  };
}

// Linux X11 через XTest (libX11/libXtst), только X11 — Wayland отсеян раньше.
function x11Adapter(koffi) {
  const x11 = koffi.load('libX11.so.6');
  const xtst = koffi.load('libXtst.so.6');
  const XOpenDisplay = x11.func('void *XOpenDisplay(const char *)');
  const XCloseDisplay = x11.func('int XCloseDisplay(void *)');
  const XStringToKeysym = x11.func('unsigned long XStringToKeysym(const char *)');
  const XKeysymToKeycode = x11.func('int XKeysymToKeycode(void *, unsigned long)');
  const XTestFakeButtonEvent = xtst.func('int XTestFakeButtonEvent(void *, unsigned int, int, unsigned long)');
  const XTestFakeKeyEvent = xtst.func('int XTestFakeKeyEvent(void *, unsigned int, int, unsigned long)');
  const XTestFakeMotionEvent = xtst.func('int XTestFakeMotionEvent(void *, int, int, int, unsigned long)');
  const dpy = XOpenDisplay(null);
  if (!dpy) return { available: false, platform: 'linux-x11', reason: 'x11-display-unavailable' };
  const KEYSYM = { space: 'space', enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down', shift: 'Shift_L', control: 'Control_L', alt: 'Alt_L', meta: 'Super_L' };
  const BTN = { left: 1, middle: 2, right: 3 };
  return {
    available: true,
    platform: 'linux-x11',
    move(pxX, pxY) { XTestFakeMotionEvent(dpy, -1, Math.round(pxX), Math.round(pxY), 0); },
    button(btn, down) { XTestFakeButtonEvent(dpy, BTN[btn], down ? 1 : 0, 0); },
    key(k, down) {
      const name = k.length === 1 ? k : KEYSYM[k];
      if (!name) return false;
      const kc = XKeysymToKeycode(dpy, XStringToKeysym(name));
      if (!kc) return false;
      XTestFakeKeyEvent(dpy, kc, down ? 1 : 0, 0);
      return true;
    },
    scroll(dx, dy) {
      if (dy) { XTestFakeButtonEvent(dpy, dy > 0 ? 5 : 4, 1, 0); XTestFakeButtonEvent(dpy, dy > 0 ? 5 : 4, 0, 0); }
      if (dx) { XTestFakeButtonEvent(dpy, dx > 0 ? 7 : 6, 1, 0); XTestFakeButtonEvent(dpy, dx > 0 ? 7 : 6, 0, 0); }
    },
    close() { XCloseDisplay(dpy); },
  };
}

export function createNativeInput({ adapter, koffi = null, getAdapter = null, maxPerWindow = 300, windowMs = 1000 } = {}) {
  // Адаптер (и загрузка koffi вместе с ним) резолвится лениво: status() её не форсирует,
  // первый реальный ввод или load() на старте host-сеанса — форсируют.
  let ad = adapter ?? null;
  const resolveAdapter = () => (ad ??= getAdapter ? getAdapter() : loadPlatformAdapter(koffi));
  const held = new Set(); // кнопки
  const heldKeys = new Set();
  let count = 0;
  let windowStart = 0;

  function throttled() {
    const now = Date.now();
    if (now > windowStart + windowMs) { windowStart = now; count = 0; }
    count += 1;
    return count > maxPerWindow;
  }

  return {
    // Явная подготовка нативного ввода (старт host-сеанса); status() её не выполняет.
    load: resolveAdapter,
    status: () => {
      if (!ad) {
        // Честно: не проверено — не заявляем ни доступность, ни недоступность
        return { available: false, platform: 'unknown', reason: 'native-not-checked', note: null, checked: false };
      }
      return {
        available: !!ad.available,
        platform: ad.platform ?? 'unknown',
        reason: ad.reason ?? null,
        note: ad.accessibilityNote ?? null,
        checked: true,
      };
    },
    // bounds: {width,height} в физических пикселях выбранного дисплея; x/y нормализованы 0..1
    dispatch(ev, bounds) {
      const v = validateInputEvent(ev);
      if (!v.ok) return { ok: false, reason: `invalid:${v.reason}` };
      resolveAdapter();
      if (!ad.available) return { ok: false, reason: 'native-unavailable' };
      if (throttled()) return { ok: false, reason: 'throttled' };
      switch (ev.type) {
        case 'move': {
          const px = Math.round(ev.x * (bounds?.width ?? 0));
          const py = Math.round(ev.y * (bounds?.height ?? 0));
          ad.move(px, py);
          return { ok: true };
        }
        case 'button':
          if (ev.down) held.add(ev.button); else held.delete(ev.button);
          ad.button(ev.button, ev.down);
          return { ok: true };
        case 'key':
          if (ev.down) heldKeys.add(ev.key); else heldKeys.delete(ev.key);
          ad.key(ev.key, ev.down);
          return { ok: true };
        case 'scroll':
          ad.scroll(ev.dx, ev.dy);
          return { ok: true };
        default:
          return { ok: false, reason: 'invalid:type' };
      }
    },
    // Завершение сеанса: отпустить всё зажатое, даже без парных up.
    end() {
      if (!ad) return; // нечего отпускать и незачем грузить модуль
      for (const b of [...held]) { try { ad.button(b, false); } catch { /* адаптер мог отвалиться */ } }
      for (const k of [...heldKeys]) { try { ad.key(k, false); } catch { /* см. выше */ } }
      held.clear();
      heldKeys.clear();
    },
  };
}

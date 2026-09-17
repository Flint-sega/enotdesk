// Источник ввода браузерного оператора (spec §браузерный оператор, interfaces.md):
// DOM pointer/wheel/keyboard-события над <video> → события desktop-протокола.
// Трансляция клавиш и колеса — те же чистые модули, что у desktop (keymap, protocol):
// события на проводе идентичны desktop-протоколу, allowlist один на проект.
// Решение о вводе остаётся на принимающей стороне (input-pipeline в main хоста).

import { keyFromCode } from '../client/lib/keymap.mjs';
import { wheelToLines } from '../client/lib/protocol.mjs';

const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
const MOVE_THROTTLE_MS = 25; // как в desktop: не чаще ~40 событий/с

// wireBrowserInput(video, send, {keys, onUnsupported?, throttleMs?}) → {detach()}.
// send — куда уходят события (DataChannel); keys — Set допустимых клавиш протокола;
// неподдерживаемое сообщается через onUnsupported(key) — честная ошибка вместо молчания.
export function wireBrowserInput(video, send, { keys, onUnsupported, throttleMs = MOVE_THROTTLE_MS } = {}) {
  let lastMove = 0;
  const prevented = (e) => { if (typeof e?.preventDefault === 'function') e.preventDefault(); };
  const norm = (e) => {
    const r = video.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  const raw = (obj) => {
    try { send(obj); } catch { /* канал закрывается — ввод прекращается */ }
  };

  const onMove = (e) => {
    const now = Date.now();
    if (now - lastMove < throttleMs) return;
    lastMove = now;
    const { x, y } = norm(e);
    raw({ type: 'move', x, y });
  };
  const buttonName = (e) => BUTTONS[e.button] ?? null;
  const onDown = (e) => {
    const btn = buttonName(e);
    if (!btn) return;
    prevented(e);
    const { x, y } = norm(e); // клик там, где курсор, даже если движение ещё не посылалось
    raw({ type: 'move', x, y });
    raw({ type: 'button', button: btn, down: true });
  };
  const onUp = (e) => {
    const btn = buttonName(e);
    if (!btn) return;
    const { x, y } = norm(e);
    raw({ type: 'move', x, y });
    raw({ type: 'button', button: btn, down: false });
  };
  const onContext = (e) => prevented(e);
  const onWheel = (e) => {
    prevented(e);
    const dx = wheelToLines(e.deltaX);
    const dy = wheelToLines(e.deltaY);
    if (dx || dy) raw({ type: 'scroll', dx, dy });
  };
  const keyOf = (e) => {
    const key = keyFromCode(e.code, e.key);
    if (!key || !(keys instanceof Set) || !keys.has(key)) {
      onUnsupported?.(e.key ?? e.code ?? '');
      return null;
    }
    return key;
  };
  const onKeyDown = (e) => {
    const key = keyOf(e);
    if (!key) return;
    prevented(e);
    raw({ type: 'key', key, down: true });
  };
  const onKeyUp = (e) => {
    const key = keyOf(e);
    if (!key) return;
    prevented(e);
    raw({ type: 'key', key, down: false });
  };

  const bindings = [
    ['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp],
    ['contextmenu', onContext], ['wheel', onWheel], ['keydown', onKeyDown], ['keyup', onKeyUp],
  ];
  for (const [type, fn] of bindings) video.addEventListener(type, fn);
  return { detach: () => { for (const [type, fn] of bindings) video.removeEventListener(type, fn); } };
}

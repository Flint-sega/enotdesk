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
    overVideo = true; // движение над видео — самый надёжный сигнал присутствия
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
    // Захват указателя: отпускание за краем видео всё равно придёт сюда —
    // иначе кнопка на хосте залипает до конца сеанса (ревью GLM-5.3 #3, confirmed)
    try { video.setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
    const { x, y } = norm(e); // клик там, где курсор, даже если движение ещё не посылалось
    raw({ type: 'move', x, y });
    // №18: координаты при кнопке — хост собирает пакет [абс-move][кнопка] в точку
    // цели, а не по lastX/lastY от последнего move (клик «уезжал»)
    raw({ type: 'button', button: btn, down: true, x, y });
  };
  const onUp = (e) => {
    const btn = buttonName(e);
    if (!btn) return;
    const { x, y } = norm(e);
    raw({ type: 'move', x, y });
    raw({ type: 'button', button: btn, down: false, x, y });
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
  // Клавиатура: <video> не фокусируем, keydown на нём не бывает — слушаем
  // document и шлём только когда курсор оператора над экраном сеанса
  // (иначе печать в собственный чат оператора дублировалась бы в сеанс).
  // Поля ввода оператора (чат/терминал) не перехватываем никогда —
  // иначе текст (и пароли) печатались бы на удалённой машине (ревью #3, confirmed).
  // Для зажатых клавиш up доливается даже при уходе курсора — ничего не залипает.
  let overVideo = false;
  const sentKeys = new Set();
  const isOperatorField = (e) => {
    const t = e.target;
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
  };
  const onKeyDown = (e) => {
    if (!overVideo || isOperatorField(e)) return;
    const key = keyOf(e);
    if (!key) return;
    prevented(e);
    sentKeys.add(key);
    raw({ type: 'key', key, down: true });
  };
  const onKeyUp = (e) => {
    const key = keyOf(e);
    if (!key) return;
    // долив up для зажатой клавиши важен даже вне видео — иначе залипает
    if (!overVideo && !sentKeys.has(key)) return;
    if (overVideo) prevented(e);
    sentKeys.delete(key);
    raw({ type: 'key', key, down: false });
  };
  const onEnter = () => { overVideo = true; };
  const onLeave = () => { overVideo = false; };

  const bindings = [
    ['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp],
    ['contextmenu', onContext], ['wheel', onWheel], ['pointerenter', onEnter], ['pointerleave', onLeave],
  ];
  for (const [type, fn] of bindings) video.addEventListener(type, fn);
  const docBindings = [['keydown', onKeyDown], ['keyup', onKeyUp]];
  for (const [type, fn] of docBindings) document.addEventListener(type, fn);
  return {
    detach: () => {
      for (const [type, fn] of bindings) video.removeEventListener(type, fn);
      for (const [type, fn] of docBindings) document.removeEventListener(type, fn);
    },
  };
}

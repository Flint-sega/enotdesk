// Источник ввода браузерного оператора (spec §браузерный оператор, interfaces.md):
// DOM pointer/wheel/keyboard-события над <video> → события desktop-протокола.
// Трансляция клавиш и колеса — те же чистые модули, что у desktop (keymap, protocol):
// события на проводе идентичны desktop-протоколу, allowlist один на проект.
// Решение о вводе остаётся на принимающей стороне (input-pipeline в main хоста).

import { keyFromCode } from '../client/lib/keymap.mjs';
import { wheelToLines } from '../client/lib/protocol.mjs';

const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
const MOVE_THROTTLE_MS = 25; // как в desktop: не чаще ~40 событий/с

// wireBrowserInput(video, send, {keys, onUnsupported?, throttleMs?, onVideoPointerDown?, onKeyboardRoute?}) → {detach()}.
// send — куда уходят события (DataChannel); keys — Set допустимых клавиш протокола;
// неподдерживаемое сообщается через onUnsupported(key) — честная ошибка вместо молчания.
// onVideoPointerDown — клик по видео (после preventDefault): страница оператора
// снимает фокус со своих полей, иначе клавиши молча остаются в чате панели
// (живой случай приёмки 02.10: мышь ок, клавиши не печатают).
// onKeyboardRoute('remote'|'local') — куда сейчас идут клавиши: для индикатора
// в статус-баре, чтобы ввод не терялся молча.
export function wireBrowserInput(video, send, { keys, onUnsupported, throttleMs = MOVE_THROTTLE_MS, onVideoPointerDown, onKeyboardRoute } = {}) {
  let lastMove = 0;
  const prevented = (e) => { if (typeof e?.preventDefault === 'function') e.preventDefault(); };
  // Координаты — по КАДРУ видео, не по CSS-боксу: бокс жёстко 16:9 с
  // object-fit contain/cover, при аспекте источника ≠16:9 буквица/кроп
  // смещали бы каждый клик (ревью v0.4.6, medium; паритет desktop-оператору).
  const norm = (e) => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) {
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
    }
    const scale = video.classList.contains('fit-cover')
      ? Math.max(r.width / vw, r.height / vh)
      : Math.min(r.width / vw, r.height / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left - ox) / dw)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top - oy) / dh)),
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
  // Зажатые кнопки по pointerId: pointercancel (тач-жест перехвачен браузером)
  // не приносит pointerup — без трекинга кнопка залипала бы на хосте до конца
  // сеанса (ревью v0.4.6, medium)
  const downByPointer = new Map();
  const release = (btn, e) => {
    if (!btn) return;
    const { x, y } = norm(e);
    raw({ type: 'move', x, y });
    raw({ type: 'button', button: btn, down: false, x, y });
  };
  const onDown = (e) => {
    const btn = buttonName(e);
    if (!btn) return;
    prevented(e);
    onVideoPointerDown?.();
    // Захват указателя: отпускание за краем видео всё равно придёт сюда —
    // иначе кнопка на хосте залипает до конца сеанса (ревью GLM-5.3 #3, confirmed)
    try { video.setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
    downByPointer.set(e.pointerId, btn);
    const { x, y } = norm(e); // клик там, где курсор, даже если движение ещё не посылалось
    raw({ type: 'move', x, y });
    // №18: координаты при кнопке — хост собирает пакет [абс-move][кнопка] в точку
    // цели, а не по lastX/lastY от последнего move (клик «уезжал»)
    raw({ type: 'button', button: btn, down: true, x, y });
  };
  const onUp = (e) => {
    // явная кнопка из pointerup сильнее трекинга (спека: button = отпущенная);
    // трекинг — fallback для нестандартных up без button
    const btn = buttonName(e) ?? downByPointer.get(e.pointerId);
    downByPointer.delete(e.pointerId);
    release(btn, e);
  };
  const onCancel = (e) => {
    const btn = downByPointer.get(e.pointerId);
    downByPointer.delete(e.pointerId);
    release(btn, e);
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
    if (!overVideo || isOperatorField(e)) {
      // ввод молча оставался в панели — оператор не видел, куда идут клавиши;
      // индикатор делает маршрут видимым (приёмка 02.10: «в чате пишу, в блокноте нет»)
      onKeyboardRoute?.('local');
      return;
    }
    const key = keyOf(e);
    if (!key) return;
    onKeyboardRoute?.('remote');
    prevented(e);
    sentKeys.add(key);
    raw({ type: 'key', key, down: true });
  };
  const onKeyUp = (e) => {
    const key = keyOf(e);
    if (!key) return;
    // долив up для зажатой клавиши важен даже вне видео — ничего не залипает
    if (!overVideo && !sentKeys.has(key)) return;
    if (overVideo) prevented(e);
    sentKeys.delete(key);
    raw({ type: 'key', key, down: false });
  };
  const onEnter = () => { overVideo = true; };
  const onLeave = () => { overVideo = false; };

  const bindings = [
    ['pointermove', onMove], ['pointerdown', onDown], ['pointerup', onUp],
    ['pointercancel', onCancel],
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

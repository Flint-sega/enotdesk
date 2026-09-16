// Ввод оператора: ограниченный протокол, частота ограничена, координаты 0..1.
// Клавиши маппятся по физическому коду (e.code) — раскладка (RU/EN) не важна;
// allowlist — единый источник в main (protocol.mjs), приходит через permissions().

import { $, text } from './dom.js';
import { keyFromCode } from '../lib/keymap.mjs';
import { wheelToLines } from '../lib/protocol.mjs';

export const enot = window.enot;

let allowedKeys = null;
function ensureKeys() {
  allowedKeys ??= enot.permissions().then((p) => new Set(p.inputKeys ?? [])).catch(() => new Set());
  return allowedKeys;
}

let keyErrorReset = null;
function showKeyError(key) {
  // неподдерживаемая клавиша честно отклоняется с видимой ошибкой, не молча
  text($('remote-status'), `Клавиша «${key}» не поддерживается`);
  clearTimeout(keyErrorReset);
  keyErrorReset = setTimeout(() => text($('remote-status'), 'Подключено'), 2000);
}

export function wireOperatorInput(dc) {
  const video = $('remote-video');
  video.tabIndex = 0;
  let lastMove = 0;
  const send = (obj) => {
    if (dc.readyState !== 'open') return;
    try { dc.send(JSON.stringify(obj)); } catch { /* канал закрывается — ввод прекращается */ }
  };
  const norm = (e) => {
    const r = video.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  video.onmousemove = (e) => {
    const now = Date.now();
    if (now - lastMove < 25) return; // не чаще ~40 событий/с
    lastMove = now;
    const { x, y } = norm(e);
    send({ type: 'move', x, y });
  };
  video.onmousedown = (e) => {
    const btnName = { 0: 'left', 1: 'middle', 2: 'right' }[e.button];
    if (btnName) {
      e.preventDefault();
      const { x, y } = norm(e); // клик там, где курсор, даже если движение ещё не посылалось
      send({ type: 'move', x, y });
      send({ type: 'button', button: btnName, down: true });
    }
  };
  video.onmouseup = (e) => {
    const btnName = { 0: 'left', 1: 'middle', 2: 'right' }[e.button];
    if (btnName) {
      const { x, y } = norm(e);
      send({ type: 'move', x, y });
      send({ type: 'button', button: btnName, down: false });
    }
  };
  video.oncontextmenu = (e) => e.preventDefault();
  video.onwheel = (e) => {
    e.preventDefault();
    const dx = wheelToLines(e.deltaX);
    const dy = wheelToLines(e.deltaY);
    if (dx || dy) send({ type: 'scroll', dx, dy });
  };
  video.onkeydown = async (e) => {
    const key = keyFromCode(e.code, e.key);
    if (!key) { showKeyError(e.key); return; }
    e.preventDefault();
    const allowed = await ensureKeys();
    if (!allowed.has(key)) { showKeyError(e.key); return; }
    send({ type: 'key', key, down: true });
  };
  video.onkeyup = async (e) => {
    const key = keyFromCode(e.code, e.key);
    if (!key) return;
    e.preventDefault();
    const allowed = await ensureKeys();
    if (!allowed.has(key)) return; // keydown уже отклонён с ошибкой; up молчать нечему
    send({ type: 'key', key, down: false });
  };
}

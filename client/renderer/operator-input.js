// Ввод оператора: ограниченный протокол, частота ограничена, координаты 0..1.
// Клавиши маппятся по физическому коду (e.code) — раскладка (RU/EN) не важна;
// allowlist — единый источник в main (protocol.mjs), приходит через permissions().

import { $, text } from './dom.js';
import { t } from '../lib/i18n.mjs';
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
  text($('remote-status'), t('op.keyUnsupported', { key }));
  clearTimeout(keyErrorReset);
  keyErrorReset = setTimeout(() => text($('remote-status'), t('status.connected')), 2000);
}

export function wireOperatorInput(dc) {
  const video = $('remote-video');
  video.tabIndex = 0;
  let lastMove = 0;
  const send = (obj) => {
    if (dc.readyState !== 'open') return;
    try { dc.send(JSON.stringify(obj)); } catch { /* канал закрывается — ввод прекращается */ }
  };
  // Координаты — по КАДРУ видео, а не по CSS-боксу: бокс жёстко 16:9 с
  // object-fit contain/cover, и при аспекте источника ≠16:9 (ноутбуки 16:10,
  // MacBook) буквица/кроп смещали бы каждый клик на проценты ширины
  // (ревью v0.4.6, medium). Пока кадр не известен (videoWidth=0) — фолбэк на бокс.
  const norm = (e) => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) {
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
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
  // pointer-события, а не mouse: только у PointerEvent есть pointerId, без
  // которого setPointerCapture бросает NotFoundError и отпускание кнопки за
  // краем видео не доходит до хоста — кнопка залипает (ревью v0.4.6, high;
  // mousedown-версия захвата не ставила никогда, подтверждено живым репро).
  // Pointercancel (тач-жест планшета перехвачен браузером) обязан отпустить
  // кнопку — pointerup после него не приходит.
  const downButtons = new Map(); // pointerId → имя кнопки, ушедшей down:true
  const btnName = (e) => ({ 0: 'left', 1: 'middle', 2: 'right' }[e.button]);
  const release = (btn, e) => {
    if (!btn) return;
    const { x, y } = norm(e);
    send({ type: 'move', x, y });
    send({ type: 'button', button: btn, down: false, x, y });
  };
  const onMove = (e) => {
    const now = Date.now();
    if (now - lastMove < 25) return; // не чаще ~40 событий/с
    lastMove = now;
    const { x, y } = norm(e);
    send({ type: 'move', x, y });
  };
  const onDown = (e) => {
    const btn = btnName(e);
    if (!btn) return;
    e.preventDefault();
    // Захват указателя: отпускание за краем видео всё равно придёт сюда —
    // иначе кнопка на хосте залипает до конца сеанса (симметрично web-источнику)
    try { video.setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
    downButtons.set(e.pointerId, btn);
    const { x, y } = norm(e); // клик там, где курсор, даже если движение ещё не посылалось
    send({ type: 'move', x, y });
    // №18: координаты при кнопке — пакет [абс-move][кнопка] на хосте идёт в точку цели
    send({ type: 'button', button: btn, down: true, x, y });
  };
  const onUp = (e) => {
    // явная кнопка из pointerup сильнее трекинга (спека: button = отпущенная);
    // трекинг — fallback для нестандартных up без button
    const btn = btnName(e) ?? downButtons.get(e.pointerId);
    downButtons.delete(e.pointerId);
    release(btn, e);
  };
  // Жест отменён браузером (скролл/свайп): pointerup не будет — отпускаем
  // всё, что этот источник зажал, координатами отмены
  const onCancel = (e) => {
    const btn = downButtons.get(e.pointerId);
    downButtons.delete(e.pointerId);
    release(btn, e);
  };
  video.addEventListener('pointermove', onMove);
  video.addEventListener('pointerdown', onDown);
  video.addEventListener('pointerup', onUp);
  video.addEventListener('pointercancel', onCancel);
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

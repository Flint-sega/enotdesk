
// Публичный шов: валидация ограниченного JSON-протокола (interfaces.md, frozen).
// main-процесс — авторитетная проверка; используется и в тестах без Electron.

// Единственный источник истины по допустимым клавишам: его читает main
// (валидация и выдача рендереру через permissions()), рендерер не дублирует.
export const INPUT_KEYS = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'space', 'enter', 'tab', 'escape', 'backspace', 'delete',
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'home', 'end', 'pageup', 'pagedown',
  'shift', 'control', 'alt', 'meta', '-', '=', '.', ',', '/', ';', "'", '[', ']', '\\', '`',
]);
const KEYS = INPUT_KEYS;

const BUTTONS = new Set(['left', 'right', 'middle']);
const SCROLL_LIMIT = 1000;
const SDP_MAX = 64 * 1024;

function isFinite01(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function validateInputEvent(ev) {
  if (!ev || typeof ev !== 'object') return { ok: false, reason: 'shape' };
  switch (ev.type) {
    case 'move':
      if (!isFinite01(ev.x) || !isFinite01(ev.y)) return { ok: false, reason: 'bounds' };
      return { ok: true };
    case 'button':
      if (!BUTTONS.has(ev.button) || typeof ev.down !== 'boolean') return { ok: false, reason: 'enum' };
      return { ok: true };
    case 'key': {
      if (typeof ev.key !== 'string' || typeof ev.down !== 'boolean') return { ok: false, reason: 'enum' };
      if (!KEYS.has(ev.key.toLowerCase())) return { ok: false, reason: 'key-not-allowed' };
      return { ok: true };
    }
    case 'scroll': {
      const { dx, dy } = ev;
      const b = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= SCROLL_LIMIT;
      if (!b(dx) || !b(dy)) return { ok: false, reason: 'bounds' };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'type-not-allowed' };
  }
}

// Исходящие в /signal сигналы нашего клиента: только offer/answer-описание или ICE-кандидат.
export function validateOutgoingSignal(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'shape' };
  if (msg.type !== 'signal' || !msg.data || typeof msg.data !== 'object') return { ok: false, reason: 'shape' };
  const d = msg.data;
  if (d.description) {
    const { type, sdp } = d.description;
    if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string' || sdp.length > SDP_MAX) {
      return { ok: false, reason: 'description' };
    }
    return { ok: true };
  }
  if (d.candidate) {
    const c = d.candidate;
    if (typeof c.candidate !== 'string' || c.candidate.length > 4096) return { ok: false, reason: 'candidate' };
    return { ok: true };
  }
  return { ok: false, reason: 'shape' };
}

// Ворота нативного ввода: решение принимает main по реальному состоянию WS.
// Открыты только для host после настоящего {type:'approved'} и до ended/close.
export function createInputGate() {
  let role = null;
  let approved = false;
  let open = false;
  let resetNeeded = false;

  const apply = (value) => {
    if (open && !value) resetNeeded = true; // открыт->закрыт: нужно отпустить зажатое
    open = value;
  };

  return {
    onSignal(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'ready':
          role = msg.role || null;
          approved = false;
          apply(false);
          break;
        case 'approved':
          if (role === 'host') approved = true;
          apply(role === 'host');
          break;
        case 'ended':
        case 'error':
          approved = false;
          apply(false);
          break;
        default:
          break;
      }
    },
    isOpen: () => open && approved && role === 'host',
    needInputReset: () => {
      const v = resetNeeded;
      resetNeeded = false;
      return v;
    },
    close() {
      approved = false;
      apply(false);
    },
  };
}

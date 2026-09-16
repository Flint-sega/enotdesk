// Маппинг физической клавиши (KeyboardEvent.code) в ключ протокола ввода
// (protocol.mjs INPUT_KEYS). Код физической клавиши не зависит от раскладки:
// на русской раскладке «ф» — это KeyA, и оператор передаёт 'a'.
// Неизвестный код → null: рендерер честно показывает «клавиша не поддерживается».

const NAMED = {
  Space: 'space', Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Escape: 'escape',
  Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  ShiftLeft: 'shift', ShiftRight: 'shift', ControlLeft: 'control', ControlRight: 'control',
  AltLeft: 'alt', AltRight: 'alt', MetaLeft: 'meta', MetaRight: 'meta',
  Minus: '-', Equal: '=', Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
  NumpadAdd: '=', NumpadSubtract: '-', NumpadDecimal: '.', NumpadDivide: '/',
};

// Запасной путь для платформ без e.code: старая логика по e.key (только латиница).
const LEGACY_KEY = {
  ' ': 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace',
  Delete: 'delete', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
  Shift: 'shift', Control: 'control', Alt: 'alt', Meta: 'meta',
};

export function keyFromCode(code, key = '') {
  if (typeof code === 'string' && code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
    if (code in NAMED) return NAMED[code];
    return null;
  }
  if (typeof key === 'string') {
    if (/^[a-z0-9]$/.test(key)) return key;
    return LEGACY_KEY[key] ?? null;
  }
  return null;
}

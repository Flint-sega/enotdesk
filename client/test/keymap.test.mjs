import test from 'node:test';
import assert from 'node:assert/strict';
import { keyFromCode } from '../lib/keymap.mjs';
import { validateInputEvent } from '../lib/protocol.mjs';

// Клавиатура маппится по физическому коду (e.code): раскладка (RU/EN/DE)
// не влияет на передаваемый ключ протокола. Ожидания — из стандартной карты
// KeyboardEvent.code (W3C), не из кода под тестом.

test('буквы и цифры: KeyA..KeyZ → a..z, Digit0..9 → 0..9', () => {
  assert.equal(keyFromCode('KeyA', 'ф'), 'a'); // русская раскладка: «ф» на клавише A
  assert.equal(keyFromCode('KeyZ', 'я'), 'z');
  assert.equal(keyFromCode('KeyM', 'ь'), 'm');
  for (let i = 0; i <= 9; i++) assert.equal(keyFromCode(`Digit${i}`, String(i)), String(i));
  for (let i = 0; i <= 9; i++) assert.equal(keyFromCode(`Numpad${i}`, String(i)), String(i));
});

test('именованные клавиши: модификаторы с обеих сторон, навигация, знаки', () => {
  assert.equal(keyFromCode('Space', ' '), 'space');
  assert.equal(keyFromCode('Enter', 'Enter'), 'enter');
  assert.equal(keyFromCode('NumpadEnter', 'Enter'), 'enter');
  assert.equal(keyFromCode('ShiftLeft', 'Shift'), 'shift');
  assert.equal(keyFromCode('ShiftRight', 'Shift'), 'shift');
  assert.equal(keyFromCode('ControlRight', 'Control'), 'control');
  assert.equal(keyFromCode('MetaLeft', 'Meta'), 'meta');
  assert.equal(keyFromCode('ArrowUp', 'ArrowUp'), 'arrowup');
  assert.equal(keyFromCode('PageDown', 'PageDown'), 'pagedown');
  assert.equal(keyFromCode('Backquote', 'ё'), '`'); // «ё» на русской раскладке — физический `
  assert.equal(keyFromCode('Minus', '-'), '-');
  assert.equal(keyFromCode('Slash', ','), '/'); // знак на клавише не важен — важен код
});

test('неизвестные коды → null: F-клавиши и прочее честно не поддерживаются', () => {
  assert.equal(keyFromCode('F12', 'F12'), null);
  assert.equal(keyFromCode('CapsLock', 'CapsLock'), null);
  assert.equal(keyFromCode('MediaPlay', ''), null);
  assert.equal(keyFromCode(undefined, ''), null);
});

test('запасной путь без e.code: латиница и именованные клавиши по e.key', () => {
  assert.equal(keyFromCode('', 'a'), 'a');
  assert.equal(keyFromCode('', 'Enter'), 'enter');
  assert.equal(keyFromCode('', 'ArrowLeft'), 'arrowleft');
  // кириллица без физического кода не определяется — честный null, не угадывание
  assert.equal(keyFromCode('', 'ф'), null);
});

test('каждый результат keyFromCode проходит allowlist протокола', () => {
  const codes = ['KeyA', 'KeyZ', 'Digit5', 'Space', 'Enter', 'Tab', 'Escape', 'Backspace',
    'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp',
    'PageDown', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'MetaLeft', 'Minus', 'Equal', 'Period',
    'Comma', 'Slash', 'Semicolon', 'Quote', 'BracketLeft', 'BracketRight', 'Backslash', 'Backquote'];
  for (const code of codes) {
    const key = keyFromCode(code, '?');
    assert.ok(key, `код ${code} должен маппиться`);
    assert.equal(validateInputEvent({ type: 'key', key, down: true }).ok, true, `${code} → ${key}`);
  }
});

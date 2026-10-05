// Контракт упаковки (лаба 05.10): electronLanguages обязан содержать полные теги.
// История: electronLanguages [ru, en] — «en» не матчится ни с одним pak
// (нужен en-US), на Windows с любой не-ru локалью у клиента не оставалось ни
// одного языкового пака; ResourceBundle пуст, а рендерер падал Access Violation
// (0xC0000005) при создании <input type=file>/<details>/<video> — им нужны
// локализованные строки Chromium (кнопка «Browse», маркер details, медиа-панель).
// Симптом: пустое тёмное окно клиента, «locale resources are not loaded» в логе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const yml = readFileSync(fileURLToPath(new URL('../../build/electron-builder.yml', import.meta.url)), 'utf8');

function electronLanguages(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === 'electronLanguages:');
  if (start === -1) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^ {2}- /.test(l)) items.push(l.replace(/^ {2}- /, '').trim());
    else if (l.trim() === '' || l.trim().startsWith('#')) continue;
    else break;
  }
  return items.length ? items : null;
}

test('packaging: electronLanguages задан', () => {
  const langs = electronLanguages(yml);
  assert.ok(langs, 'в electron-builder.yml нет секции electronLanguages');
  assert.ok(langs.length >= 2, 'ожидаем минимум ru и en-US');
});

test('packaging: только полные теги локалей (ru, en-US), без голого en', () => {
  const langs = electronLanguages(yml);
  assert.ok(langs.includes('ru'), 'должен быть ru');
  assert.ok(langs.includes('en-US'), 'должен быть en-US (полный тег: голый «en» не матчится ни с одним pak)');
  assert.ok(!langs.includes('en'), 'голый «en» запрещён: pak называется en-US.pak, «en» молча выпадает из сборки');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../lib/csv.mjs';

test('ячейка CSV: спецсимволы экранируются по RFC 4180, пустые значения — пустая строка', () => {
  assert.equal(csvCell('просто текст'), 'просто текст');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('сказал "привет"'), '"сказал ""привет"""');
  assert.equal(csvCell('строка1\nстрока2'), '"строка1\nстрока2"');
  // нейтрализация формул Excel: = + - @ в начале получают префикс-апостроф
  assert.equal(csvCell('=cmd'), "'=cmd");
  assert.equal(csvCell('+7'), "'+7");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@risk'), "'@risk");
  assert.equal(csvCell('\t=cmd'), "'\t=cmd", 'таб в начале тоже префикс формулы (SEC-009)');
  // CR после апострофа попадает под RFC-кавычки — ячейка целиком в кавычках
  assert.equal(csvCell('\r=cmd'), '"\'\r=cmd"', 'CR в начале тоже префикс формулы (SEC-009)');
  assert.equal(csvCell('a-b'), 'a-b', 'дефис не в начале не трогается');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(42), '42');
});

test('toCsv: разделитель «;», CRLF-строки, BOM в начале, кириллица не ломается', () => {
  const csv = toCsv(['Сеанс', 'Причина'], [['123', 'host-lost'], ['456', 'с denying; кавычки "x"']]);
  assert.ok(csv.startsWith('\uFEFF'), 'BOM для Excel');
  const body = csv.slice(1);
  assert.equal(body, 'Сеанс;Причина\r\n123;host-lost\r\n456;"с denying; кавычки ""x"""');
});

test('toCsv: без строк — только заголовок', () => {
  assert.equal(toCsv(['a', 'b'], []), '\uFEFFa;b');
});

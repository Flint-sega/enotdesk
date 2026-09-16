import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../lib/csv.mjs';

test('ячейка CSV: спецсимволы экранируются по RFC 4180, пустые значения — пустая строка', () => {
  assert.equal(csvCell('просто текст'), 'просто текст');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('сказал "привет"'), '"сказал ""привет"""');
  assert.equal(csvCell('строка1\nстрока2'), '"строка1\nстрока2"');
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

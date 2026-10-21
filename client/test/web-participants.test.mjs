import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ru from '../locales/ru.mjs';
import en from '../locales/en.mjs';

// ADR 0035: список участников сеанса в программе оператора — разметка, живые
// обработчики, тексты только из словарей, сброс между сеансами.
const web = path.join(import.meta.dirname, '..', '..', 'web');
const html = readFileSync(path.join(web, 'operator.html'), 'utf8');
const js = readFileSync(path.join(web, 'operator.mjs'), 'utf8');

test('участники: блок скрыт до сообщения хоста, есть список и «только смотреть»', () => {
  assert.match(html, /<div class="card hidden" id="op-participants">/);
  assert.match(html, /id="op-participants-list"/);
  assert.match(html, /<input type="checkbox" id="op-observe">/);
});

test('участники: сообщение хоста рисует список, кнопки и галочка шлют служебные сообщения', () => {
  assert.match(js, /msg\.type === 'participants'\) renderParticipants\(msg\)/);
  assert.match(js, /sendControl\(\{ type: 'pass-input', to: id \}\)/, 'кнопка «Передать» живая');
  assert.match(js, /sendControl\(\{ type: 'view-only', on: e\.target\.checked === true \}\)/, 'галочка живая');
  assert.match(js, /resetParticipants\(\); \/\/ и список участников/, 'список не переживает сеанс');
  assert.match(js, /iControl && p\.id !== msg\.you && !p\.viewOnly/, 'передать может только активный и не наблюдателю');
  assert.match(js, /\.textContent = /, 'имена — textContent, не innerHTML');
  assert.doesNotMatch(js.slice(js.indexOf('function renderParticipants'), js.indexOf('function resetParticipants')), /innerHTML/);
});

test('участники: ключи словарей есть в ru и en', () => {
  const keys = [...new Set([...js.matchAll(/'(op\.participants\.[a-zA-Z]+)'/g), ...html.matchAll(/data-i18n="(op\.participants\.[a-zA-Z]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 8, `ключей ${keys.length}`);
  for (const k of keys) assert.ok(k in ru && k in en, `нет ключа ${k}`);
});

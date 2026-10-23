// Проход доступности 23.10 (ACCEPTANCE-1.0, план 1.16: axe + только клавиатура):
// найденное и исправленное держится контрактом на уровне разметки и кода.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('клиент помощи: кнопки «Помощь» и «Оператор» с именем и тогда, когда подпись скрыта (узкое окно)', () => {
  const html = read('client/renderer/index.html');
  assert.match(html, /<button id="tab-client"[^>]*data-i18n-aria-label="app\.tabHelp"/);
  assert.match(html, /<button id="tab-operator"[^>]*data-i18n-aria-label="app\.tabOperator"/);
});

test('клиент помощи: будущие шаги не приглушают текст прозрачностью (контраст ≥4.5)', () => {
  const css = read('client/renderer/styles.css');
  assert.doesNotMatch(css, /:is\(\.step-2, \.step-3\) \{ opacity/, 'прозрачность на весь шаг снова роняет контраст подписей до 2,4');
});

test('клиент помощи: запрос оператора берёт фокус на заголовок, но не на «Разрешить»', () => {
  const html = read('client/renderer/index.html');
  assert.match(html, /<h2 tabindex="-1" data-i18n="client\.consentTitle">/);
  const js = read('client/renderer/views/client-view.js');
  assert.match(js, /section === 'consent'\) \$\('client-consent'\)\?\.querySelector\('h2'\)\?\.focus\(\)/);
  assert.doesNotMatch(js, /btn-allow'\)\??\.focus\(/, 'фокус на «Разрешить» — случайный Enter выдал бы доступ');
});

test('клиент помощи: окна настроек и первого запуска модальные — inert фона, Escape, возврат фокуса', () => {
  const js = read('client/renderer/settings.js');
  assert.match(js, /setAttribute\('inert', ''\)/);
  assert.match(js, /e\.key !== 'Escape'/);
  assert.match(js, /overlayReturnFocus/);
  assert.doesNotMatch(js, /(show|hide)\(\$\('(settings|firstrun)-overlay'\)\)/, 'окна открываются и закрываются только через openOverlay/closeOverlay');
});

test('серверные страницы: кнопка «Скачать» в шапке с aria-label (на телефоне подпись скрыта)', () => {
  const pages = read('server/pages.mjs');
  assert.match(pages, /<a class="btn" href="\/downloads#download" aria-label="\$\{esc\(t\('server\.download'/);
});

test('консоль хаба: строки обращений доступны с клавиатуры, подпись статуса прячется только визуально', () => {
  const js = read('hub/web/app.mjs');
  assert.match(js, /row\.tabIndex = 0/);
  assert.match(js, /\$\('hub-list'\)\.addEventListener\('keydown'/);
  assert.match(js, /aria-current/);
  const html = read('hub/web/index.html');
  assert.doesNotMatch(html, /#hub-presence-box label\{display:none\}/, 'display:none убирает имя у списка статуса');
});

test('виджет: у страницы есть ориентир main', () => {
  const html = read('hub/widget/w.html');
  assert.match(html, /<main id="w-root"/);
  assert.match(html, /<\/main>/);
});

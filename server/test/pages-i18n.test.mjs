import test from 'node:test';
import assert from 'node:assert/strict';

// Шов серверных страниц (история 9): /downloads и /invite читают общий словарь,
// язык страницы задаётся вызывающим (app.mjs — по Accept-Language).

import { page, downloadsHtml, inviteHtml } from '../pages.mjs';
import { pickLocale } from '../../client/lib/i18n.mjs';

function fakeRes() {
  return {
    headers: null, body: '',
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end(payload) { this.body = payload ?? ''; },
  };
}

test('downloadsHtml и inviteHtml переводятся: ru и en из одного словаря', () => {
  const ru = downloadsHtml([], '1.0.0', 'ru');
  assert.match(ru, /Скачать для вашей системы/);
  assert.match(ru, /Как это работает/);
  const en = downloadsHtml([], '1.0.0', 'en');
  assert.match(en, /Download for your system/);
  assert.match(en, /How it works/);
  assert.doesNotMatch(en, /[\u0400-\u04FF]/, 'английская страница не должна содержать кириллицу');

  assert.match(inviteHtml('1.0.0', 'ru'), /Приглашение в команду EnotDesk/);
  assert.match(inviteHtml('1.0.0', 'en'), /Invitation to the EnotDesk team/);
});

test('page() ставит lang по локали и честный utf-8 — кириллица не ломает вёрстку', () => {
  const res = fakeRes();
  page(res, 'T', '<p>Проверка — кириллица</p>', 'ru');
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(res.body, /<html lang="ru">/);
  assert.match(res.body, /Проверка — кириллица/);
  const resEn = fakeRes();
  page(resEn, 'T', '<p>ok</p>', 'en');
  assert.match(resEn.body, /<html lang="en">/);
});

test('platformCard-подобный вывод: файл сборки подписан локализованным «Скачать»', () => {
  const items = [{ platform: 'darwin', name: 'EnotDesk-mac.zip', size: 104857600, arch: 'arm64', url: '/downloads-files/x' }];
  assert.match(downloadsHtml(items, '1', 'ru'), /Скачать/);
  assert.match(downloadsHtml(items, '1', 'en'), />Download</);
  assert.match(downloadsHtml(items, '1', 'ru'), /100 МБ/);
  assert.match(downloadsHtml(items, '1', 'en'), /100 MB/);
});

test('pickLocale: сервер выбирает ru/en из Accept-Language, без заголовка — ru', () => {
  assert.equal(pickLocale('ru-RU,ru;q=0.9,en;q=0.8'), 'ru');
  assert.equal(pickLocale('en-US,en;q=0.9'), 'en');
  assert.equal(pickLocale('de-DE'), 'ru');
  assert.equal(pickLocale(undefined), 'ru');
});

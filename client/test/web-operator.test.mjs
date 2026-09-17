import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Шов 3 (interfaces.md): контракт рендерера расширяется на браузерного оператора.
// web/operator.html обязан держать все id, которые ищет web/*.mjs; разметка —
// только через data-i18n*; словари — те же ru/en; кнопки не мёртвые; в JS-модулях
// страницы нет кириллических литералов (тексты только из словаря).

const webDir = path.join(import.meta.dirname, '..', '..', 'web');
const html = readFileSync(path.join(webDir, 'operator.html'), 'utf8');
const operatorJs = readFileSync(path.join(webDir, 'operator.mjs'), 'utf8');
const inputJs = readFileSync(path.join(webDir, 'input-source.mjs'), 'utf8');
const allJs = `${operatorJs}\n${inputJs}`;

import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };

test('web/operator.html: каждый data-i18n* ключ есть в словарях ru и en', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20, 'статические строки страницы должны быть помечены data-i18n');
  for (const key of new Set(keys)) {
    assert.ok(key in ru, `ключ «${key}» отсутствует в ru.json`);
    assert.ok(key in en, `ключ «${key}» отсутствует в en.json`);
  }
});

test('web/*.mjs: ключи t(\'…\') существуют в обоих словарях', () => {
  for (const m of allJs.matchAll(/\bt\('([^']+)'/g)) {
    const key = m[1];
    assert.ok(key in ru, `t('${key}') в web: ключа нет в ru.json`);
    assert.ok(key in en, `t('${key}') в web: ключа нет в en.json`);
  }
});

test('web/operator.html: все id из JS страницы присутствуют в разметке', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...allJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 15, 'JS страницы должен работать через $(id)');
  for (const id of new Set(referenced)) {
    assert.ok(htmlIds.has(id), `id «${id}» отсутствует в web/operator.html`);
  }
});

test('web/operator.html: анти-мёртвые-кнопки — каждая кнопка подключена в JS', () => {
  const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 9, 'на странице оператора есть живая панель кнопок');
  for (const id of buttons) {
    assert.ok(allJs.includes(`'${id}'`), `кнопка «${id}» есть в HTML, но не подключена в web/*.mjs`);
  }
});

test('web/*.mjs: кириллических строк-литералов нет — только словарь (как в renderer)', () => {
  const literalRe = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
  const cyrRe = /[\u0400-\u04FF]/;
  for (const lit of allJs.match(literalRe) ?? []) {
    assert.ok(!cyrRe.test(lit), `кириллический литерал в web: ${lit.slice(0, 60)}`);
  }
});

test('web/operator.html: без inline-стилей и inline-скриптов (CSP script-src self)', () => {
  assert.ok(!/\sstyle="/.test(html), 'найден inline style');
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1, 'подключается один модуль страницы');
  assert.match(scripts[0], /type="module" src="\/web\/operator\.mjs"/);
});

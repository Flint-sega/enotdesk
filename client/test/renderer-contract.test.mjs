import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Шов UI: index.html обязан сохранять все id, которые ищет JS рендерера (во всех
// модулях), без inline-стилей/скриптов (CSP); каждая кнопка HTML должна быть
// подключена в JS; getSettings — отдавать фактическую версию.

const dir = path.join(import.meta.dirname, '..', 'renderer');

function listJs(dirPath) {
  const out = [];
  for (const name of readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    if (statSync(full).isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
const jsFiles = listJs(dir);
const allJs = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const mainJs = readFileSync(path.join(import.meta.dirname, '..', 'main.mjs'), 'utf8');

test('все id, которые ищет JS рендерера, есть в index.html', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...allJs.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map((m) => m[1] ?? m[2]);
  const states = ['idle', 'registering', 'waiting', 'consent', 'connected', 'ended', 'error'];
  const panes = ['connect', 'contacts', 'team', 'history', 'audit'];
  const views = ['client', 'operator']; // switchView: $('view-' + role) в тернарнике, regex его не ловит
  const dynamic = [
    ...states.map((s) => `client-${s}`),
    ...panes.map((p) => `pane-${p}`),
    ...views.map((v) => `view-${v}`),
    'op-chat-log', 'client-chat-log', // appendChat: $(logId) через переменную
  ];
  for (const id of new Set([...referenced, ...dynamic])) {
    assert.ok(htmlIds.has(id), `id «${id}» отсутствует в index.html`);
  }
});

test('анти-мёртвые-кнопки: каждая кнопка из HTML подключена в JS через $(id)', () => {
  const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(buttons.length > 20, 'список кнопок не должен быть пуст');
  for (const id of buttons) {
    const wired = new RegExp(`\\$\\('${id}'\\)|getElementById\\('${id}'\\)`).test(allJs);
    assert.ok(wired, `кнопка «${id}» есть в HTML, но нигде не подключена в JS`);
  }
});

test('CSP: стили только styles.css, без inline-стилей и inline-скриптов', () => {
  assert.ok(!/\sstyle="/.test(html), 'найден inline style');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'найден inline script');
  assert.match(html, /<link rel="stylesheet" href="styles.css">/);
});

test('getSettings отдаёт фактическую версию, футер её показывает', () => {
  assert.match(mainJs, /createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\)/);
  assert.match(mainJs, /version:\s*app\.isPackaged\s*\?\s*app\.getVersion\(\)\s*:\s*pkg\.version/);
  assert.match(html, /id="app-footer"/);
  assert.match(html, /id="app-version"/);
  assert.match(allJs, /if \(s\.version\)/);
});

// ---- i18n (таск 02): словари, data-i18n, отсутствие строк-литералов в UI ----

import ru from '../locales/ru.json' with { type: 'json' };
import en from '../locales/en.json' with { type: 'json' };

const serverPages = readFileSync(path.join(import.meta.dirname, '..', '..', 'server', 'pages.mjs'), 'utf8');
const uiSources = jsFiles.map((f) => [f, readFileSync(f, 'utf8')]);
uiSources.push(['server/pages.mjs', serverPages]);

test('каждый data-i18n* ключ из index.html есть в словарях ru и en', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50, 'статические строки HTML должны быть помечены data-i18n');
  for (const key of new Set(keys)) {
    assert.ok(key in ru, `ключ «${key}» из index.html отсутствует в ru.json`);
    assert.ok(key in en, `ключ «${key}» из index.html отсутствует в en.json`);
  }
});

test('эвристика: в UI-модулях и серверных страницах нет кириллических строк-литералов', () => {
  // Ищем кириллицу только внутри строковых литералов — комментарии на русском разрешены.
  const literalRe = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
  const cyrRe = /[\u0400-\u04FF]/;
  const exceptions = new Set([]); // оправданные литералы, пофайлово: 'путь:литерал'
  for (const [name, src] of uiSources) {
    for (const lit of src.match(literalRe) ?? []) {
      if (cyrRe.test(lit)) {
        assert.ok(exceptions.has(`${name}:${lit}`), `кириллический литерал в ${name}: ${lit.slice(0, 60)}`);
      }
    }
  }
});

test('ключи t(\'…\') из кода UI существуют в обоих словарях', () => {
  for (const [name, src] of uiSources) {
    for (const m of src.matchAll(/\bt\('([^']+)'/g)) {
      const key = m[1];
      assert.ok(key in ru, `t('${key}') в ${name}: ключа нет в ru.json`);
      assert.ok(key in en, `t('${key}') в ${name}: ключа нет в en.json`);
    }
  }
});

test('причины завершения сеанса переведены для всех известных кодов', () => {
  const reasons = ['ended', 'denied', 'host-lost', 'operator-lost', 'lease-expired', 'server-restart', 'signal-lost', 'rtc'];
  for (const r of reasons) {
    assert.ok(`end.${r}` in ru, `ключ end.${r} отсутствует в ru.json`);
    assert.ok(`end.${r}` in en, `ключ end.${r} отсутствует в en.json`);
  }
});

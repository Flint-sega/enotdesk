import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Шов UI: index.html обязан сохранять все id, которые ищет app.js, без inline-
// стилей/скриптов (CSP), а getSettings — отдавать фактическую версию.

const dir = path.join(import.meta.dirname, '..', 'renderer');
const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
const appJs = readFileSync(path.join(dir, 'app.js'), 'utf8');
const mainJs = readFileSync(path.join(import.meta.dirname, '..', 'main.mjs'), 'utf8');

test('все id, которые ищет app.js, есть в index.html', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...appJs.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map((m) => m[1] ?? m[2]);
  const states = ['idle', 'registering', 'waiting', 'consent', 'connected', 'ended', 'error'];
  const panes = ['connect', 'contacts', 'team', 'history', 'audit'];
  const views = ['client', 'operator']; // switchView: $('view-' + role) в тернарнике, regex его не ловит
  const dynamic = [
    ...states.map((s) => `client-${s}`),
    ...panes.map((p) => `pane-${p}`),
    ...views.map((v) => `view-${v}`),
  ];
  for (const id of new Set([...referenced, ...dynamic])) {
    assert.ok(htmlIds.has(id), `id «${id}» отсутствует в index.html`);
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
  assert.match(appJs, /if \(s\.version\)/);
});

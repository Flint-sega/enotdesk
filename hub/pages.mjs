import fs from 'node:fs';
import { esc } from '../server/pages.mjs';

// Страницы хаба: каркас консоли /hub/ (T02 достроит инбокс) и заглушки /w, /join.
// Шаблоны читаются один раз, подстановки экранируются esc().

let consoleCache = null;

// state: 'login' | 'console' | 'forbidden' — выбирает сервер, аутентификация
// остаётся на сервере (рендереру не доверять).
export function consoleHtml(state, locale, version) {
  if (!consoleCache) {
    consoleCache = fs.readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
  }
  return consoleCache
    .replace('__TITLE__', esc('EnotDesk Hub'))
    .replace('__VERSION__', esc(version))
    .replace('__LOCALE__', esc(locale))
    .replace('__STATE__', esc(state));
}

// Страница-заглушка (не маркетинговый shell server/pages.mjs).
export function stubHtml(title, body, locale) {
  return `<!doctype html>
<html lang="${esc(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>:root{color-scheme:dark;--bg:#070D17;--panel:#0F1A2C;--line:#1C2C44;--text:#EAF2FF;--muted:#8FA3BF;--accent:#35E0C4}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:30px;max-width:520px;margin:24px;text-align:center}
h1{margin:0 0 10px;font-size:26px}.lead{color:var(--muted);margin:0}</style>
</head>
<body><main class="card"><h1>${esc(title)}</h1><p class="lead">${esc(body)}</p></main></body>
</html>
`;
}

// Страница виджета (iframe /w, T03): шаблон один, подставляется только локаль —
// остальное (state) у страницы нет, гость идентифицируется visitor-cookie.
let widgetCache = null;
export function widgetHtml(locale) {
  if (!widgetCache) {
    widgetCache = fs.readFileSync(new URL('./widget/w.html', import.meta.url), 'utf8');
  }
  return widgetCache.replace('__LOCALE__', esc(locale));
}

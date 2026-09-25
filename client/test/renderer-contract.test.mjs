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
  // Словари i18n — ES-модули (SEC-005): грузятся через script-src 'self', fetch не
  // нужен — connect-src file: в CSP быть не должно (исторически его отсутствие
  // при JSON-словарях убивало весь граф модулей, SMOKE 03). Проверяем сам атрибут
  // content мета-тега, а не весь HTML: в поясняющем комментарии слов быть не должно.
  const csp = /<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? '';
  assert.match(csp, /connect-src 'self';/, 'в CSP нет connect-src');
  assert.ok(!/connect-src[^;]*file:/.test(csp), 'connect-src не должен содержать file: (словари — ES-модули)');
});

test('getSettings отдаёт фактическую версию, футер её показывает', () => {
  assert.match(mainJs, /createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\)/);
  assert.match(mainJs, /version:\s*app\.isPackaged\s*\?\s*app\.getVersion\(\)\s*:\s*pkg\.version/);
  assert.match(html, /id="app-footer"/);
  assert.match(html, /id="app-version"/);
  assert.match(allJs, /if \(s\.version\)/);
});

// ---- i18n (таск 02): словари, data-i18n, отсутствие строк-литералов в UI ----

import ru from '../locales/ru.mjs';
import en from '../locales/en.mjs';

const serverPages = readFileSync(path.join(import.meta.dirname, '..', '..', 'server', 'pages.mjs'), 'utf8');
const uiSources = jsFiles.map((f) => [f, readFileSync(f, 'utf8')]);
uiSources.push(['server/pages.mjs', serverPages]);

test('каждый data-i18n* ключ из index.html есть в словарях ru и en', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50, 'статические строки HTML должны быть помечены data-i18n');
  for (const key of new Set(keys)) {
    assert.ok(key in ru, `ключ «${key}» из index.html отсутствует в словаре ru`);
    assert.ok(key in en, `ключ «${key}» из index.html отсутствует в словаре en`);
  }
});

test('эвристика: кириллица в index.html только под data-i18n* — текст-ноды и атрибуты', () => {
  const cyrRe = /[\u0400-\u04FF]/;
  // Атрибуты: у переводимого атрибута обязана быть своя data-i18n-* метка,
  // в непереводимых атрибутах кириллицы быть не должно вовсе.
  const markers = {
    'aria-label': 'data-i18n-aria-label',
    title: 'data-i18n-title',
    placeholder: 'data-i18n-placeholder',
    alt: 'data-i18n-alt',
  };
  for (const m of html.matchAll(/<([a-zA-Z][^>\s]*)(\s[^>]*)?>/g)) {
    const [, tag, attrs = ''] = m;
    for (const a of attrs.matchAll(/\s([a-zA-Z-]+)="([^"]*)"/g)) {
      const [, attr, value] = a;
      if (!cyrRe.test(value) || attr.startsWith('data-i18n')) continue;
      const marker = markers[attr];
      assert.ok(
        marker !== undefined && attrs.includes(`${marker}="`),
        `кириллический атрибут ${attr}="…" у <${tag}> без метки ${marker ?? 'data-i18n*'}`,
      );
    }
  }
  // Текст-ноды: кириллица допустима только как fallback внутри элемента с
  // data-i18n / data-i18n-html (до applyI18n). Комментарии — не текст-ноды.
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const part of body.split(/(<[^>]+>)/g)) {
    if (!part) continue;
    if (part.startsWith('<')) {
      if (part.startsWith('</')) stack.pop();
      else if (!part.endsWith('/>')) stack.push(part);
    } else if (cyrRe.test(part)) {
      const marked = stack.some((open) => /\sdata-i18n(?:-html)?=/.test(open));
      assert.ok(marked, `кириллическая текст-нода без data-i18n: «${part.trim().slice(0, 40)}»`);
    }
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
      assert.ok(key in ru, `t('${key}') в ${name}: ключа нет в словаре ru`);
      assert.ok(key in en, `t('${key}') в ${name}: ключа нет в словаре en`);
    }
  }
});

test('причины завершения сеанса переведены для всех известных кодов', () => {
  const reasons = ['ended', 'denied', 'host-lost', 'operator-lost', 'lease-expired', 'server-restart', 'signal-lost', 'rtc'];
  for (const r of reasons) {
    assert.ok(`end.${r}` in ru, `ключ end.${r} отсутствует в словаре ru`);
    assert.ok(`end.${r}` in en, `ключ end.${r} отсутствует в словаре en`);
  }
});

// ---- security-hardening проводка main-процесса (SEC-001/003/004/010) ----

test('main: агент передаёт консольного пользователя в терминал (SEC-001)', () => {
  assert.match(mainJs, /resolveConsoleUser\(\{ platform: process\.platform \}\)/);
  assert.match(mainJs, /consoleUser: consoleUser\.user/);
  assert.match(mainJs, /uid: consoleUser\.uid/);
});

test('main: окно моста закрыто для окон/навигации, разрешения — по allowlist (SEC-003/004)', () => {
  const bridge = /function createAgentRtc\([\s\S]*?\n\}/.exec(mainJs)?.[0] ?? '';
  assert.match(bridge, /setWindowOpenHandler/, 'мост не открывает окон');
  assert.match(bridge, /will-navigate/, 'мост не навигируется');
  assert.match(mainJs, /setPermissionRequestHandler/, 'запросы разрешений обрабатываются явно');
  assert.match(mainJs, /permission === 'clipboard-sanitized-write' \|\| permission === 'fullscreen'/, 'allowlist: только clipboard-sanitized-write и fullscreen');
  // захват экрана: 'display-capture' разрешается только при выбранном источнике
  // сеанса (иначе handler SEC-004 молча отклонял getDisplayMedia → NotAllowedError)
  assert.match(mainJs, /permission === 'display-capture'\) return callback\(Boolean\(selectedSource\)\)/, 'display-capture разрешён только с выбранным источником сеанса');
});

test('main: автоустановка при выходе только после подтверждения (SEC-010)', () => {
  assert.match(mainJs, /updateInstallDecision/);
  assert.match(mainJs, /dialog\.showMessageBox/, 'подтверждение — dialog-баннер');
  assert.match(mainJs, /autoInstallOnAppQuit = false/, 'по умолчанию установка выключена');
  assert.ok(!/autoInstallOnAppQuit = true\b/.test(mainJs), 'жёсткого включения установки быть не должно');
});

// ---- SEC-002 (desktop): входящий буфер оператора не пишется автоматически ----

test('SEC-002 desktop: incomingClip оператора не пишет в буфер — только явная кнопка', () => {
  const services = readFileSync(path.join(dir, 'session-services.js'), 'utf8');
  const fn = /export function operatorClipMessage\([\s\S]*?\n\}/.exec(services)?.[0] ?? '';
  assert.ok(fn, 'operatorClipMessage определён');
  assert.ok(!/enot\.copy/.test(fn), 'operatorClipMessage не должен писать в буфер оператора');
  assert.match(fn, /btn-op-clip-paste/, 'входящий текст показывает кнопку «Вставить из сеанса»');
  const handler = /\$\('btn-op-clip-paste'\)\.addEventListener\('click'[\s\S]*?\n\}\);/.exec(services)?.[0] ?? '';
  assert.ok(handler, 'кнопка «Вставить из сеанса» подключена кликом');
  assert.match(handler, /enot\.copy/, 'запись в буфер — только по явному клику');
  // в session-сервисах запись буфера ровно в двух местах: клиентский канал
  // (за тумблером, default off) и кнопка оператора; свои копирования в других
  // модулях (приглашение, свои креды) — вне сеанса и не считаются
  const sessionCopies = [...services.matchAll(/\benot\.copy\(/g)].length;
  assert.equal(sessionCopies, 2, 'в session-services.js enot.copy только в клиентском канале и в кнопке оператора');
  assert.match(allJs, /operator: false/, 'синхронизация буфера оператора выключена по умолчанию');
  assert.ok(!/id="clip-op-toggle"[^>]*checked/.test(html), 'тумблер оператора в разметке не отмечен');
  assert.match(services, /resetOperatorClip/, 'сброс ожидающего текста при завершении сеанса');
  assert.ok('op.clipPaste' in ru && 'op.clipPaste' in en, 'ключ кнопки в обоих словарях');
});

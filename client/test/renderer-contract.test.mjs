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
// chat-widget.html — отдельный документ со своими id (окно-виджет, main создаёт
// отдельный BrowserWindow): проверяется собственным контрактом ниже.
const WIDGET_JS = 'chat-widget.js';
const jsFiles = listJs(dir);
const allJs = jsFiles
  .filter((f) => path.basename(f) !== WIDGET_JS)
  .map((f) => readFileSync(f, 'utf8')).join('\n');
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

test('чат-виджет: все id из chat-widget.js есть в chat-widget.html', () => {
  const widgetHtml = readFileSync(path.join(dir, 'chat-widget.html'), 'utf8');
  const widgetJs = readFileSync(path.join(dir, 'chat-widget.js'), 'utf8');
  const ids = new Set([...widgetHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...widgetJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  for (const id of new Set(referenced)) {
    assert.ok(ids.has(id), `id «${id}» отсутствует в chat-widget.html`);
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

test('№18: desktop-оператор шлёт координаты клика в кнопке и захватывает указатель', () => {
  // регресс-защита десктопной половины №18 (web-половину ловит input-source.test):
  // без x,y у кнопки хост телепортирует курсор по lastX/lastY — «клик на крестик»;
  // без setPointerCapture отпускание за краем видео залипает кнопку на хосте.
  // Захват обязан идти из pointerdown: у MouseEvent (onmousedown) pointerId нет,
  // setPointerCapture(undefined) бросал NotFoundError и не ставил ничего
  // (ревью v0.4.6, high — подтверждено живым репро в Electron)
  const src = readFileSync(path.join(dir, 'operator-input.js'), 'utf8');
  assert.match(src, /down: true, x, y/, 'кнопка down несёт координаты клика');
  assert.match(src, /down: false, x, y/, 'кнопка up несёт координаты клика');
  assert.match(src, /setPointerCapture\?\.\(e\.pointerId\)/, 'указатель захвачен на down');
  assert.match(src, /\['pointerdown', onDown\]/, 'ввод — pointer-события (у MouseEvent нет pointerId)');
  // pointercancel (тач-жест перехвачен браузером) отпускает кнопку — pointerup после него не придёт
  assert.match(src, /pointercancel/, 'pointercancel обязан отпускать кнопку');
  // координаты по кадру видео (videoWidth), а не по 16:9 CSS-боксу с буквицей
  assert.match(src, /videoWidth/, 'нормализация по кадру видео, не по CSS-боксу (ревью v0.4.6)');
  assert.match(src, /fit-cover/, 'учтён режим object-fit cover');
  // addEventListener без detach накапливал бы слушатели на единственном видео
  // при каждом re-offer — detach обязателен (паритет web-твину, ревью v0.4.6)
  assert.match(src, /return \{\s*detach/, 'wireOperatorInput возвращает {detach}');
  const mediaSrc = readFileSync(path.join(dir, 'session-media.js'), 'utf8');
  assert.match(mediaSrc, /inputDetach\?\.detach\?\.\(\)/, 'слушатели снимаются при перепроводке/конце сеанса');
});

test('двойной onJoinStart не создаёт второй сеанс (joinInFlight)', () => {
  // join-ссылка + TEST_AUTO_SESSION уходят в один тик; гвард по state.session
  // бессилен против параллельных вызовов (create ещё в полёте) — ревью v0.4.6
  const src = readFileSync(path.join(dir, 'views', 'client-view.js'), 'utf8');
  assert.match(src, /joinInFlight/, 'флаг «create в полёте» должен сериализовать старты');
  assert.match(src, /state\.session \|\| joinInFlight/, 'гвард стоит до первого await');
});

test('app.js: сигналинг/ended решают по сеансу, а не по активной вкладке', () => {
  // привязка к state.role роняла восстановление №15 кликом по табу
  // (оффер вернувшегося хоста молча отбрасывался) — ревью v0.4.6
  const src = readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.match(src, /if \(state\.connect && msg\.data\.description\.type === 'offer'\)/,
    'оффер диспетчерится по сеансу оператора (state.connect)');
  assert.match(src, /state\.session && msg\.data\.description\.type === 'answer'/,
    'answer диспетчерится по сеансу клиента (state.session)');
  // мультиоператор (волна v0.6.2): answer тегирован from=claimId — роутится
  // в персональный pc оператора, не в единственный state.pc
  assert.match(src, /routeOperatorSignal\(msg\.from, msg\.data\)/,
    'answer/ICE клиента-хоста роутятся в персональный pc оператора');
  assert.match(src, /case 'operator-joined':[\s\S]{0,300}attachOperator\(msg\.claimId/,
    'operator-joined поднимает персональный pc по claimId');
  assert.match(src, /case 'operator-left':[\s\S]{0,200}dropOperator\(msg\.claimId\)/,
    'operator-left снимает персональный pc, сеанс живёт');
  assert.match(src, /const clientSide = state\.role === 'client' \|\| !!state\.session;/,
    'экран завершения — по сеансу, симметрично rtcLinkLost');
  assert.match(src, /if \(graceMs > 0\) holdRtcLink/,
    'graceMs=0 (fail-closed): hold не берётся, паритет web');
  assert.match(src, /case 'resumed':[\s\S]{0,500}connectionState === 'connected'/,
    'resumed не заявляет «Подключено» при мёртвом pc');
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
  // захват экрана: getDisplayMedia приходит в хендлер как 'media' (общий медиа-путь
  // Electron 44), 'display-capture' — только в Permissions API; оба разрешаются
  // только при выбранном источнике сеанса (ревью GLM-5.3, подтверждено прогоном)
  assert.match(mainJs, /permission === 'media' \|\| permission === 'display-capture'/, 'media/display-capture разрешены');
  assert.match(mainJs, /setPermissionCheckHandler/, 'синхронные проверки разрешений — той же политикой');
  // гигиена: источник и его разрешение умирают вместе с сеансом
  assert.match(mainJs, /selectedSource = null; \/\/ разрешение 'media' привязано к источнику/, 'selectedSource очищается в stopSignal');
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
  // (за тумблером, default ON по решению владельца 27.09 — выключается тогглом)
  // и кнопка оператора; свои копирования в других модулях (приглашение, свои
  // креды) — вне сеанса и не считаются
  const sessionCopies = [...services.matchAll(/\benot\.copy\(/g)].length;
  assert.equal(sessionCopies, 2, 'в session-services.js enot.copy только в клиентском канале и в кнопке оператора');
  // безопасность сохранена: входящий оператору — по кнопке; дефолт ON касается
  // только ОТПРАВКИ своего буфера (решение владельца: «по умолчанию, с отключением»)
  assert.match(allJs, /operator: true/, 'синхронизация буфера оператора включена по умолчанию');
  assert.match(html, /id="clip-client-toggle" checked/, 'клиентский тоггл буфера отмечен по умолчанию');
  assert.match(html, /id="clip-op-toggle" checked/, 'операторский тоггл буфера отмечен по умолчанию');
  assert.match(services, /resetOperatorClip/, 'сброс ожидающего текста при завершении сеанса');
  assert.ok('op.clipPaste' in ru && 'op.clipPaste' in en, 'ключ кнопки в обоих словарях');
});

test('крест: revoke сеанса — ДО app.quit, не внутри before-quit (№9-хвост, ревью v0.4.7)', () => {
  // Electron не ждёт промисы в before-quit: fetch session.end проигрывал гонку
  // выходу процесса — сеанс умирал host-lost после всего грейса, оператор 30 с
  // смотрел «переподключается» на намеренное закрытие (крест-тест 01.10)
  assert.match(mainJs, /const revokeDone = \(api\.hostSessionId && api\.hostToken\)/,
    'window-all-closed взводит revoke до quit');
  assert.match(mainJs, /revokeDone\.then\(\(\) => \{[\s\S]{0,80}app\.quit\(\)/,
    'quit только после revoke (бюджет 1.2 с)');
  assert.match(mainJs, /session\.end[\s\S]{0,60}asHost: true/, 'revoke гасит сеанс как хост');
});

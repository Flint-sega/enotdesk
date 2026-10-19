import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  assert.match(src, /attachOperator\(msg\.claimId, op\.name \?\? ''\)\.catch/,
    'attachOperator вызывается с .catch — не роняет approved-ветку');
  assert.match(src, /case 'operator-left':[\s\S]{0,200}dropOperator\(msg\.claimId\)/,
    'operator-left снимает персональный pc, сеанс живёт');
  // живая приёмка v0.6.2: sync-функция с ранними return + .catch() снаружи =
  // TypeError «reading 'catch'» и падение startHostRtc сразу после «Разрешить»
  const media = readFileSync(path.join(dir, 'session-media.js'), 'utf8');
  assert.match(media, /export async function attachOperator\(/,
    'attachOperator — async: ранние выходы возвращают Promise, .catch снаружи безопасен');
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
  // Механика (BaseUpdater.executeDownload → addQuitHandler): свой quit-хук
  // electron-updater ставит сразу ПОСЛЕ возврата из обработчика и лишь при
  // autoInstallOnAppQuit=true в тот момент. Продукт от хука не зависит: до
  // первого await диалога в обработчике флага true быть не должно — иначе хук
  // зарегистрируется и поставит обновление при любом выходе с кодом 0, включая
  // закрытое окно при открытом диалоге (ревью 10.10; ранее U-4, приёмка 09.10 —
  // обратная крайность: флаг только после диалога делал подтверждение мёртвым).
  // Отказ после диалога оставляет флаг в false; установка — только через
  // will-quit по updateOnQuitVersion (явное «Обновить сейчас»). macOS —
  // исключение: MacUpdater не имеет quit-хука и гейтит Squirrel-фетч тем же
  // флагом в момент emit — false убивает весь mac-путь (ревью 10.10, P2-1),
  // поэтому там платформенный сплит с честной оговоркой про Squirrel-семантику.
  const handler = /autoUpdater\.on\('update-downloaded',[\s\S]*?\n {2}\}\);/.exec(mainJs)?.[0] ?? '';
  assert.ok(handler, 'обработчик update-downloaded найден');
  const dialogAsk = handler.search(/await dialog\.showMessageBox/);
  assert.ok(dialogAsk >= 0, 'подтверждение — dialog-баннер внутри обработчика');
  const darwinGate = handler.search(/autoInstallOnAppQuit = process\.platform === 'darwin'/);
  assert.ok(darwinGate >= 0 && darwinGate < dialogAsk, 'mac-ветка: платформенный сплит до диалога — иначе MacUpdater не инициирует Squirrel-фетч');
  const consentTrue = handler.search(/autoInstallOnAppQuit = true/);
  assert.ok(consentTrue === -1 || consentTrue > dialogAsk, 'до диалога флага true быть не должно — иначе зарегистрируется тихий quit-хук updaterа');
  // \r? — на Windows-раннере рабочий дуб checkout'ается с CRLF
  const consentGate = handler.search(/autoInstallOnAppQuit = false;\r?\n {6}bootLog/);
  assert.ok(consentGate > dialogAsk, 'после диалога отказ оставляет флаг в false (SEC-010)');
  assert.match(handler, /updateOnQuitVersion = version;\r?\n {4}autoUpdater\.autoInstallOnAppQuit = true/, 'явное согласие возвращает флаг в true');
  assert.match(handler, /gate\.isOpen\(\)/, 'активный сеанс не рвётся кнопкой обновления');
  assert.match(handler, /app\.quit\(\)/, '«Обновить сейчас» — честный выход приложения');
  // Находка 10.10.2026: quit-хук electron-updater'а молча пропускал установку
  // при exitCode ≠ 0 и не перезапускал приложение — пользователь видел «ничего
  // не произошло». Теперь в will-quit (после before-quit-очистки) — тихая
  // установка с перезапуском (--force-run).
  const willQuit = /app\.on\('will-quit',[\s\S]*?\n\}\);/.exec(mainJs)?.[0] ?? '';
  assert.ok(willQuit, 'will-quit обработчик обновления найден');
  assert.match(willQuit, /quitAndInstall\(true, true\)/, 'тихая установка с перезапуском');
  assert.match(willQuit, /updateOnQuitVersion/, 'установка только подтверждённого обновления');
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

// ---- Волна C (мультиоператор: арбитраж ввода W-C4 + видеокап W-C5) ----

test('W-C4: события ввода уходят в main с opKey; claim/release перехватываются до валидации', () => {
  const services = readFileSync(path.join(dir, 'session-services.js'), 'utf8');
  assert.match(services, /enot\.input\(m\.data, opKey\)/,
    'enot.input обязан нести opKey — иначе main не отличит операторов');
  assert.match(services, /svc\.type === 'claim-input'[\s\S]{0,120}enot\.inputClaim\(opKey\)/,
    'claim-input уходит в main IPC-мостом');
  assert.match(services, /svc\.type === 'release-input'[\s\S]{0,120}enot\.inputRelease\(opKey\)/,
    'release-input уходит в main IPC-мостом');
  assert.match(services, /claim-input[\s\S]{0,200}return;/,
    'служебное сообщение не падает в enot.input');
});

test('W-C4: main держит фильтр арбитража ДО idle-таймера и инъекции; кнопки/статус в разметке', () => {
  // фильтр раньше lastInputAt: idle-таймер считает только разрешённые события
  const inputHandler = /ipcMain\.handle\('enot:input', \(e, ev, opKey = 'primary'\) => \{[\s\S]*?\n {2}\}\);/.exec(mainJs)?.[0] ?? '';
  assert.ok(inputHandler, 'обработчик enot:input найден');
  const gatePos = inputHandler.search(/inputArbiter\.isAllowed/);
  const idlePos = inputHandler.search(/lastInputAt = Date\.now/);
  assert.ok(gatePos >= 0 && idlePos > gatePos, 'arbiter.isAllowed обязан стоять раньше lastInputAt');
  assert.match(inputHandler, /reason: 'input-not-granted'/, 'честный отказ отброшенному вводу');
  // IPC-набор арбитража
  for (const ch of ['enot:input-claim', 'enot:input-release', 'enot:input-attach', 'enot:input-drop']) {
    assert.ok(mainJs.includes(ch), `main обязан держать канал ${ch}`);
  }
  assert.match(mainJs, /inputArbiter\.reset\(\)/, 'сброс арбитра в stopSignal — операторы не переживают сеанс');
  // preload-мост
  const preload = readFileSync(path.join(dir, '..', 'preload.cjs'), 'utf8');
  for (const m of ['inputClaim', 'inputRelease', 'inputAttach', 'inputDrop', 'onInputActive']) {
    assert.ok(preload.includes(m), `preload обязан выставлять ${m}`);
  }
  // UI: статус + обе кнопки в разметке (анти-мёртвые-кнопки проверят подключение)
  assert.match(html, /id="op-control-status"/, 'статус управления в op-remote');
  assert.match(html, /id="btn-op-take-control"/, 'кнопка «Взять управление»');
  assert.match(html, /id="btn-op-give-control"/, 'кнопка «Отдать управление»');
  assert.match(html, /id="client-control-note"/, 'бейдж «кто управляет» у клиента');
  // grants: рассылка по per-op input-каналам + бейдж
  const media = readFileSync(path.join(dir, 'session-media.js'), 'utf8');
  assert.match(media, /enot\.onInputActive[\s\S]{0,400}input-grant/,
    'смена активного рассылает grants по input-каналам операторов');
  assert.match(media, /enot\.inputAttach\(claimId\)/, 'attach оператора в attachOperatorNow');
  assert.match(media, /enot\.inputDrop\(claimId\)/, 'drop оператора в dropOperator');
  // словарный паритет статусов/кнопок (ru=en проверит i18n-автотест — здесь наличие t()-ключей)
  assert.ok('op.takeControl' in ru && 'op.takeControl' in en, 'ключ op.takeControl в обоих словарях');
  assert.ok('op.giveControl' in ru && 'op.giveControl' in en, 'ключ op.giveControl в обоих словарях');
  assert.ok('op.viewOnly' in ru && 'op.hasControl' in en, 'ключи op.viewOnly/op.hasControl');
  assert.ok('client.controlBy' in ru && 'client.controlBy' in en, 'ключ client.controlBy');
});

test('W-C5: cap видеослотов — сверх 3 операторов pc без видео + честный session-info', () => {
  const media = readFileSync(path.join(dir, 'session-media.js'), 'utf8');
  assert.match(media, /videoAllowed\(videoOperatorCount\(\)\)/,
    'attachOperatorNow решает видеослот чистой функцией multiop-limits');
  assert.match(media, /noVideo: !grantVideo/, 'оператор помечен деградированным');
  const services = readFileSync(path.join(dir, 'session-services.js'), 'utf8');
  assert.match(services, /'video-slots-full'/, 'session-info о занятых слотах по input-каналу');
  assert.match(html, /id="op-video-note"/, 'статус «видеослоты заняты» в op-remote');
  assert.ok('op.videoSlotsFull' in ru && 'op.videoSlotsFull' in en, 'ключ op.videoSlotsFull');
});

test('W-C0: not_approved не роняет UI клиента (ранний join второго оператора)', () => {
  const src = readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.match(src, /msg\.code === 'not_approved' && state\.session[\s\S]{0,80}break/,
    'ошибка not_approved при живом сеансе тихо игнорируется — scheduleReattach доиграет');
});

// «Запомнить меня» на входе оператора (10.10): чекбокс в форме, мост в preload,
// хранение только через шифротекст safeStorage (lib-тесты — op-credentials.test.mjs).
test('вход оператора: запоминание кредов на месте и идёт через safeStorage-мост', () => {
  const preload = readFileSync(path.join(dir, '..', 'preload.cjs'), 'utf8');
  assert.match(html, /id="login-remember"/, 'чекбокс «Запомнить меня» в форме входа');
  assert.match(html, /data-i18n="op.remember"/, 'подпись чекбокса — через словарь');
  for (const method of ['opCredentialsAvailable', 'opCredentialsSave', 'opCredentialsLoad', 'opCredentialsClear']) {
    assert.ok(preload.includes(method), `preload обязан выставлять ${method}`);
    assert.ok(mainJs.includes(`'enot:${method}'`), `main обязан держать канал enot:${method}`);
  }
  assert.match(mainJs, /createOpCredentialsStore/, 'main собирает хранилище из lib');
  assert.match(mainJs, /mode: 0o600/, 'файл кредов — 0600');
  const view = readFileSync(path.join(dir, 'views', 'operator-view.js'), 'utf8');
  assert.match(view, /opCredentialsSave\(\{ login, password \}\)/, 'сохранение — только после успешного входа');
  assert.match(view, /opCredentialsClear\(\)/, 'очистка: снятый чекбокс и 401 с сохранёнными кредами');
});

// ---- Приёмка C+D (16.10): host fan-out чата операторов + начальный input-grant ----
// Функциональный DOM-шим: session-services.js исполняется по-настоящему (модуль
// верхнего уровня вешает листенеры — фейк их просто принимает), wireHostChannel
// гоняется на фейковых DataChannel двух операторов.

test('C+D/G2: сообщение оператора релеится чат-каналам остальных операторов (host fan-out, метка автора)', async () => {
  const el = () => ({
    value: '', textContent: '', className: '', innerHTML: '', dataset: {},
    classList: { add() {}, remove() {} },
    appendChild() {}, append() {},
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null,
    scrollTop: 0, scrollHeight: 0, files: [],
  });
  const widgetMsgs = [];
  globalThis.document = {
    getElementById: () => el(),
    createElement: () => el(),
    createTextNode: () => ({}),
    querySelector: () => el(),
    addEventListener() {}, removeEventListener() {},
    getSelection: () => '',
  };
  globalThis.window = { enot: { chatWidgetMsg: (v) => widgetMsgs.push(String(v)) } };
  try {
    const { wireHostChannel } = await import(pathToFileURL(path.join(dir, 'session-services.js')).href);
    const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
    const mkCh = (label) => ({
      label, readyState: 'open', binaryType: '', onmessage: null, onopen: null, onclose: null,
      sent: [],
      send(data) { this.sent.push(data); },
      close() { this.readyState = 'closed'; },
    });
    state.operators.clear();
    state.inputActiveClaimId = null;
    // G2: у op1 есть имя (operator-joined принёс), у op2 — нет (старый формат)
    state.operators.set('op1', { dcs: {}, name: 'Макс' });
    state.operators.set('op2', { dcs: {} });
    const op1chat = mkCh('chat'); const op2chat = mkCh('chat');
    wireHostChannel(op1chat, 'op1');
    wireHostChannel(op2chat, 'op2');
    op1chat.onmessage({ data: JSON.stringify({ type: 'chat', text: 'привет от op1' }) });
    assert.deepEqual(op2chat.sent, [JSON.stringify({ type: 'chat', text: 'привет от op1', from: 'operator', name: 'Макс' })],
      'сообщение op1 дошло op2 с меткой автора from+name (G2)');
    assert.deepEqual(op1chat.sent, [], 'отправителю не эхаем его же сообщение');
    assert.deepEqual(widgetMsgs, ['привет от op1'], 'чат-виджет хоста по-прежнему получает сообщение');
    op2chat.onmessage({ data: JSON.stringify({ type: 'chat', text: 'ответ op2' }) });
    assert.deepEqual(op1chat.sent, [JSON.stringify({ type: 'chat', text: 'ответ op2', from: 'operator' })],
      'ответ op2 дошёл op1; без имени поле name не ставится (старый operator-joined)');
    // G2: метку ставит ТОЛЬКО хост — попытка оператора подписаться «хостом»
    // перезаписывается: в провод уходит from:'operator', не 'host'
    op1chat.onmessage({ data: JSON.stringify({ type: 'chat', text: 'спуф', from: 'host' }) });
    assert.deepEqual(op2chat.sent[1], JSON.stringify({ type: 'chat', text: 'спуф', from: 'operator', name: 'Макс' }),
      'подделка from:host оператором перезаписывается меткой operator (метку ставит хост)');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

// G2 (приёмная сторона): оператор различает сообщения коллеги (from:'operator'
// → «Оператор {имя}») и хоста/старых хостов (без поля или from:'host' → «Клиент»).
test('G2: оператор-получатель подписывает коллегу «Оператор {имя}», хоста и легаси — «Клиент»', async () => {
  const logs = []; // строки op-chat-log: [{tag, children:[strong|text…]}]
  const makeEl = (tag) => ({
    tag, textContent: '', className: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    classList: { add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {},
    scrollTop: 0, scrollHeight: 0,
  });
  globalThis.document = {
    getElementById: (id) => {
      const e = makeEl('div');
      if (id === 'op-chat-log') logs.push(e);
      return e;
    },
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ tag: '#text', text }),
    querySelector: () => makeEl('div'),
    addEventListener() {}, removeEventListener() {},
    getSelection: () => '',
  };
  globalThis.window = { enot: {} };
  try {
    const { operatorChatMessage } = await import(pathToFileURL(path.join(dir, 'session-services.js')).href);
    const { t } = await import(pathToFileURL(path.join(dir, '..', 'lib', 'i18n.mjs')).href);
    const lastLine = () => {
      const line = logs.at(-1)?.children.at(-1); // log → последняя строка <p>
      const strong = line?.children.find((c) => c.tag === 'strong');
      const text = line?.children.find((c) => c.tag === '#text');
      return { label: strong?.textContent ?? '', text: text?.text ?? '' };
    };
    operatorChatMessage({ from: 'operator', name: 'Анна', text: 'коллеге привет' });
    assert.equal(lastLine().label, `${t('op.messageBy', { name: 'Анна' })}: `, 'коллега подписан «Оператор {имя}»');
    assert.equal(lastLine().text, 'коллеге привет');
    // хост с новой меткой from:'host' — по-прежнему «Клиент»
    operatorChatMessage({ from: 'host', text: 'ответ хоста' });
    assert.equal(lastLine().label, `${t('chat.client')}: `, 'хост подписан «Клиент»');
    // старые хосты поля не ставят; исторический вызов строкой — тоже «Клиент»
    operatorChatMessage({ text: 'легаси-объект' });
    assert.equal(lastLine().label, `${t('chat.client')}: `, 'легаси-сообщение без поля — «Клиент»');
    operatorChatMessage('легаси-строка');
    assert.equal(lastLine().label, `${t('chat.client')}: `, 'строчный вызов — «Клиент» (старый контракт)');
    // оператор без имени (старый operator-joined) — прежний ключ chat.operator
    operatorChatMessage({ from: 'operator', text: 'без имени' });
    assert.equal(lastLine().label, `${t('chat.operator')}: `, 'оператор без имени — «Оператор» без вставки');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('C+D (P3-1): при открытии input-канала оператору сливается текущий input-grant', async () => {
  const el = () => ({
    value: '', textContent: '', className: '', innerHTML: '', dataset: {},
    classList: { add() {}, remove() {} },
    appendChild() {}, append() {},
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null,
    scrollTop: 0, scrollHeight: 0, files: [],
  });
  globalThis.document = {
    getElementById: () => el(),
    createElement: () => el(),
    createTextNode: () => ({}),
    querySelector: () => el(),
    addEventListener() {}, removeEventListener() {},
    getSelection: () => '',
  };
  globalThis.window = { enot: {} };
  try {
    const { wireHostChannel } = await import(pathToFileURL(path.join(dir, 'session-services.js')).href);
    const { state } = await import(pathToFileURL(path.join(dir, 'state.js')).href);
    const mkCh = (label) => ({
      label, readyState: 'open', binaryType: '', onmessage: null, onopen: null, onclose: null,
      sent: [],
      send(data) { this.sent.push(data); },
      close() { this.readyState = 'closed'; },
    });
    state.operators.clear();
    state.operators.set('op1', { dcs: {} });
    state.operators.set('op2', { dcs: {} });
    // событие input-active уже пришло (канал ещё не открыт был) — кэш в state
    state.inputActiveClaimId = 'op1';
    const op1input = mkCh('input'); const op2input = mkCh('input');
    wireHostChannel(op1input, 'op1');
    wireHostChannel(op2input, 'op2');
    const grant = (ch) => ch.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'input-grant');
    assert.deepEqual(grant(op1input), [{ type: 'input-grant', granted: true }],
      'активный оператор узнаёт своё состояние на открытии канала');
    assert.deepEqual(grant(op2input), [{ type: 'input-grant', granted: false }],
      'второй оператор честно видит «только просмотр»');
    // деградация W-C5 не съедает грант: noVideo-оператору уходят и grant, и session-info
    state.operators.set('op3', { dcs: {}, noVideo: true });
    const op3input = mkCh('input');
    wireHostChannel(op3input, 'op3');
    const parsed3 = op3input.sent.map((s) => JSON.parse(s));
    assert.ok(parsed3.some((m) => m.type === 'input-grant' && m.granted === false), 'грант ушёл и noVideo-оператору');
    assert.ok(parsed3.some((m) => m.type === 'session-info' && m.reason === 'video-slots-full'), 'session-info на месте');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

// ADR 0033, этап 2: вкладка «Оператор» открывает программу оператора с сервера
// в отдельном окне; прежний встроенный оператор скрыт до удаления на этапе 3.
test('программа оператора: карточка окна, мост openOperatorWindow, прежний UI скрыт', () => {
  const preload = readFileSync(path.join(dir, '..', 'preload.cjs'), 'utf8');
  assert.match(html, /<div id="op-legacy" class="hidden">/, 'прежний встроенный оператор не показывается');
  assert.ok(html.indexOf('id="op-window"') < html.indexOf('id="op-legacy"'), 'карточка окна — первой во вкладке');
  assert.ok(html.indexOf('id="op-login"') > html.indexOf('id="op-legacy"'), 'старый вход — внутри скрытого блока');
  for (const m of ['openOperatorWindow', 'onOperatorWindow']) assert.ok(preload.includes(m), `preload выставляет ${m}`);
  assert.match(mainJs, /ipcMain\.handle\('enot:openOperatorWindow', \(e\) => \{ guard\(e\); return openOperatorWindow\(\); \}\);/);
  const app = readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.match(app, /\$\('btn-op-window'\)\.addEventListener\('click'/);
  assert.match(app, /'opwin\.outdated'/, 'старый сервер — честное «обновите сервер»');
  assert.match(app, /'opwin\.unreachable'/);
});

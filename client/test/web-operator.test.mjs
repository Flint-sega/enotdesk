import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Шов 3 (interfaces.md): контракт рендерера расширяется на браузерного оператора.
// web/operator.html обязан держать все id, которые ищет web/*.mjs; разметка —
// только через data-i18n*; словари — те же ru/en; кнопки не мёртвые; в JS-модулях
// страницы нет кириллических литералов (тексты только из словаря).

const webDir = path.join(import.meta.dirname, '..', '..', 'web');
// чтение нормализует CRLF→LF: checkout на Windows конвертит LF→CRLF, а шаблоны
// ниже матчат \n (семантика ассертов не меняется — это только концы строк)
const readSrc = (name) => readFileSync(path.join(webDir, name), 'utf8').replace(/\r\n/g, '\n');
const html = readSrc('operator.html');
const operatorJs = readSrc('operator.mjs');
const inputJs = readSrc('input-source.mjs');
const teamJs = readSrc('team.js'); // UI команды (admin): свои id/кнопки в operator.html
const recordsJs = readSrc('records.js'); // B6 этап 1: адресная книга, история, журнал, CSV
const accountJs = readSrc('account.js'); // B6 этап 3: смена пароля и 2FA (перенос из desktop)
const allJs = `${operatorJs}\n${inputJs}\n${teamJs}\n${recordsJs}\n${accountJs}`;

import ru from '../locales/ru.mjs';
import en from '../locales/en.mjs';

test('web/operator.html: каждый data-i18n* ключ есть в словарях ru и en', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20, 'статические строки страницы должны быть помечены data-i18n');
  for (const key of new Set(keys)) {
    assert.ok(key in ru, `ключ «${key}» отсутствует в словаре ru`);
    assert.ok(key in en, `ключ «${key}» отсутствует в словаре en`);
  }
});

test('web/*.mjs: ключи t(\'…\') существуют в обоих словарях', () => {
  for (const m of allJs.matchAll(/\bt\('([^']+)'/g)) {
    const key = m[1];
    assert.ok(key in ru, `t('${key}') в web: ключа нет в словаре ru`);
    assert.ok(key in en, `t('${key}') в web: ключа нет в словаре en`);
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
    // team.js использует getElementById (у веб-модулей нет общего $-хелпера)
    const wired = new RegExp(`\\$\\('${id}'\\)|getElementById\\('${id}'\\)`).test(allJs);
    assert.ok(wired, `кнопка «${id}» есть в HTML, но не подключена в web/*.mjs`);
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

// ---- №15 (ретест 28–29.09): RTC-грейс оператора ≥ серверного graceMs ----

test('web/operator.mjs: peer-reconnecting держит видео-сеанс (rtc-hold), а не рвёт по 10с', () => {
  // hold взводится в обработчике peer-reconnecting — и только при живом сеансе
  // (осиротевшая страница hold не берёт, иначе он протечёт в следующий сеанс)
  assert.match(operatorJs, /case 'peer-reconnecting':[\s\S]{0,600}if \(state\.connect\) holdRtcLinkLost\(\)/,
    'peer-reconnecting должен взводить rtc-hold под guardом state.connect (№15)');
  // 10с-таймер самовозобновляется под hold и после его истечения рвёт честно:
  // assert на ВЫЗОВЫ clearRtcHold (определение исключено lookbehind'ом —
  // «косметическое» вхождение не должно маскировать удаление живого вызова,
  // ревью v0.4.6; живых вызовов два: connected + stopMedia)
  const clearCalls = operatorJs.match(/(?<!function )clearRtcHold\(\)/g) ?? [];
  assert.ok(clearCalls.length >= 2, `clearRtcHold живых вызова (connected + stopMedia), найдено: ${clearCalls.length}`);
  assert.match(operatorJs, /if \(rtcHoldActive\(\)\) \{ rtcGrace = setTimeout\(tick, 10_000\); return; \}[\s\S]{0,80}rtcLinkLost\(\)/,
    '10с-таймер должен ждать hold и разорвать сеанс после его истечения');
  assert.match(operatorJs, /&& !rtcHoldActive\(\)\) rtcLinkLost\(\)/,
    'ветка failed/closed должна уважать rtc-hold');
  // hold не длиннее server-grace + запас и не берётся при ENOT_GRACE_MS=0
  assert.match(operatorJs, /SIGNAL_GRACE_MS \+ 10_000/, 'hold считается от серверного graceMs');
  assert.match(operatorJs, /if \(ms <= 0\) return;/, 'ENOT_GRACE_MS=0: hold не взводится (fail-closed сервера)');
  // ревью v0.4.6: hold истёк, а pc так и не поднялся (в т.ч. failed ПРЯМО под
  // hold, без 'disconnected' до него) — честный разрыв вместо вечного зомби
  assert.match(operatorJs, /st === 'failed' \|\| st === 'closed'\) rtcLinkLost\(\)/,
    'истечение hold переоценивает pc — failed/closed под hold рвутся по расписанию');
  // гонка №15: локальный disconnected взводит hold до прихода серверного сигнала
  assert.match(operatorJs, /if \(!rtcHoldActive\(\) && SIGNAL_GRACE_MS > 0\) holdRtcLinkLost\(\)/,
    'disconnected держит hold сам, не дожидаясь peer-reconnecting от сервера');
});

test('web/operator.mjs: resumed не заявляет «Подключено» при мёртвом pc', () => {
  // конвенция «никогда не фейкуем успех»: сигналинг возвращается раньше медиа —
  // статус честно остаётся «переподключается» до фактического connected (ревью v0.4.6)
  assert.match(operatorJs, /case 'resumed':[\s\S]{0,500}connectionState === 'connected'/,
    'resumed обязан проверять состояние pc перед «Подключено»');
});

// ---- панель «Машины» (R07): только существующий machines API, admin-only ----

test('web/operator.html: панель машин скрыта для не-admin и держит контрактные id', () => {
  const ids = [
    'view-machines', 'machines-list', 'machines-empty', 'machines-error',
    'machines-page', 'btn-machines-prev', 'btn-machines-next', 'btn-machines-refresh',
    'machines-claim', 'machines-claim-name', 'machines-claim-error',
    'machines-claim-form', 'machines-claim-reason', 'machines-claim-pin-field', 'machines-claim-pin',
    'btn-machines-claim', 'btn-machines-claim-cancel',
    'btn-nav-machines', 'btn-nav-connect',
  ];
  for (const id of ids) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `панель машин: нет id «${id}»`);
  }
  // RBAC в разметке: кнопка «Машины» скрыта по умолчанию — показывает её
  // только JS после проверки роли admin; не-admin панель не видит вовсе.
  const nav = /<button[^>]*id="btn-nav-machines"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(nav, /class="[^"]*\bhidden\b/, 'кнопка «Машины» должна быть скрыта в разметке (admin-only)');
  const claimPinField = /<div[^>]*id="machines-claim-pin-field"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(claimPinField, /class="[^"]*\bhidden\b/, 'поле PIN закрыто до проверки hasPin');
  // PIN-поле — парольного типа, чтобы PIN не светился на экране
  assert.match(html, /id="machines-claim-pin"[^>]*type="password"|type="password"[^>]*id="machines-claim-pin"/, 'PIN вводится закрытым полем');
});

test('web/*.mjs: панель машин показывается только admin и ходит в machines API (включая toast R08)', () => {
  // B6 этап 1: видимость разделов собрана в applyRoleUi — «Машины» только admin
  assert.match(operatorJs, /\['btn-nav-machines', 'btn-nav-team', 'btn-nav-audit'\]\) \(role === 'admin' \? show : hide\)/, 'кнопку «Машины» показывает только роль admin');
  const paths = [...operatorJs.matchAll(/api\('(?:GET|POST|DELETE)',\s*(`[^`]*`|'[^']*')/g)].map((m) => m[1]);
  const machinePaths = paths.filter((p) => p.includes('/machines'));
  assert.ok(machinePaths.length >= 5, 'панель машин должна использовать machines API (список, claim, pin, revoke, delete, toast)');
  const allowed = [
    /^'\/machines'$/, // «Добавить машину»: POST /machines → одноразовый код
    /^`\/machines\?[^`]*`$/, // список с пагинацией limit/offset
    /^`\/machines\/\$\{[^`]+\}\/(claim|pin|revoke|toast|wol)`$/, // действия одной машины
    /^`\/machines\/\$\{[^`]+\}`$/, // GET/DELETE одной машины
  ];
  for (const p of machinePaths) {
    assert.ok(allowed.some((re) => re.test(p)), `неизвестный machines-маршрут: ${p}`);
  }
  // сообщение на экран (R08, T08) и пробуждение (R10) вызываются со страницы машин;
  // инвентарь приезжает в списке машин — отдельного inventory-вызова нет
  assert.ok(machinePaths.some((p) => /toast/.test(p)), 'toast-маршрут вызывается со страницы машин');
  assert.ok(machinePaths.some((p) => /wol/.test(p)), 'wol-маршрут вызывается со страницы машин');
  assert.ok(!machinePaths.some((p) => /inventory/.test(p)), 'отдельного inventory-маршрута на странице нет');
});

test('«Добавить машину»: POST /machines, код показывается один раз и стирается при закрытии', () => {
  assert.match(operatorJs, /api\('POST', '\/machines', /, 'создание машины идёт в POST /machines');
  for (const id of ['btn-machines-add', 'machines-add-form', 'machines-add-code', 'machines-add-server', 'btn-machines-add-close']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `нет id «${id}» в web/operator.html`);
  }
  const clear = /function clearMachineAddResult\(\) \{[\s\S]*?\n\}/.exec(operatorJs)?.[0] ?? '';
  assert.match(clear, /text\(\$\('machines-add-code'\), ''\)/, 'закрытие стирает код из DOM');
  const close = /function closeMachineAdd\(\) \{[\s\S]*?\n\}/.exec(operatorJs)?.[0] ?? '';
  assert.match(close, /clearMachineAddResult\(\)/, 'closeMachineAdd стирает результат');
  for (const fn of ['showMachines', 'forgetSession']) {
    const body = new RegExp(`function ${fn}\\(\\) \\{[\\s\\S]*?\\n\\}`).exec(operatorJs)?.[0] ?? '';
    assert.match(body, /closeMachineAdd\(\)/, `${fn} закрывает карточку с кодом`);
  }
  const submit = /async function submitMachineAdd\(\) \{[\s\S]*?\n\}/.exec(operatorJs)?.[0] ?? '';
  assert.ok(!/clipboard|localStorage|sessionStorage|console\./.test(submit), 'код не уходит в буфер, хранилище или консоль');
});

test('web/*.mjs: действия строк машин подключены через data-action (анти-мёртвые-кнопки)', () => {
  const listDecl = /MACHINE_ACTIONS = \[([^\]]+)\]/.exec(allJs)?.[1] ?? '';
  const declared = [...listDecl.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(declared.length >= 4, 'у строк машин должны быть действия (терминал, PIN, отзыв, удаление)');
  for (const action of declared) {
    assert.ok(allJs.includes(`action === '${action}'`), `действие «${action}» не обрабатывается в делегировании machines-list`);
  }
});

// ---- SEC-002: входящий буфер не пишется автоматически — только явный клик ----

test('SEC-002: incomingClip не пишет в буфер; writeText на странице ровно один — в клике кнопки', () => {
  const incoming = /function incomingClip\([\s\S]*?\n\}/.exec(operatorJs)?.[0] ?? '';
  assert.ok(incoming, 'incomingClip определён');
  assert.ok(!/writeText|copyText|clipboard/.test(incoming), 'incomingClip не должен трогать буфер оператора');
  assert.match(incoming, /btn-op-clip-paste/, 'incomingClip показывает кнопку «Вставить из сеанса»');
  const handler = /\$\('btn-op-clip-paste'\)\?\.addEventListener\('click'[\s\S]*?\n\s{2}\}\);/.exec(operatorJs)?.[0] ?? '';
  assert.ok(handler, 'кнопка «Вставить из сеанса» подключена кликом');
  assert.match(handler, /navigator\.clipboard\.writeText/, 'запись буфера — только по явному клику');
  const writes = [...operatorJs.matchAll(/navigator\.clipboard\s*\.\s*writeText/g)].length;
  assert.equal(writes, 1, 'writeText встречается ровно один раз на странице');
  assert.match(operatorJs, /pendingClip = null;\n\s{2}hide\(\$\('btn-op-clip-paste'\)\)/, 'текст сеанса не переживает сеанс');
  assert.ok('web.clip.paste' in ru && 'web.clip.paste' in en, 'ключ кнопки в обоих словарях');
});

// ---- Волна C: арбитраж ввода (W-C4) + честный статус видеослотов (W-C5) ----

test('W-C4/W-C5: кнопки «Взять/Отдать управление» и статус подключены; служебный протокол по input-каналу', () => {
  // разметка: статус + обе кнопки (анти-мёртвые-кнопки выше проверят обработчики)
  for (const id of ['control-status', 'btn-take-control', 'btn-give-control']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `нет id «${id}» в web/operator.html`);
  }
  // служебные сообщения: оператор шлёт claim/release, слушает grants/session-info
  assert.match(operatorJs, /'claim-input'/, 'кнопка шлёт claim-input');
  assert.match(operatorJs, /'release-input'/, 'кнопка шлёт release-input');
  assert.match(operatorJs, /msg\.type === 'input-grant'[\s\S]{0,120}setControl/,
    'grant переключает статус управления');
  assert.match(operatorJs, /msg\.type === 'session-info' && msg\.video === false[\s\S]{0,120}setVideoStatus/,
    'честный статус занятых видеослотов (W-C5)');
  // гранты слушают ОБЕ роли (attended input-канал от хоста и machine созданный)
  const wired = [...operatorJs.matchAll(/wireControlChannel\(/g)].length;
  assert.ok(wired >= 2, `гранты слушают обе роли страницы (найдено ${wired})`);
  // сброс статуса при конце сеанса
  assert.match(operatorJs, /setControl\(null\)/, 'статус управления не переживает сеанс');
  // словарные ключи общие с desktop-оператором
  assert.ok('op.takeControl' in ru && 'op.giveControl' in ru, 'ключи кнопок в словарях');
  assert.ok('op.videoSlotsFull' in en, 'ключ видеослотов в en');
});
// ---- SEC-008: bearer только в памяти страницы, cookie — только роль ----

test('SEC-008: токен не хранится в cookie/sessionStorage — только переменная модуля', () => {
  const code = operatorJs.replace(/\/\/[^\n]*/g, ''); // проверяем код, не комментарии
  assert.ok(!code.includes('sessionStorage'), 'sessionStorage не используется');
  assert.ok(!code.includes('enot-op-token'), 'старый ключ хранения токена убран');
  assert.match(code, /let token = null/, 'токен живёт в памяти модуля');
  assert.ok(!/encodeURIComponent\(token\)/.test(code), 'токен не сериализуется в cookie');
  assert.match(code, /encodeURIComponent\(role\)/, 'в cookie пишется роль');
  assert.match(code, /ALLOWED_ROLES\.includes\(role\) \? role : null/, 'cookie читается только как роль из allowlist');
  assert.match(code, /const hadRole = Boolean\(readRoleCookie\(\)\)/, 'роль из cookie — только признак старой сессии: без токена в памяти честный вход заново');
  assert.match(code, /res\.status === 401 && hadToken/, '401 при живом bearer возвращает на форму входа, а не оставляет мёртвую сессию');
});

// ---- Приёмка C+D (16.10): лог чата не переживает конец сеанса ----
test('C+D (minor UI): лог чата чистится в обеих точках старта нового сеанса', () => {
  const points = operatorJs.match(/state\.connect = \{[^\n]*\n[^\n]*text\(\$\('op-chat-log'\), ''\)/g) ?? [];
  assert.ok(points.length >= 2,
    `лог чата (#op-chat-log) обязан очищаться при старте нового сеанса — форма подключения и claim машины (найдено ${points.length})`);
});

// ---- G1 (волна G, 16.10): карточка «Подключение коллег» машинного сеанса ----
test('G1: машинный claim показывает карточку «Подключение коллег» (ID+пароль); пароль не переживает сеанс', () => {
  for (const id of ['op-join-card', 'op-join-id', 'op-join-pass']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `нет id «${id}» в web/operator.html`);
  }
  assert.match(operatorJs, /showJoinCard\(sessionId, password\)/, 'карточка наполняется паролем из claim-ответа');
  assert.match(operatorJs, /function showConnectForm\(\)[\s\S]{0,400}hideJoinCard\(\)/, 'карточка гасится при разборе сеанса (пароль не переживает сеанс)');
  // копирование без clipboard-API (SEC-002: writeText на странице ровно один):
  // клик выделяет значение целиком — user-select:all + Range
  assert.match(operatorJs, /selectNodeContents/, 'выделение кликом вместо clipboard-API');
  assert.match(html, /user-select:all/, 'значение карточки выделяется целиком стилем');
});

// ---- Гигиена 19.10 (B2): вход в /operator с 2FA, паритет с desktop-оператором ----
test('B2: форма входа держит скрытое поле TOTP и шлёт код только после totp_required', () => {
  assert.match(html, /<div class="field hidden" id="field-login-totp">/, 'поле кода скрыто до ответа сервера');
  assert.match(html, /<input id="login-totp" name="totp" inputmode="numeric" autocomplete="one-time-code"/, 'поле кода — числовое, автозаполнение одноразового кода');
  const code = operatorJs.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /res\.status === 401 && res\.body\?\.error\?\.code === 'totp_required'/, 'ответ totp_required обрабатывается отдельно от прочих ошибок');
  assert.match(code, /show\(\$\('field-login-totp'\)\)/, 'по totp_required поле кода показывается');
  assert.match(code, /\$\('field-login-totp'\)\.classList\.contains\('hidden'\) \? '' :/, 'пока поле скрыто, код не отправляется');
  assert.match(code, /\.\.\.\(totp \? \{ totp \} : \{\}\)/, 'поле totp в теле запроса — только когда код введён');
  assert.match(code, /\$\('login-totp'\)\.value = '';\s*\n\s*hide\(\$\('field-login-totp'\)\)/, 'после входа одноразовый код стирается и поле прячется');
});

// ---- B6 этап 1 (19.10): паритет web с desktop — записи и режим аудитора ----
test('B6: разделы адресной книги, истории и журнала есть в разметке и в списке экранов', () => {
  for (const id of ['view-contacts', 'view-history', 'view-audit']) {
    assert.match(html, new RegExp(`<section id="${id}" class="card hidden">`), `раздел ${id} в разметке`);
    assert.match(operatorJs, new RegExp(`'${id}'`), `${id} в VIEWS — showOnly умеет его прятать`);
  }
  assert.match(html, /<select id="conn-contact"><\/select>/, 'выбор контакта в форме подключения (как desktop)');
});

test('B6: права разделов — как у сервера (контакты admin/operator, журнал admin/auditor, машины/команда admin)', () => {
  const code = operatorJs.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /const ALLOWED_ROLES = \['admin', 'operator', 'auditor'\]/, 'аудитор допускается на страницу');
  assert.match(code, /const CONNECT_ROLES = \['admin', 'operator'\]/, 'подключаются только admin/operator');
  assert.match(code, /\['btn-nav-machines', 'btn-nav-team', 'btn-nav-audit'\]\) \(role === 'admin' \? show : hide\)/, 'машины/команда/журнал из подключения — только admin');
  assert.match(code, /'btn-nav-contacts', 'btn-nav-history', 'conn-contact-field'/, 'адресная книга/история/выбор контакта — тем, кто подключается');
  assert.match(code, /\(role === 'admin' \|\| role === 'auditor' \? show : hide\)\(\$\('btn-history-audit'\)\)/, 'переход в журнал — admin и auditor');
  assert.match(code, /records\.showHistory\(\); \/?/, 'стартовый экран аудитора — история');
});

test('B6: подключение передаёт contactId из адресной книги только когда он выбран', () => {
  assert.match(operatorJs, /const contactId = \$\('conn-contact'\)\.value \|\| undefined;/);
  assert.match(operatorJs, /\{ password, \.\.\.\(contactId \? \{ contactId \} : \{\}\) \}/);
});

test('B6: модуль записей строит DOM через textContent и ходит в те же REST, что desktop', () => {
  const code = recordsJs.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/innerHTML/.test(code), 'пользовательские строки не попадают в HTML');
  for (const route of ["'/contacts'", "'/history'", "'/audit'"]) assert.ok(code.includes(route), `маршрут ${route}`);
  assert.match(code, /api\('PATCH', `\/contacts\/\$\{encodeURIComponent\(editing\.id\)\}`, \{ \.\.\.base, revision: editing\.revision \}\)/, 'правка с revision (409 — конфликт)');
  assert.match(code, /api\('DELETE', `\/contacts\/\$\{encodeURIComponent\(c\.id\)\}`, \{ revision: c\.revision \}\)/, 'удаление с revision');
  assert.match(code, /window\.confirm\(t\('contacts\.deleteConfirm'/, 'удаление — с явным подтверждением');
});

test('B6 этап 2: «запомнить меня» — только через мост окна desktop, в браузере поле скрыто', () => {
  assert.match(html, /<label class="check hidden" id="field-login-remember"><input type="checkbox" id="login-remember">/, 'поле скрыто по умолчанию');
  assert.match(html, /data-i18n="op.remember"/);
  assert.match(operatorJs, /const desk = typeof window\.enotOperator === 'object' && window\.enotOperator \? window\.enotOperator : null;/);
  // креды сохраняются только после успешного входа (в ветке успеха, после токена)
  const success = operatorJs.indexOf('token = res.body.token;');
  const remember = operatorJs.indexOf('rememberAfterLogin();');
  assert.ok(success > 0 && remember > success, 'rememberAfterLogin — после получения токена');
  assert.equal((operatorJs.match(/desk\.credentialsSave\(/g) ?? []).length, 1, 'одна точка сохранения');
  assert.match(operatorJs, /if \(!desk\) return;/, 'без моста — ничего не делаем');
  // в браузере window.enotOperator нет — страница не трогает storage ради паролей
  assert.ok(!/localStorage\.setItem\([^)]*(password|login)/i.test(allJs), 'пароли не в localStorage');
});

// G2 (приёмная сторона, перенесено из удалённого desktop-оператора, этап 3):
// сообщения коллеги (from:'operator') — «Оператор {имя}», хост и старые хосты
// без поля — «Клиент»; без имени — прежний ключ chat.operator.
test('G2: оператор-получатель подписывает коллегу «Оператор {имя}», хоста и легаси — «Клиент»', () => {
  assert.match(operatorJs, /if \(msg\.from === 'operator'\) appendChat\('operator', msg\.text, typeof msg\.name === 'string' \? msg\.name : ''\);\s*else appendChat\('client', msg\.text\);/);
  assert.match(operatorJs, /whoKey === 'operator' && opName \? t\('op\.messageBy', \{ name: opName \}\) : t\(`chat\.\$\{whoKey\}`\)/);
  for (const k of ['op.messageBy', 'chat.client', 'chat.operator']) assert.ok(k in ru && k in en, `ключ ${k}`);
});

test('B6 этап 3: раздел «Аккаунт» — смена пароля и 2FA тем же REST, что был у desktop', () => {
  assert.match(html, /<section id="view-account" class="card hidden">/);
  assert.match(operatorJs, /'view-account'/, 'раздел в списке экранов');
  assert.match(operatorJs, /show\(\$\('btn-nav-account'\)\); \/\/ аккаунт — у любой вошедшей роли/);
  assert.match(accountJs, /api\('PATCH', '\/auth\/password', \{ oldPassword: \$\('password-old'\)\.value, newPassword: \$\('password-new'\)\.value \}\)/);
  assert.match(accountJs, /api\('POST', '\/auth\/totp\/enable', \{ password \}\)/, 'шаг 1: секрет по паролю');
  assert.match(accountJs, /api\('POST', '\/auth\/totp\/enable', \{ password: totpSetupPassword, code:/, 'шаг 2: подтверждение кодом');
  assert.match(accountJs, /api\('POST', '\/auth\/totp\/disable', \{ password: \$\('totp-disable-password'\)\.value \}\)/);
  // пароль настройки и секрет не переживают уход из раздела
  assert.match(accountJs, /btn-account-back'\)\.addEventListener\('click', \(\) => \{\s*resetPassword\(\);\s*resetTotp\(\);/);
  assert.ok(!/innerHTML/.test(accountJs), 'DOM — только через textContent/value');
  assert.match(operatorJs, /account\.setUser\(res\.body\.user\)/, 'флаг 2FA — из ответа входа');
  assert.match(operatorJs, /account\.setUser\(user\)/, 'и из /auth/me после перезагрузки');
});

// ---- Владелец 20.10 (iPad): «Выйти» на экране входа ничего не делала ----
test('«Выйти» видна всегда: до входа уводит на /downloads, после входа — logout и форма входа', () => {
  assert.match(html, /<button id="btn-logout" class="btn ghost" type="button"/, 'кнопка не скрыта до входа');
  const code = operatorJs.replace(/\/\/[^\n]*/g, '');
  const handler = code.slice(code.indexOf("$('btn-logout')?.addEventListener"), code.indexOf("$('lang-select')"));
  assert.match(handler, /if \(!token\) \{\s*location\.assign\('\/downloads'\);\s*return;\s*\}/, 'без токена — на главную');
  assert.match(handler, /api\('POST', '\/auth\/logout'\)[\s\S]*forgetSession\(\);[\s\S]*location\.replace\('\/operator'\)/, 'с токеном — logout и форма входа');
  assert.ok(!/btn-logout'\)\?\.classList\.add\('hidden'\)/.test(code), 'forgetSession больше не прячет «Выйти»');
});

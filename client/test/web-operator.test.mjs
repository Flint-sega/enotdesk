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
const allJs = `${operatorJs}\n${inputJs}`;

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
    const wired = new RegExp(`\\$\\('${id}'\\)`).test(allJs);
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
  assert.match(operatorJs, /user\.role === 'admin'/, 'кнопку «Машины» показывает только роль admin');
  const paths = [...operatorJs.matchAll(/api\('(?:GET|POST|DELETE)',\s*(`[^`]*`|'[^']*')/g)].map((m) => m[1]);
  const machinePaths = paths.filter((p) => p.includes('/machines'));
  assert.ok(machinePaths.length >= 5, 'панель машин должна использовать machines API (список, claim, pin, revoke, delete, toast)');
  const allowed = [
    /^`\/machines\?[^`]*`$/, // список с пагинацией limit/offset
    /^`\/machines\/\$\{[^`]+\}\/(claim|pin|revoke|toast)`$/, // действия одной машины
    /^`\/machines\/\$\{[^`]+\}`$/, // GET/DELETE одной машины
  ];
  for (const p of machinePaths) {
    assert.ok(allowed.some((re) => re.test(p)), `неизвестный machines-маршрут: ${p}`);
  }
  // сообщение на экран (R08, T08) вызывается со страницы машин;
  // инвентарь приезжает в списке машин — отдельного inventory-вызова нет
  assert.ok(machinePaths.some((p) => /toast/.test(p)), 'toast-маршрут вызывается со страницы машин');
  assert.ok(!machinePaths.some((p) => /inventory/.test(p)), 'отдельного inventory-маршрута на странице нет');
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

// ---- SEC-008: bearer только в памяти страницы, cookie — только роль ----

test('SEC-008: токен не хранится в cookie/sessionStorage — только переменная модуля', () => {
  const code = operatorJs.replace(/\/\/[^\n]*/g, ''); // проверяем код, не комментарии
  assert.ok(!code.includes('sessionStorage'), 'sessionStorage не используется');
  assert.ok(!code.includes('enot-op-token'), 'старый ключ хранения токена убран');
  assert.match(code, /let token = null/, 'токен живёт в памяти модуля');
  assert.ok(!/encodeURIComponent\(token\)/.test(code), 'токен не сериализуется в cookie');
  assert.match(code, /encodeURIComponent\(role\)/, 'в cookie пишется роль');
  assert.match(code, /ALLOWED_ROLES\.includes\(role\) \? role : null/, 'cookie читается только как роль из allowlist');
  assert.match(code, /if \(readRoleCookie\(\)\)/, 'вариант UI при отсутствии токена выбирается по роли из cookie');
});

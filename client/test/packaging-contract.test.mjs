// Контракт упаковки (лаба 05.10): electronLanguages обязан содержать полные теги.
// История: electronLanguages [ru, en] — «en» не матчится ни с одним pak
// (нужен en-US), на Windows с любой не-ru локалью у клиента не оставалось ни
// одного языкового пака; ResourceBundle пуст, а рендерер падал Access Violation
// (0xC0000005) при создании <input type=file>/<details>/<video> — им нужны
// локализованные строки Chromium (кнопка «Browse», маркер details, медиа-панель).
// Симптом: пустое тёмное окно клиента, «locale resources are not loaded» в логе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const yml = readFileSync(fileURLToPath(new URL('../../build/electron-builder.yml', import.meta.url)), 'utf8');

function electronLanguages(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === 'electronLanguages:');
  if (start === -1) return null;
  const items = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^ {2}- /.test(l)) items.push(l.replace(/^ {2}- /, '').trim());
    else if (l.trim() === '' || l.trim().startsWith('#')) continue;
    else break;
  }
  return items.length ? items : null;
}

test('packaging: electronLanguages задан', () => {
  const langs = electronLanguages(yml);
  assert.ok(langs, 'в electron-builder.yml нет секции electronLanguages');
  assert.ok(langs.length >= 2, 'ожидаем минимум ru и en-US');
});

test('packaging: только полные теги локалей (ru, en-US), без голого en', () => {
  const langs = electronLanguages(yml);
  assert.ok(langs.includes('ru'), 'должен быть ru');
  assert.ok(langs.includes('en-US'), 'должен быть en-US (полный тег: голый «en» не матчится ни с одним pak)');
  assert.ok(!langs.includes('en'), 'голый «en» запрещён: pak называется en-US.pak, «en» молча выпадает из сборки');
});

// Профиль агента (приёмка 05.10, L1-б): Electron именует userData по name из
// package.json (enotdesk, строчные) — установщик обязан писать именно туда,
// иначе настройка службы молча не подхватывается; родители .config создаются
// mkdir'ом и целиком отдаются агенту (install -d оставлял .config за root).
const installSh = readFileSync(fileURLToPath(new URL('../agent-service/install-linux.sh', import.meta.url)), 'utf8');

test('packaging: install-linux.sh пишет профиль в ~/.config/enotdesk/agent', () => {
  assert.ok(installSh.includes('.config/enotdesk/agent'), 'путь профиля должен быть .config/enotdesk/agent (строчные)');
  assert.ok(!installSh.includes('EnotDesk/agent'), 'путь «EnotDesk/agent» мёртв: userData агента — enotdesk (строчные)');
});

test('packaging: install-linux.sh отдаёт .config агенту целиком', () => {
  assert.ok(/chown -R .*AGENT_USER.*AGENT_HOME\/\.config/.test(installSh), 'нужен chown -R на $AGENT_HOME/.config — install -d оставлял родителей за root');
});

// Юнит агента: hardening, проверенный в лабе на Debian 13 (05.10, drop-in
// переносится в продукт). Строки-маркеры обязаны быть в поставляемом unit.
const unit = readFileSync(fileURLToPath(new URL('../agent-service/enotdesk-agent.service', import.meta.url)), 'utf8');

test('packaging: enotdesk-agent.service содержит лабовый hardening', () => {
  for (const line of [
    'NoNewPrivileges=true',
    'UMask=0077',
    'PrivateDevices=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictSUIDSGID=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
  ]) {
    assert.ok(unit.includes(line), `в unit нет строки ${line}`);
  }
});

// main.mjs: проводка ozone-флага (Wayland-сессии, лаба 05.10) и always-on
// boot-лога — контракт на уровне текста: регрессия «убрал флаг/лог» ловится здесь.
const mainJs = readFileSync(fileURLToPath(new URL('../main.mjs', import.meta.url)), 'utf8');

test('packaging: main.mjs форсирует --ozone-platform=x11 на linux', () => {
  assert.match(mainJs, /process\.platform === 'linux' && !app\.commandLine\.hasSwitch\('ozone-platform'\)/, 'нужен гвард linux + уважение пользовательского флага');
  assert.match(mainJs, /appendSwitch\('ozone-platform', 'x11'\)/);
});

test('packaging: boot-лог always-on и покрывает жизненные события окна', () => {
  assert.match(mainJs, /createBootLog\(\{ userDataDir: app\.getPath\('userData'\) \}\)/, 'boot-лог создаётся на userData');
  for (const marker of [
    /render-process-gone[\s\S]{0,400}bootLog\.write\('win', `render-process-gone/,
    /did-fail-load \$\{code\} \$\{desc\} \$\{url\}`\);\s*\n\s*bootLog\.write/,
    /bootLog\.write\('main', 'app ready'\)/,
    /bootLog\.write\('main', `pid=/,
  ]) {
    assert.ok(marker.test(mainJs), `нет проводки boot-лога: ${marker}`);
  }
});

// Ревизия 06.10: принудительный --lang=en-US до ready запрещён — getLocale()
// до ready пустой У ВСЕХ, фолбэк срабатывал на каждом запуске и убивал ru.pak.
// Честный механизм — полный состав pak'ов (electronLanguages) + собственный
// фолбэк Chromium. Обратно не возвращать.
test('packaging: в main.mjs нет принудительного --lang (только pak-состав решает локаль)', () => {
  assert.ok(!mainJs.includes("appendSwitch('lang'"), 'appendSwitch(\'lang\', …) до ready — регрессия ревизии 06.10: getLocale() до ready всегда пустой');
});

// «Окно не молчит» (75a88d6): краш рендерера обязан иметь один автоперезапуск.
test('packaging: auto-reload после краша рендерера на месте', () => {
  const i1 = mainJs.indexOf('let rendererReloaded = false;');
  const i2 = mainJs.indexOf('auto-reload после краша рендерера');
  const i3 = mainJs.indexOf('win.webContents.reload()');
  assert.ok(i1 !== -1 && i2 > i1 && i3 > i2, 'нужна цепочка rendererReloaded → автоперезапуск → reload()');
});

// Этап 4 (06.10): хелпер с динамическим CRT умирает на Windows без VC++
// Redistributable (0xC0000135, молча) — сборка обязана быть со статическим CRT.
const releaseYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)), 'utf8');

test('packaging: хелпер собирается со статическим CRT', () => {
  assert.ok(releaseYml.includes('target-feature=+crt-static'), 'RUSTFLAGS crt-static обязателен в build-шаге хелпера');
});

// Этап 4 (06.10): portable-распаковка даёт exe хелпера SYSTEM-only ACL — спавн
// от консольного пользователя невозможен. main.mjs обязан копировать хелпер
// в ProgramData перед спавном.
test('packaging: main.mjs копирует хелпер в ProgramData\\EnotDesk\\helper', () => {
  assert.ok(mainJs.includes("'EnotDesk', 'helper'"), 'нужна копия хелпера в ProgramData (ACL портативной распаковки)');
});

// installer.nsh: жизненный цикл службы (живой инцидент 10.10.2026, v0.6.15:
// обновление выполняет деинсталлятор предыдущей версии — тот со времени
// v0.6.14 делает sc delete, и зачисленная машина оставалась без службы,
// потому что customInstall умел только ЗАПУСТИТЬ существующую). Контракт:
// customInstall умеет пересоздать службу по маркеру зачисления (профиль
// агента в systemprofile, видимый из 32-битного установщика через Sysnative),
// customUnInstall по-прежнему удаляет службу при настоящей деинсталляции.
const installerNsh = readFileSync(fileURLToPath(new URL('../../build/installer.nsh', import.meta.url)), 'utf8');

test('packaging: customInstall восстанавливает службу зачисленной машины', () => {
  assert.match(
    installerNsh,
    /IfFileExists "\$WINDIR\\Sysnative\\config\\systemprofile\\AppData\\Roaming\\EnotDesk\\agent\\\*\.\*" 0 ed_no_agent/,
    'маркер зачисления — профиль агента в systemprofile через Sysnative (x64-редирект 32-битного установщика)',
  );
  assert.match(installerNsh, /ed_agent_recreate:[\s\S]*sc\.exe create EnotDeskAgent binPath=/, 'нужна ветка пересоздания службы');
  assert.match(installerNsh, /sc\.exe create EnotDeskAgent binPath= \$\\"\$INSTDIR\\EnotDesk\.exe\$\\" start= delayed-auto obj= LocalSystem/, 'конфиг create = бинPath в $INSTDIR, delayed-auto, LocalSystem (ADR 0029/0026)');
  assert.ok(installerNsh.includes('/v Environment /t REG_MULTI_SZ /d "EDESK_AGENT=1\\0EDESK_AGENT_NAME='), 'Environment обязан нести EDESK_AGENT=1 + имя + EDESK_AGENT_SVC=1 (SCM-режим)');
  assert.match(installerNsh, /sc\.exe failure EnotDeskAgent reset= 86400 actions= restart\/5000\/restart\/10000\/restart\/30000/, 'failure-действия 5/10/30 с обязаны вернуться после пересоздания');
});

test('packaging: customUnInstall по-прежнему удаляет службу (настоящая деинсталляция)', () => {
  const un = installerNsh.slice(installerNsh.indexOf('!macro customUnInstall'));
  assert.match(un, /sc\.exe delete EnotDeskAgent/, 'без удаления служба оставалась бы висеть на удалённом каталоге');
});

test('packaging: внешние команды установщика — только по абсолютному $SYSDIR (ревью 10.10)', () => {
  const cmds = [...installerNsh.matchAll(/nsExec::Exec (.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
  assert.ok(cmds.length > 0, 'в installer.nsh есть nsExec-команды');
  for (const c of cmds) {
    assert.match(c, /^\$SYSDIR\\(sc|taskkill|reg)\.exe /, `команда должна начинаться с $SYSDIR\\… : ${c}`);
  }
});

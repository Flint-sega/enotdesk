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

test('packaging: main.mjs выбирает --ozone-platform на linux (x11, агент без DISPLAY — headless)', () => {
  assert.match(mainJs, /process\.platform === 'linux' && !app\.commandLine\.hasSwitch\('ozone-platform'\)/, 'нужен гвард linux + уважение пользовательского флага');
  assert.match(mainJs, /linuxOzonePlatform\(\{ agent: process\.env\.EDESK_AGENT === '1', env: process\.env \}\)/);
  assert.match(mainJs, /appendSwitch\('ozone-platform', ozone\)/);
});

test('ozone: клиент всегда x11; агент без DISPLAY/WAYLAND_DISPLAY — headless (лаба 22.10)', async () => {
  const { linuxOzonePlatform } = await import('../lib/ozone.mjs');
  assert.equal(linuxOzonePlatform({ agent: false, env: {} }), 'x11');
  assert.equal(linuxOzonePlatform({ agent: false, env: { WAYLAND_DISPLAY: 'wayland-0' } }), 'x11');
  assert.equal(linuxOzonePlatform({ agent: true, env: {} }), 'headless');
  assert.equal(linuxOzonePlatform({ agent: true, env: { DISPLAY: ':0' } }), 'x11');
  assert.equal(linuxOzonePlatform({ agent: true, env: { WAYLAND_DISPLAY: 'wayland-0' } }), 'x11');
});

test('packaging: main.mjs выключает слушатель mDNS у WebRTC (окно брандмауэра Windows, лаба 23.10)', () => {
  assert.match(mainJs, /getSwitchValue\('disable-features'\)/, 'чужие --disable-features сохраняются');
  assert.match(mainJs, /appendSwitch\('disable-features', withDisabledFeature\(current, WEBRTC_MDNS_FEATURE\)\)/);
  // флаг ставится до ветки службы и до ready — как ozone
  assert.ok(mainJs.indexOf('WEBRTC_MDNS_FEATURE))') < mainJs.indexOf("process.env.EDESK_AGENT_SVC === '1' && process.platform === 'win32'"));
});

test('chromium-features: имя функции и слияние --disable-features без потерь и повторов', async () => {
  const { WEBRTC_MDNS_FEATURE, withDisabledFeature } = await import('../lib/chromium-features.mjs');
  assert.equal(WEBRTC_MDNS_FEATURE, 'WebRtcHideLocalIpsWithMdns');
  assert.equal(withDisabledFeature('', WEBRTC_MDNS_FEATURE), 'WebRtcHideLocalIpsWithMdns');
  assert.equal(withDisabledFeature(undefined, 'A'), 'A');
  assert.equal(withDisabledFeature('Foo, Bar', 'A'), 'Foo,Bar,A');
  assert.equal(withDisabledFeature('A,Foo', 'A'), 'A,Foo');
});

test('install-linux.sh и install-macos.sh: регистрация по AGENT_CODE_FILE без кода в argv; http — с явной галочкой', () => {
  const macSh = readFileSync(fileURLToPath(new URL('../agent-service/install-macos.sh', import.meta.url)), 'utf8');
  assert.match(installSh, /AGENT_CODE_FILE="\$\{AGENT_CODE_FILE:-\}"/);
  assert.match(installSh, /EDESK_AGENT_CODE="\$\(head -n1 "\$AGENT_CODE_FILE"\)"[^\n]*\\\r?\n\s+runuser -u "\$AGENT_USER" -- "\$APP_DIR\/enotdesk"/, 'код — в окружении runuser, не аргументом');
  assert.match(installSh, /rm -f "\$AGENT_CODE_FILE"/, 'файл кода удаляется после регистрации');
  for (const [name, sh] of [['linux', installSh], ['macos', macSh]]) {
    assert.match(sh, /allowInsecureHttp/, `${name}: http-адрес без allowInsecureHttp агент молча заменял на 127.0.0.1`);
  }
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

// W-10 на ВМ 102 (24.10): после удаления оставались ссылка enotdesk:// на удалённый exe и
// кэш обновлений ~200 МБ. Убираются только при настоящем удалении, не при обновлении.
test('packaging: настоящее удаление убирает ссылку enotdesk:// и кэш обновлений, обновление — нет', () => {
  const un = installerNsh.slice(installerNsh.indexOf('!macro customUnInstall'));
  const guard = un.indexOf('${ifNot} ${isUpdated}');
  const end = un.indexOf('${endif}', guard);
  for (const line of ['DeleteRegKey HKCU "Software\\Classes\\enotdesk"', 'RMDir /r "$PROFILE\\AppData\\Local\\enotdesk-updater"']) {
    const at = un.indexOf(line);
    assert.ok(at > guard && at < end, `«${line}» — только внутри \${ifNot} \${isUpdated}`);
  }
  assert.doesNotMatch(un, /systemprofile/, 'профиль агента (токен машины) деинсталлятор не трогает — как remove-macos.sh без --purge-data');
});

test('packaging: внешние команды установщика — только по абсолютному $SYSDIR (ревью 10.10)', () => {
  const cmds = [...installerNsh.matchAll(/nsExec::Exec (.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
  assert.ok(cmds.length > 0, 'в installer.nsh есть nsExec-команды');
  for (const c of cmds) {
    assert.match(c, /^\$SYSDIR\\(sc|taskkill|reg)\.exe /, `команда должна начинаться с $SYSDIR\\… : ${c}`);
  }
});

// Диета asar (волна 0.6.19): серверно-почтовое дерево (imapflow/nodemailer —
// зависимости хаба) и чужие платформенные koffi-нативы не должны ездить в
// клиентские сборки. Регрессия «вернул жир» ловится здесь. Осторожно: sax и
// tiny-typed-emitter НУЖНЫ electron-updater (проверено npm ls) — их исключать
// нельзя, аPresence в keep-комментарии — контракт на комментарий.
test('packaging: asar-диета — почтовое дерево исключено, чужие koffi-нативы по платформам', () => {
  for (const pkg of ['imapflow', 'nodemailer', 'encoding-japanese', 'iconv-lite', 'libmime', 'libqp', 'libbase64', 'socks', 'smart-buffer', 'ip-address', 'safer-buffer', 'pino', 'thread-stream', 'sonic-boom', 'split2']) {
    assert.ok(yml.includes(`"!node_modules/${pkg}/**"`), `нет исключения ${pkg} (почтовое дерево в asar не нужно)`);
  }
  assert.ok(yml.includes('"!node_modules/@zone-eu/**"'), 'нет исключения @zone-eu (mailsplit из imapflow)');
  assert.ok(yml.includes('"!node_modules/@pinojs/**"'), 'нет исключения @pinojs');
  // платформенные files: ЗАПРЕЩЕНЫ — подмешивают дефолт **/*, и в asar уезжает
  // весь репозиторий (живой инцидент волны 0.6.19: helper 323 МБ + graphify-out
  // в mac-сборке). Чужие платформенные koffi-нативы (~1 МБ) — осознанная цена.
  for (const section of ['mac:', 'win:', 'linux:']) {
    const chunk = yml.slice(yml.indexOf(section));
    const nextSection = chunk.slice(1).search(/\n(mac|win|linux|nsis):/);
    const body = nextSection === -1 ? chunk : chunk.slice(0, nextSection + 1);
    assert.ok(!/^\s{2}files:/m.test(body), `в секции ${section} запрещён files: — затирает глобальный список (инцидент 0.6.19)`);
  }
  // критичное НЕ исключено: рантайм koffi и дерево electron-updater на месте
  assert.ok(yml.includes('"node_modules/koffi/src/koffi/*.cjs"'), 'реинклюд JS-рантайма koffi обязан остаться');
  assert.ok(!/["!]node_modules\/sax/.test(yml), 'sax нужен electron-updater (builder-util-runtime) — исключать нельзя');
  assert.ok(!/["!]node_modules\/tiny-typed-emitter/.test(yml), 'tiny-typed-emitter нужен electron-updater — исключать нельзя');
  assert.ok(!/["!]node_modules\/ws/.test(yml), 'ws — рантайм клиента (signal.mjs) — исключать нельзя');
});

// Волна 0.6.19: честное ограничение видео вне Windows (B2.1) и отложенный
// первый чек обновлений (A2).
test('packaging: видео вне Windows — честный video-unsupported-platform; первый чек апдейтов отложен', () => {
  assert.match(mainJs, /const videoSupported = process\.platform === 'win32';/, 'нужен платформенный гвард videoHost');
  assert.ok(mainJs.includes("'video-unsupported-platform'"), 'нужен точный reason для операторской панели (локализуется в web.video.unsupportedPlatform)');
  assert.match(mainJs, /firstUpdateCheck = setTimeout/, 'первый чек апдейтов уходит с критического пути старта');
  assert.match(mainJs, /}, 10_000\);/, 'задержка первого чека — 10 с');
});

// Аудит 12.10 (P3): svc-diag в видео-канале писал ТЕЛА событий ввода (JSON с
// клавишами — оператор мог набирать пароль на удалённой машине) в
// %ProgramData%/EnotDesk/svc-diag.log. Контракт: только тип события.
test('packaging: svc-diag не пишет тела ввода — только тип события', () => {
  assert.ok(!mainJs.includes('input msg: ${m.data'), 'логирование сырого тела ввода запрещено');
  assert.match(mainJs, /input msg: type=/, 'логируется только ev.type');
});

// 22.10.2026: при ОБНОВЛЕНИИ (старый деинсталлятор запускается с --updated)
// служба не удаляется — только останавливается, и её Environment (имя машины,
// выключатели вроде ENOT_VIDEO_ATTACH) переживает обновление.
test('packaging: при обновлении деинсталлятор не удаляет службу (isUpdated)', () => {
  const un = installerNsh.slice(installerNsh.indexOf('!macro customUnInstall'));
  const del = un.indexOf('sc.exe delete EnotDeskAgent');
  const guard = un.lastIndexOf('${ifNot} ${isUpdated}', del);
  assert.ok(guard > 0 && guard < del, 'sc delete — только внутри ${ifNot} ${isUpdated}');
  assert.ok(un.indexOf('${endif}', del) > del, 'ветка закрыта');
});

// Смоук собранной программы (ACCEPTANCE U-5): релиз не публикуется, пока
// упакованный EnotDesk на каждой ОС не поднял окно и не прошёл ворота ввода.
test('packaging: release.yml гоняет смоук собранной программы на трёх ОС до загрузки артефактов', () => {
  const rel = readFileSync(fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url)), 'utf8');
  const gate = rel.indexOf('Gate: смоук собранной программы');
  const upload = rel.indexOf('uses: actions/upload-artifact', gate);
  assert.ok(gate > 0 && upload > gate, 'шаг смоука стоит перед upload-artifact');
  for (const exe of ['dist/mac-arm64/EnotDesk.app/Contents/MacOS/EnotDesk', 'dist/win-unpacked/EnotDesk.exe', 'xvfb-run -a node scripts/smoke-artifact.mjs dist/linux-unpacked/enotdesk']) {
    assert.ok(rel.includes(exe), `release.yml: нет смоука «${exe}»`);
  }
  const pre = readFileSync(fileURLToPath(new URL('../../.github/workflows/build-pre.yml', import.meta.url)), 'utf8');
  assert.match(pre, /node scripts\/smoke-artifact\.mjs dist\/win-unpacked\/EnotDesk\.exe/);
});

test('smoke-artifact.mjs проверяет окно, ворота ввода, снимок и самостоятельный выход', () => {
  const script = readFileSync(fileURLToPath(new URL('../../scripts/smoke-artifact.mjs', import.meta.url)), 'utf8');
  for (const marker of ['SMOKE window: created', 'SMOKE gate closed before approved: true', 'SMOKE gate open after approved: true', 'SMOKE OK', "code === 0 && signal == null", 'EDESK_SMOKE_LOG']) {
    assert.ok(script.includes(marker), `smoke-artifact.mjs: нет проверки «${marker}»`);
  }
  assert.match(mainJs, /process\.env\.EDESK_SMOKE_LOG/, 'main.mjs пишет итог смоука в файл для CI');
});

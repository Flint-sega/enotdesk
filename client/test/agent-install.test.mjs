import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SVC_NAME,
  APP_EXE_STANDARD,
  RESULT_OK,
  safeCode,
  safeServerUrl,
  safeName,
  setupFeedUrl,
  resolveInstallSource,
  buildInstallScript,
} from '../lib/agent-install.mjs';

// Контракт генератора зеркалит client/agent-service/windows-install.bat
// (настройки LocalSystem без BOM, sc.exe, Environment+AppEnvironment, failure
// actions) с двумя отличиями ADR 0029: start= delayed-auto и одноразовый код
// во Environment с обязательной очисткой.

test('safeCode: латиница/цифры/-/_ длиной 8..300; прочее — null', () => {
  assert.equal(safeCode('NW7gXaz-ouh_MvD5V12fetGWhC2VUFlvRkuHyNB1jYg'), 'NW7gXaz-ouh_MvD5V12fetGWhC2VUFlvRkuHyNB1jYg');
  assert.equal(safeCode('  abc-123_XY  '), 'abc-123_XY', 'обрезаем пробелы по краям');
  for (const bad of ['', 'short7', null, undefined, 42, 'с кириллицей', 'a;b', 'a&b', 'a|b', 'a"b', 'a\nb', 'a%b', 'a b', 'x'.repeat(301)]) {
    assert.equal(safeCode(bad), null, String(bad)?.slice(0, 20));
  }
});

test('safeServerUrl: http(s) хост[:порт][/путь] без cmd-опасных символов', () => {
  assert.equal(safeServerUrl('https://support.ruenot.site'), 'https://support.ruenot.site');
  assert.equal(safeServerUrl('http://192.168.100.174:8080'), 'http://192.168.100.174:8080');
  assert.equal(safeServerUrl('  https://enot.example.com/base/path  '), 'https://enot.example.com/base/path');
  for (const bad of ['', null, 'ftp://x', 'javascript:alert(1)', 'https://a.b/?x=1&y=2', 'http://a.b/p ath', 'https://a.b/%22', 'https://a.b/x^y', 'не url']) {
    assert.equal(safeServerUrl(bad), null, String(bad));
  }
});

test('safeName: имя компьютера/машины 1..60 из безопасных символов', () => {
  assert.equal(safeName('DESKTOP-A1'), 'DESKTOP-A1');
  assert.equal(safeName('enot pc_01'), 'enot pc_01');
  assert.equal(safeName(''), null);
  assert.equal(safeName('a'.repeat(61)), null);
  assert.equal(safeName('a&b'), null);
});

test('setupFeedUrl: setup.exe из релиз-фида репозитория', () => {
  assert.equal(setupFeedUrl(), 'https://github.com/Flint-sega/enotdesk/releases/latest/download/EnotDesk-win-x64-setup.exe');
  assert.equal(setupFeedUrl({ owner: 'o', repo: 'r' }), 'https://github.com/o/r/releases/latest/download/EnotDesk-win-x64-setup.exe');
});

test('resolveInstallSource: портативка -> скачать setup; Program Files -> локально; прочее -> null', () => {
  const dl = resolveInstallSource({ execPath: 'C:\\Users\\u\\AppData\\Local\\Temp\\.mount\\EnotDesk.exe', portableFile: 'C:\\Downloads\\EnotDesk-win-x64.exe' });
  assert.equal(dl.mode, 'download');
  assert.equal(dl.setupUrl, 'https://github.com/Flint-sega/enotdesk/releases/latest/download/EnotDesk-win-x64-setup.exe');

  const local = resolveInstallSource({ execPath: 'C:\\Program Files\\EnotDesk\\EnotDesk.exe', portableFile: '' });
  assert.deepEqual(local, { mode: 'local', appExe: 'C:\\Program Files\\EnotDesk\\EnotDesk.exe' });

  const localFwd = resolveInstallSource({ execPath: 'c:/program files/enotdesk/enotdesk.exe', portableFile: '' });
  assert.equal(localFwd.mode, 'local');

  assert.equal(resolveInstallSource({ execPath: 'D:\\any\\EnotDesk.exe', portableFile: '' }), null);
  assert.equal(resolveInstallSource({ execPath: '', portableFile: '' }), null);
});

const BASE = { serverUrl: 'https://support.ruenot.site', code: 'abcd-1234_XYZ9', agentName: 'DESKTOP-A1', setupExe: 'C:\\Temp\\EnotDesk-win-x64-setup.exe' };

test('генератор: setup /S + ожидание файла, стандартный путь приложения', () => {
  const s = buildInstallScript(BASE);
  assert.match(s, /"%SETUP_EXE%" \/S/);
  assert.match(s, /:wait-setup/);
  assert.match(s, /if %TRIES% lss 90 goto :wait-setup/);
  assert.ok(s.includes(`set "APP_EXE=${APP_EXE_STANDARD}"`), 'приложение ставится в стандартный путь Program Files');
  assert.ok(!s.includes('set "APP_EXE=C:\\Temp'), 'путь setup-файла не становится путём приложения');
});

test('генератор: локальный источник — без setup-шага', () => {
  const s = buildInstallScript({ ...BASE, setupExe: '', appExe: 'C:\\Program Files\\EnotDesk\\EnotDesk.exe' });
  assert.ok(!s.includes(':wait-setup'), 'блока тихой установки нет');
  assert.ok(!s.includes('"%SETUP_EXE%" /S'));
  assert.ok(s.includes('set "APP_EXE=C:\\Program Files\\EnotDesk\\EnotDesk.exe"'));
});

test('генератор: настройки LocalSystem без BOM + права по well-known SID', () => {
  const s = buildInstallScript(BASE);
  assert.match(s, /systemprofile\\AppData\\Roaming\\EnotDesk\\agent/);
  assert.match(s, /WriteAllText/);
  assert.match(s, /\*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(s, /\*S-1-5-32-544:\(OI\)\(CI\)F/);
  assert.ok(s.includes('set "SERVER_URL=https://support.ruenot.site"'));
  assert.match(s, /serverUrl='%SERVER_URL%'/);
});

test('генератор: служба delayed-auto, идемпотентный create/config, failure actions', () => {
  const s = buildInstallScript(BASE);
  assert.equal(s.match(/start= delayed-auto/g)?.length, 2, 'create и config');
  assert.match(s, /binPath= "\\"%APP_EXE%\\""/);
  assert.match(s, new RegExp(`sc\\.exe create "%SVC_NAME%" .* DisplayName= "EnotDesk Agent"`));
  assert.match(s, /sc\.exe failure "%SVC_NAME%" reset= 86400 actions= restart\/5000\/restart\/10000\/restart\/30000/);
  assert.equal(s.includes(`set "SVC_NAME=${SVC_NAME}"`), true);
});

test('генератор: одноразовый код во временных env и обязательная очистка', () => {
  const s = buildInstallScript(BASE);
  assert.ok(s.includes('set "AGENT_CODE=abcd-1234_XYZ9"'), 'значение кода — одной строкой set');
  assert.ok(s.includes('set "ENV_SET=%ENV_BASE%\\0EDESK_AGENT_CODE=%AGENT_CODE%"'), 'код добавляется к env службы условно');
  assert.ok(s.includes('if not "%AGENT_CODE%"=="" set "ENV_SET='), 'без кода env чистый (апгрейд без регистрации)');
  const regAdds = s.match(/reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\EnotDeskAgent" \/v (Environment|AppEnvironment) \/t REG_MULTI_SZ/g)?.length ?? 0;
  assert.equal(regAdds, 4, 'по два на Environment/AppEnvironment: с кодом и очистка без');
  assert.match(s, /:cleanup-env/);
  assert.match(s, /if %WAITN% lss 10 goto :wait-run/, 'граница ожидания старта службы 10×2 с');
  assert.match(s, /ENOT_INSTALL_RESULT=FAIL start/);
  const cleanupIdx = s.indexOf(':cleanup-env');
  const failIdx = s.indexOf('ENOT_INSTALL_RESULT=FAIL register-timeout');
  const okIdx = s.indexOf(RESULT_OK);
  assert.ok(cleanupIdx > -1 && failIdx > cleanupIdx && okIdx > cleanupIdx, 'очистка кода стоит до любого результата');
  assert.match(s, /agent-token\.json/);
});

test('генератор: маркеры результата ASCII и завершение после очистки', () => {
  const s = buildInstallScript(BASE);
  assert.match(s, /ENOT_INSTALL_RESULT=OK/);
  for (const fail of ['setup', 'setup-timeout', 'no-app-exe', 'settings', 'start', 'register-timeout', 'sc']) {
    assert.ok(s.includes(`ENOT_INSTALL_RESULT=FAIL ${fail}`), fail);
  }
  // CRLF обязателен: goto/метки cmd ненадёжны с LF (ревью ADR 0029 P1-1)
  assert.ok(!/(?<!\r)\n/.test(s), 'только CRLF-окончания');
  // маркер и весь скрипт — ASCII (парсится main-процессом независимо от кодовой страницы);
  // посимвольная проверка вместо регэкспа — eslint no-control-regex (ревью ADR 0029 P0-1)
  assert.ok([...s].every((ch) => (ch.codePointAt(0) ?? 0) <= 0x7F), 'скрипт только ASCII');
});

test('генератор: валидация входа — мусор отклоняется до текста скрипта', () => {
  assert.throws(() => buildInstallScript({ ...BASE, serverUrl: 'https://a.b/?x=1&y=2' }), /invalid-server-url/);
  assert.throws(() => buildInstallScript({ ...BASE, code: 'a&b' }), /invalid-code/);
  assert.throws(() => buildInstallScript({ ...BASE, svcName: 'bad name&' }), /invalid-svc-name/);
  assert.throws(() => buildInstallScript({ ...BASE, svcName: 'x'.repeat(61) }), /invalid-svc-name/);
  assert.throws(() => buildInstallScript({ ...BASE, setupExe: '', appExe: '' }), /invalid-source/);
  assert.throws(() => buildInstallScript({ ...BASE, setupExe: 'C:\\x.exe', appExe: 'C:\\y.exe' }), /invalid-source/);
  assert.throws(() => buildInstallScript({ ...BASE, setupExe: '', appExe: 'C:\\Pro&gram\\e.exe' }), /invalid-appExe/);
});

test('генератор: плохое имя машины не роняет установку — безопасный дефолт PC', () => {
  const s = buildInstallScript({ ...BASE, agentName: 'a&b' });
  assert.ok(s.includes('set "AGENT_NAME=PC"'), 'мусорное имя заменяется нейтральным');
  const long = buildInstallScript({ ...BASE, agentName: 'a'.repeat(61) });
  assert.ok(long.includes('set "AGENT_NAME=PC"'));
});

test('генератор: символы входа не ломают пакетный синтаксис (нет cmd-метасимволов в значениях)', () => {
  const s = buildInstallScript(BASE);
  for (const line of s.split('\n')) {
    if (line.startsWith('set "SERVER_URL=')) {
      assert.ok(!/[&|^<>"]/.test(line.slice('set "SERVER_URL='.length, -2)), line);
    }
  }
});

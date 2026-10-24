import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { protocolTarget } from '../lib/protocol-handler.mjs';

// A-10 на ВМ 102 (24.10): портатив регистрировал enotdesk:// на временную распаковку
// (%TEMP%\<случайно>\EnotDesk.exe), она удаляется при выходе — ссылки вели в никуда.
test('protocolTarget: установленная версия и не-Windows — как раньше (process.execPath)', () => {
  assert.equal(protocolTarget({ platform: 'win32', env: {} }), null);
  assert.equal(protocolTarget({ platform: 'darwin', env: { PORTABLE_EXECUTABLE_FILE: '/x' } }), null);
  assert.equal(protocolTarget({ platform: 'linux', env: { PORTABLE_EXECUTABLE_FILE: '/x' } }), null);
});

test('protocolTarget: портатив рядом с установленной — ссылка на установленную', () => {
  const env = { PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\u\\Downloads\\EnotDesk-win-x64.exe', ProgramW6432: 'C:\\Program Files' };
  const seen = [];
  const exists = (p) => { seen.push(p); return p === 'C:\\Program Files\\EnotDesk\\EnotDesk.exe'; };
  assert.equal(protocolTarget({ platform: 'win32', env, exists }), 'C:\\Program Files\\EnotDesk\\EnotDesk.exe');
  assert.deepEqual(seen, ['C:\\Program Files\\EnotDesk\\EnotDesk.exe']);
});

test('protocolTarget: портатив без установленной — сам файл портатива, не временная копия', () => {
  const env = { PORTABLE_EXECUTABLE_FILE: 'D:\\tools\\EnotDesk.exe', ProgramFiles: 'C:\\Program Files' };
  assert.equal(protocolTarget({ platform: 'win32', env, exists: () => false }), 'D:\\tools\\EnotDesk.exe');
});

test('main.mjs регистрирует enotdesk:// через protocolTarget; установщик пишет HKLM, удаление снимает', () => {
  const mainJs = readFileSync(fileURLToPath(new URL('../main.mjs', import.meta.url)), 'utf8');
  assert.match(mainJs, /protocolTarget\(\{ platform: process\.platform, env: process\.env, exists: fs\.existsSync \}\)/);
  assert.match(mainJs, /setAsDefaultProtocolClient\('enotdesk', protocolExe, \[\]\)/);
  const nsh = readFileSync(fileURLToPath(new URL('../../build/installer.nsh', import.meta.url)), 'utf8');
  const install = nsh.slice(nsh.indexOf('!macro customInstall'), nsh.indexOf('!macro customUnInstall'));
  assert.match(install, /WriteRegStr HKLM "Software\\Classes\\enotdesk\\shell\\open\\command" "" '"\$INSTDIR\\EnotDesk\.exe" "%1"'/);
  assert.match(install, /WriteRegStr HKLM "Software\\Classes\\enotdesk" "URL Protocol" ""/);
  const un = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  const guard = un.indexOf('${ifNot} ${isUpdated}');
  const del = un.indexOf('DeleteRegKey HKLM "Software\\Classes\\enotdesk"');
  assert.ok(guard > 0 && del > guard && del < un.indexOf('${endif}', guard), 'HKLM снимается только при настоящем удалении');
});

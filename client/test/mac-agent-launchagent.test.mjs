import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ADR 0038: Mac-агент — LaunchAgent в графическом сеансе пользователя (видео и
// ввод доступны только там), установка без sudo, код регистрации — из файла.

const root = path.join(import.meta.dirname, '..', '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

test('plist агента: LaunchAgent сеанса Aqua, автозапуск и перезапуск', () => {
  const plist = read('client/agent-service/com.enotdesk.agent.plist');
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>EDESK_AGENT<\/key>\s*<string>1<\/string>/);
  assert.doesNotMatch(plist, /EDESK_AGENT_CODE/, 'код регистрации не живёт в plist');
});

test('install-macos.sh: без sudo, в LaunchAgents пользователя, код — из файла', () => {
  const sh = read('client/agent-service/install-macos.sh');
  assert.match(sh, /if \[ "\$\(id -u\)" -eq 0 \]; then/, 'отказ под root');
  assert.match(sh, /PLIST_DST="\$HOME\/Library\/LaunchAgents\/\$LABEL\.plist"/);
  assert.match(sh, /launchctl bootstrap "gui\/\$\(id -u\)"/);
  assert.match(sh, /EDESK_AGENT_CODE="\$\(head -n1 "\$AGENT_CODE_FILE"\)"/, 'код читается из файла, не из аргументов');
  assert.match(sh, /rm -f "\$AGENT_CODE_FILE"/, 'файл кода удаляется после регистрации');
  assert.doesNotMatch(sh, /LaunchDaemons\/\$LABEL\.plist" *$/m);
});

test('main: захват в мосту и ввод агента включены и на macOS (ADR 0038)', () => {
  const main = read('client/main.mjs');
  assert.match(main, /const BRIDGE_CAPTURE = \(process\.platform === 'linux' \|\| process\.platform === 'darwin'\) && process\.env\.EDESK_AGENT_VIDEO !== 'off';/);
  assert.match(main, /const gdmVideo = BRIDGE_CAPTURE;/);
  assert.match(main, /\(process\.platform === 'linux' \|\| process\.platform === 'darwin'\) \? createAgentInputSink\(/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConsoleUser } from '../lib/console-user.mjs';
import { spawnShellFor } from '../lib/term.mjs';

// SEC-001: агент-служба на Linux работает от root; без резолва консольного
// пользователя spawnShellFor поднимал бы root-shell. Резолв — по паттерну
// notify.mjs (getent passwd, первый uid>=1000); macOS — /dev/console.
// Ожидаемые значения разобраны вручную из формата /etc/passwd.

const GETENT = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'ivan:x:1000:1000:Ivan,,,:/home/ivan:/bin/bash',
  'svc:x:1500:1500:svc:/home/svc:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
].join('\n');

test('linux: getent passwd → первый uid>=1000, и он доезжает до spawnShellFor', () => {
  const calls = [];
  const spawnSync = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: GETENT }; };
  const u = resolveConsoleUser({ platform: 'linux', spawnSync });
  assert.deepEqual(u, { user: 'ivan', uid: 1000 });
  assert.deepEqual(calls, [['getent', 'passwd']]);
  // шов с терминалом: резолв действительно меняет контекст оболочки на пользователя
  const shell = spawnShellFor('linux', { consoleUser: u.user, uid: u.uid });
  assert.equal(shell.context, 'ivan');
  assert.deepEqual(shell.args, ['-u', 'ivan', 'bash']);
});

test('linux: только системные uid<1000 — null (честный контекст service)', () => {
  const spawnSync = () => ({ status: 0, stdout: 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n' });
  assert.equal(resolveConsoleUser({ platform: 'linux', spawnSync }), null);
});

test('linux: getent недоступен/упал — null, не throw', () => {
  assert.equal(resolveConsoleUser({ platform: 'linux', spawnSync: () => { throw new Error('no getent'); } }), null);
  assert.equal(resolveConsoleUser({ platform: 'linux', spawnSync: () => ({ status: 2, stdout: '' }) }), null);
});

test('darwin: uid берётся у /dev/console, имя — у id -un', () => {
  const calls = [];
  const spawnSync = (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd === 'stat' ? { status: 0, stdout: '501\n' } : { status: 0, stdout: 'masha\n' };
  };
  const u = resolveConsoleUser({ platform: 'darwin', spawnSync });
  assert.deepEqual(u, { user: 'masha', uid: 501 });
  assert.deepEqual(calls, [['stat', '-f', '%u', '/dev/console'], ['id', '-un', '501']]);
  // шов с терминалом: launchctl asuser <uid> именно с этим uid
  const shell = spawnShellFor('darwin', { consoleUser: u.user, uid: u.uid });
  assert.equal(shell.context, 'masha');
  assert.deepEqual(shell.args, ['asuser', '501', '/bin/zsh']);
});

test('darwin: uid не удалось прочесть (экран входа) — null; id -un упал — имя честно числом', () => {
  const noConsole = resolveConsoleUser({ platform: 'darwin', spawnSync: (cmd) => (cmd === 'stat' ? { status: 0, stdout: '0\n' } : { status: 0, stdout: '' }) });
  assert.equal(noConsole, null);
  const noName = resolveConsoleUser({ platform: 'darwin', spawnSync: (cmd) => (cmd === 'stat' ? { status: 0, stdout: '501\n' } : { status: 1, stdout: '' }) });
  assert.deepEqual(noName, { user: '501', uid: 501 });
});

test('win32 и прочие платформы — null (контекст SYSTEM решает spawnShellFor)', () => {
  const loud = () => { throw new Error('не должен вызываться'); };
  assert.equal(resolveConsoleUser({ platform: 'win32', spawnSync: loud }), null);
  assert.equal(resolveConsoleUser({ platform: 'freebsd', spawnSync: loud }), null);
  assert.equal(spawnShellFor('win32').context, 'SYSTEM');
});

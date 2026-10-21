// session-spawn (ADR 0027): спавн хелпера в консольном сеансе на моке koffi.
// Цепочка по живой диагностике (diag-spawn.cjs): WTSGetActiveConsoleSessionId →
// WTSQueryUserToken → CreateProcessAsUserW (_Inout_ StartupInfo / _Out_ ProcessInfo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSpawner } from '../lib/session-spawn.mjs';

function makeKoffi(script) {
  const calls = [];
  const koffiMock = {
    calls,
    load(dll) {
      calls.push(['load', dll]);
      return {
        func(sig) {
          // имя функции: первый идентификатор, за которым сразу '('
          const name = /([A-Za-z_]\w*)\s*\(/.exec(sig)?.[1] ?? sig;
          calls.push(['decl', name]);
          return (...args) => {
            calls.push([name, ...args]);
            switch (name) {
              case 'WTSGetActiveConsoleSessionId':
                return script.sessionId;
              case 'WTSQueryUserToken':
                if (script.tokenOk === false) return false;
                args[1].writeUInt32LE(script.tokenHandle ?? 0xdeadbeef, 0);
                return true;
              case 'CloseHandle':
                (script.closed ??= []).push(args[0]);
                return true;
              case 'GetCurrentProcess':
                return 0xffff;
              case 'OpenProcessToken':
                if (script.ownOk === false) return false;
                args[2].writeUInt32LE(0x5151, 0);
                return true;
              case 'DuplicateTokenEx':
                if (script.dupOk === false) return false;
                args[5].writeUInt32LE(0x5252, 0);
                return true;
              case 'SetTokenInformation':
                script.gotSession = args[2].readUInt32LE(0);
                script.gotClass = args[1];
                return script.setOk !== false;
              case 'CreateProcessAsUserW': {
                const si = args[9];
                const pi = args[10];
                script.gotSi = si;
                script.gotToken = args[0];
                if (script.spawnOk === false) return false;
                pi.dwProcessId = script.spawnPid ?? 4242;
                return true;
              }
              default:
                throw new Error(`мок: неожиданная функция ${name}`);
            }
          };
        },
      };
    },
    struct(name) {
      calls.push(['struct', name]);
      return { name }; // TypeObject, не конструктор (как реальный koffi 3.2.1)
    },
    sizeof() {
      return 104; // StartupInfoW x64, точность не важна — поле просто пишется
    },
    decode(buf) {
      return Number(buf.readBigUInt64LE(0));
    },
  };
  return { koffiMock, calls };
}

const SCRIPT = { sessionId: 1, spawnPid: 4242 };

test('happy path: токен сеанса → процесс создан с pid, cb и lpDesktop заполнены', async () => {
  const script = { ...SCRIPT, cursor: 0 };
  const { koffiMock, calls } = makeKoffi(script);
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'C:\\x\\helper.exe', commandLine: '"C:\\x\\helper.exe" --token abc' });
  assert.deepEqual(r, { ok: true, pid: 4242 });

  const create = calls.find(([n]) => n === 'CreateProcessAsUserW');
  assert.ok(create, 'CreateProcessAsUserW вызван');
  // create = ['CreateProcessAsUserW', token, exe, cmd, pa, ta, inherit, flags, env, dir, si, pi]
  assert.equal(create[1], 0xdeadbeef, 'токен из WTSQueryUserToken (декодирован из буфера)');
  assert.ok(create[2].toString('utf16le').includes('helper.exe'), 'exe в lpApplicationName');
  assert.equal(create[7], 0x408, 'DETACHED_PROCESS|CREATE_UNICODE_ENVIRONMENT');
  assert.equal(script.gotSi.cb, 104, 'cb = sizeof(StartupInfoW)');
  assert.ok(script.gotSi.lpDesktop.length > 4, 'lpDesktop — буфер winsta0\\default');
});

test('нет активной консольной сессии — честный no-active-session', async () => {
  const { koffiMock } = makeKoffi({ ...SCRIPT, sessionId: 0xFFFFFFFF });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
  assert.deepEqual(r, { ok: false, reason: 'no-active-session' });
});

test('WTSQueryUserToken отказал — token-failed', async () => {
  const { koffiMock } = makeKoffi({ ...SCRIPT, tokenOk: false });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
  assert.deepEqual(r, { ok: false, reason: 'token-failed' });
});

test('CreateProcessAsUserW отказал — create-failed', async () => {
  const { koffiMock } = makeKoffi({ ...SCRIPT, spawnOk: false });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
  assert.deepEqual(r, { ok: false, reason: 'create-failed' });
});

test('мусорные аргументы и отсутствие koffi — честные отказы', async () => {
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: null });
  assert.deepEqual(await spawnInConsoleSession({ exePath: 'x', commandLine: 'x' }), { ok: false, reason: 'koffi-unavailable' });
  const { koffiMock } = makeKoffi({ ...SCRIPT });
  const spawner = createSessionSpawner({ koffi: koffiMock });
  assert.deepEqual(await spawner.spawnInConsoleSession({ commandLine: 'x' }), { ok: false, reason: 'bad-exe' });
  assert.deepEqual(await spawner.spawnInConsoleSession({ exePath: 'x' }), { ok: false, reason: 'bad-commandline' });
});

// ---- ADR 0036: SYSTEM в консольном сеансе ----

test('tokenMode system: свой токен → DuplicateTokenEx → TokenSessionId сеанса → спавн', async () => {
  const script = { ...SCRIPT, sessionId: 3 };
  const { koffiMock, calls } = makeKoffi(script);
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock, tokenMode: 'system' });
  const r = await spawnInConsoleSession({ exePath: 'C:\\x\\helper.exe', commandLine: 'x --token abc' });
  assert.deepEqual(r, { ok: true, pid: 4242, token: 'system' });
  assert.equal(script.gotToken, 0x5252, 'процесс создан дубликатом токена службы');
  assert.equal(script.gotClass, 12, 'TokenSessionId');
  assert.equal(script.gotSession, 3, 'номер консольного сеанса записан в токен');
  assert.ok(!calls.some(([n]) => n === 'WTSQueryUserToken'), 'токен пользователя не нужен');
  assert.ok(script.closed.includes(0x5151) && script.closed.includes(0x5252), 'оба токена закрыты');
});

test('tokenMode system: сбой SetTokenInformation — честный откат на токен пользователя', async () => {
  const warns = [];
  const script = { ...SCRIPT, setOk: false };
  const { koffiMock } = makeKoffi(script);
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock, tokenMode: 'system', log: { warn: (m) => warns.push(m) } });
  const r = await spawnInConsoleSession({ exePath: 'C:\\x\\helper.exe', commandLine: 'x --token abc' });
  assert.deepEqual(r, { ok: true, pid: 4242, token: 'user' });
  assert.equal(script.gotToken, 0xdeadbeef, 'процесс создан токеном пользователя');
  assert.ok(script.closed.includes(0x5252), 'неудавшийся дубликат закрыт');
  assert.match(warns.join(' '), /откат на токен пользователя/);
});

test('tokenMode system без вошедшего пользователя: SYSTEM работает, токен пользователя не нужен', async () => {
  const script = { ...SCRIPT, tokenOk: false };
  const { koffiMock } = makeKoffi(script);
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock, tokenMode: 'system' });
  const r = await spawnInConsoleSession({ exePath: 'C:\\x\\helper.exe', commandLine: 'x --token abc' });
  assert.equal(r.ok, true, 'экран входа без пользователя — хелпер всё равно запускается');
});

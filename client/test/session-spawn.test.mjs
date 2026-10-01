// session-spawn (ADR 0027): спавн хелпера в консольном сеансе на моке koffi.
// Проверяется сама цепочка: сессия → winlogon по сеансу → токен → CreateProcessAsUserW,
// и честные отказы на каждом звене.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionSpawner } from '../lib/session-spawn.mjs';

// Мок koffi 3: load→func по сигнатуре, struct→конструктор, sizeof, decode.
// Сценарий передаётся объектом; каждый Win32-вызов пишется в calls для ассертов.
function makeKoffi(script) {
  const calls = [];
  const makeEntryClass = () => class {
    constructor() {
      this.dwSize = 0;
      this.cntUsage = 0;
      this.th32ProcessID = 0;
      this.th32DefaultHeapID = 0n;
      this.th32ModuleID = 0;
      this.cntThreads = 0;
      this.th32ParentProcessID = 0;
      this.pcPriClassBase = 0;
      this.dwFlags = 0;
      this.szExeFile = new Array(260).fill(0);
    }
  };
  const koffiMock = {
    calls,
    load(dll) {
      calls.push(['load', dll]);
      return {
        func(sig) {
          // имя функции: первый идентификатор, за которым сразу '('
          // (учитывает 'void *Name'; параметры идут после первой скобки)
          const name = /([A-Za-z_]\w*)\s*\(/.exec(sig)?.[1] ?? sig;
          calls.push(['decl', name]);
          return (...args) => {
            calls.push([name, ...args]);
            switch (name) {
              case 'WTSGetActiveConsoleSessionId':
                return script.sessionId;
              case 'CreateToolhelp32Snapshot':
                return script.snapshot ?? { tag: 'snapshot' };
              case 'Process32FirstW':
              case 'Process32NextW': {
                const entry = args[1];
                const list = script.processes ?? [];
                if (name === 'Process32FirstW') script.cursor = 0;
                if (script.cursor >= list.length) return false;
                const p = list[script.cursor];
                script.cursor += 1;
                entry.th32ProcessID = p.pid;
                const nameUnits = [...p.name].map((c) => c.charCodeAt(0));
                entry.szExeFile = [...nameUnits, 0];
                return true;
              }
              case 'ProcessIdToSessionId':
                args[1].writeUInt32LE(script.pidSessions?.[args[0]] ?? 0, 0);
                return true;
              case 'CloseHandle':
                return true;
              case 'OpenProcess':
                return script.openOk === false ? null : { tag: 'proc', pid: args[2] };
              case 'OpenProcessToken':
                if (script.tokenOk === false) return false;
                args[2].writeUInt32LE(script.tokenHandle ?? 0xdeadbeef, 0);
                return true;
              case 'CreateProcessAsUserW': {
                const pi = args[10];
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
      return makeEntryClass(); // один класс на все структуры — тесту достаточно
    },
    sizeof() {
      return 568; // PROCESSENTRY32W x64, точность не важна — поле просто пишется
    },
    decode(buf) {
      return Number(buf.readBigUInt64LE(0));
    },
  };
  return { koffiMock, calls };
}

const SCRIPT = {
  sessionId: 1,
  processes: [
    { pid: 100, name: 'csrss.exe' },
    { pid: 200, name: 'winlogon.exe' },
    { pid: 300, name: 'explorer.exe' },
  ],
  pidSessions: { 100: 1, 200: 1, 300: 1 },
};

test('happy path: winlogon сеанса найден, токен открыт, процесс создан с pid', async () => {
  const { koffiMock, calls } = makeKoffi({ ...SCRIPT, spawnPid: 4242, cursor: 0 });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'C:\\x\\helper.exe', commandLine: '"C:\\x\\helper.exe"' });
  assert.deepEqual(r, { ok: true, pid: 4242 });
  const create = calls.find(([n]) => n === 'CreateProcessAsUserW');
  assert.ok(create, 'CreateProcessAsUserW вызван');
  // create = ['CreateProcessAsUserW', token, exe, cmd, pa, ta, inherit, flags, env, dir, si, pi]
  assert.equal(create[1], 0xdeadbeef, 'токен из OpenProcessToken (декодирован из буфера)');
  assert.ok(create[2].toString('utf16le').includes('helper.exe'), 'exe в lpApplicationName');
  // детached+unicode: 0x8 | 0x400
  assert.equal(create[7], 0x408, 'DETACHED_PROCESS|CREATE_UNICODE_ENVIRONMENT');
});

test('нет активной консольной сессии — честный no-active-session', async () => {
  const { koffiMock } = makeKoffi({ ...SCRIPT, sessionId: 0xFFFFFFFF, cursor: 0 });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
  assert.deepEqual(r, { ok: false, reason: 'no-active-session' });
});

test('winlogon другого сеанса не перепутается: ищется по sessionId', async () => {
  const { koffiMock } = makeKoffi({
    sessionId: 7,
    processes: [{ pid: 200, name: 'winlogon.exe' }, { pid: 201, name: 'winlogon.exe' }],
    pidSessions: { 200: 1, 201: 7 },
    spawnPid: 5,
    cursor: 0,
  });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
  assert.equal(r.ok, true);
  assert.equal(r.pid, 5);
  const open = koffiMock.calls.find(([n]) => n === 'OpenProcess');
  assert.equal(open[3], 201, 'открыт winlogon ТОЛЬКО целевого сеанса'); // ['OpenProcess', access, inherit, pid]
});

test('winlogon не найден (нет процесса нужного сеанса) — winlogon-not-found', async () => {
  const { koffiMock } = makeKoffi({
    sessionId: 9,
    processes: [{ pid: 200, name: 'winlogon.exe' }],
    pidSessions: { 200: 1 },
    cursor: 0,
  });
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
  const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
  assert.deepEqual(r, { ok: false, reason: 'winlogon-not-found' });
});

test('цепочка честно ломается: openProcess/openToken/CreateProcess', async () => {
  for (const [patch, reason] of [
    [{ openOk: false }, 'winlogon-open-failed'],
    [{ tokenOk: false }, 'token-failed'],
    [{ spawnOk: false }, 'create-failed'],
  ]) {
    const { koffiMock } = makeKoffi({ ...SCRIPT, ...patch, cursor: 0 });
    const { spawnInConsoleSession } = createSessionSpawner({ koffi: koffiMock });
    const r = await spawnInConsoleSession({ exePath: 'x.exe', commandLine: 'x.exe' });
    assert.deepEqual(r, { ok: false, reason }, `сценарий ${reason}`);
  }
});

test('мусорные аргументы и отсутствие koffi — честные отказы', async () => {
  const { spawnInConsoleSession } = createSessionSpawner({ koffi: null });
  assert.deepEqual(await spawnInConsoleSession({ exePath: 'x', commandLine: 'x' }), { ok: false, reason: 'koffi-unavailable' });
  const { koffiMock } = makeKoffi({ ...SCRIPT, cursor: 0 });
  const spawner = createSessionSpawner({ koffi: koffiMock });
  assert.deepEqual(await spawner.spawnInConsoleSession({ commandLine: 'x' }), { ok: false, reason: 'bad-exe' });
  assert.deepEqual(await spawner.spawnInConsoleSession({ exePath: 'x' }), { ok: false, reason: 'bad-commandline' });
});

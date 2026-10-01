// Спавн helper-процесса в активном консольном сеансе Windows (ADR 0027,
// v0.6 fix по живой диагностике на машине — diag-spawn.cjs): WTSGetActiveConsoleSessionId →
// WTSQueryUserToken (токен активной сессии — стандартный путь для SYSTEM-служб,
// вместо Toolhelp-перечисления winlogon: koffi _Out_ выделяет нулевую структуру,
// стирая dwSize, и Process32FirstW никогда не succeeds) → CreateProcessAsUserW
// с plain-объектом StartupInfo (_Inout_: koffi пакует вход, включая cb и
// lpDesktop). Честные отказы с причиной, никогда не фейковый успех.
// koffi инъекцией — юнит-тесты на моках без Electron.

const CREATE_FLAGS = 0x00000008 | 0x00000400; // DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT

export function createSessionSpawner({ koffi, log = console } = {}) {
  if (!koffi) {
    return { spawnInConsoleSession: async () => ({ ok: false, reason: 'koffi-unavailable' }) };
  }

  let api = null;
  function load() {
    if (api) return api; // мемоизация: повторная koffi.struct(имя) кидает Duplicate type name
    const kernel32 = koffi.load('kernel32.dll');
    const wtsapi32 = koffi.load('wtsapi32.dll');
    const advapi32 = koffi.load('advapi32.dll');

    koffi.struct('EdeskStartupInfoW', {
      cb: 'uint32',
      lpReserved: 'void *',
      lpDesktop: 'void *',
      lpTitle: 'void *',
      dwX: 'uint32',
      dwY: 'uint32',
      dwXSize: 'uint32',
      dwYSize: 'uint32',
      dwXCountChars: 'uint32',
      dwYCountChars: 'uint32',
      dwFillAttribute: 'uint32',
      dwFlags: 'uint32',
      wShowWindow: 'uint16',
      cbReserved2: 'uint16',
      lpReserved2: 'void *',
      hStdInput: 'void *',
      hStdOutput: 'void *',
      hStdError: 'void *',
    });
    koffi.struct('EdeskProcessInfo', {
      hProcess: 'void *',
      hThread: 'void *',
      dwProcessId: 'uint32',
      dwThreadId: 'uint32',
    });

    api = {
      getActiveSession: kernel32.func('uint32 WTSGetActiveConsoleSessionId()'),
      queryUserToken: wtsapi32.func('bool WTSQueryUserToken(uint32 SessionId, _Out_ void *Token)'),
      closeHandle: kernel32.func('bool CloseHandle(void *Handle)'),
      createAsUser: advapi32.func(
        'bool CreateProcessAsUserW(void *Token, const void *Application, const void *CommandLine, '
        + 'void *ProcessAttrs, void *ThreadAttrs, bool Inherit, uint32 Flags, void *Environment, '
        + 'const void *Directory, _Inout_ EdeskStartupInfoW *StartupInfo, _Out_ EdeskProcessInfo *ProcessInfo)',
      ),
    };
    return api;
  }

  // Запуск helper'а в консольном сеансе. → { ok, pid } | { ok:false, reason }.
  async function spawnInConsoleSession({ exePath, commandLine, desktop = 'winsta0\\default' }) {
    if (typeof exePath !== 'string' || !exePath) return { ok: false, reason: 'bad-exe' };
    if (typeof commandLine !== 'string' || !commandLine) return { ok: false, reason: 'bad-commandline' };
    try {
      const dll = load();
      const sessionId = dll.getActiveSession();
      if (!sessionId || sessionId === 0xFFFFFFFF) return { ok: false, reason: 'no-active-session' };

      const tokenBuf = Buffer.alloc(8); // место под HANDLE (_Out_)
      if (!dll.queryUserToken(sessionId, tokenBuf)) {
        return { ok: false, reason: 'token-failed' };
      }
      const token = koffi.decode(tokenBuf, 0, 'void *');
      try {
        const utf16 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
        // plain-объект: _Inout_ — koffi пакует вход (cb, lpDesktop) и пишет выход
        const si = {
          cb: koffi.sizeof('EdeskStartupInfoW'),
          lpReserved: null,
          lpDesktop: utf16(desktop),
          lpTitle: null,
          dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0,
          dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0, dwFlags: 0,
          wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
          hStdInput: null, hStdOutput: null, hStdError: null,
        };
        const pi = { hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0 };
        const spawned = dll.createAsUser(token, utf16(exePath), utf16(commandLine),
          null, null, false, CREATE_FLAGS, null, null, si, pi);
        if (!spawned) return { ok: false, reason: 'create-failed' };
        try { dll.closeHandle(pi.hProcess); } catch { /* хэндл не выделился */ }
        try { dll.closeHandle(pi.hThread); } catch { /* хэндл не выделился */ }
        return { ok: true, pid: pi.dwProcessId };
      } finally {
        try { dll.closeHandle(token); } catch { /* токен уже мёртв */ }
      }
    } catch (e) {
      log.warn?.(`session-spawn: ${e?.message ?? e}`);
      return { ok: false, reason: 'native-unavailable' };
    }
  }

  return { spawnInConsoleSession };
}

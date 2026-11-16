// Спавн helper-процесса в активном консольном сеансе Windows (ADR 0027,
// v0.6 fix по живой диагностике на машине — diag-spawn.cjs): WTSGetActiveConsoleSessionId →
// WTSQueryUserToken (токен активной сессии — стандартный путь для SYSTEM-служб,
// вместо Toolhelp-перечисления winlogon: koffi _Out_ выделяет нулевую структуру,
// стирая dwSize, и Process32FirstW никогда не succeeds) → CreateProcessAsUserW
// с plain-объектом StartupInfo (_Inout_: koffi пакует вход, включая cb и
// lpDesktop). Честные отказы с причиной, никогда не фейковый успех.
// koffi инъекцией — юнит-тесты на моках без Electron.

const CREATE_FLAGS = 0x00000008 | 0x00000400; // DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT
// ADR 0036: токен SYSTEM в консольном сеансе — свой токен службы (LocalSystem)
// дублируется в primary и получает номер консольного сеанса (нужен SeTcbPrivilege,
// он у LocalSystem есть). Такой процесс видит и рабочий стол Winlogon (экран
// входа/блокировки), а при отсутствии вошедшего пользователя WTSQueryUserToken
// не работает вовсе.
const TOKEN_ALL_ACCESS = 0x000F01FF;
const MAXIMUM_ALLOWED = 0x02000000;
const SECURITY_IMPERSONATION = 2;
const TOKEN_PRIMARY = 1;
const TOKEN_SESSION_ID = 12; // TOKEN_INFORMATION_CLASS.TokenSessionId

// tokenMode: 'user' — токен вошедшего пользователя (как до ADR 0036);
// 'system' — SYSTEM в консольном сеансе, при сбое — честный откат на 'user'.
export function createSessionSpawner({ koffi, log = console, tokenMode = 'user' } = {}) {
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
      getCurrentProcess: kernel32.func('void * GetCurrentProcess()'),
      openProcessToken: advapi32.func('bool OpenProcessToken(void *Process, uint32 Access, _Out_ void *Token)'),
      duplicateTokenEx: advapi32.func(
        'bool DuplicateTokenEx(void *Existing, uint32 Access, void *Attrs, int Impersonation, int Type, _Out_ void *NewToken)',
      ),
      setTokenInformation: advapi32.func('bool SetTokenInformation(void *Token, int Class, void *Info, uint32 Length)'),
      createAsUser: advapi32.func(
        'bool CreateProcessAsUserW(void *Token, const void *Application, const void *CommandLine, '
        + 'void *ProcessAttrs, void *ThreadAttrs, bool Inherit, uint32 Flags, void *Environment, '
        + 'const void *Directory, _Inout_ EdeskStartupInfoW *StartupInfo, _Out_ EdeskProcessInfo *ProcessInfo)',
      ),
    };
    return api;
  }

  // Токен SYSTEM для консольного сеанса или null (честный откат на токен пользователя).
  function systemTokenFor(dll, sessionId) {
    const own = Buffer.alloc(8);
    if (!dll.openProcessToken(dll.getCurrentProcess(), TOKEN_ALL_ACCESS, own)) return null;
    const ownToken = koffi.decode(own, 0, 'void *');
    let dup = null;
    let ok = false;
    try {
      const dupBuf = Buffer.alloc(8);
      if (!dll.duplicateTokenEx(ownToken, MAXIMUM_ALLOWED, null, SECURITY_IMPERSONATION, TOKEN_PRIMARY, dupBuf)) return null;
      dup = koffi.decode(dupBuf, 0, 'void *');
      const sess = Buffer.alloc(4);
      sess.writeUInt32LE(sessionId, 0);
      if (!dll.setTokenInformation(dup, TOKEN_SESSION_ID, sess, 4)) return null;
      ok = true;
      return dup;
    } finally {
      // Ревью безопасности 22.10 (P3-3): дубликат закрывается при ЛЮБОМ неуспехе,
      // в том числе если вызов бросил исключение, — токен SYSTEM не утекает.
      if (!ok && dup) { try { dll.closeHandle(dup); } catch { /* токен уже мёртв */ } }
      try { dll.closeHandle(ownToken); } catch { /* токен уже мёртв */ }
    }
  }

  // Запуск helper'а в консольном сеансе. → { ok, pid, token } | { ok:false, reason }.
  async function spawnInConsoleSession({ exePath, commandLine, desktop = 'winsta0\\default' }) {
    if (typeof exePath !== 'string' || !exePath) return { ok: false, reason: 'bad-exe' };
    if (typeof commandLine !== 'string' || !commandLine) return { ok: false, reason: 'bad-commandline' };
    try {
      const dll = load();
      const sessionId = dll.getActiveSession();
      if (!sessionId || sessionId === 0xFFFFFFFF) return { ok: false, reason: 'no-active-session' };

      let token = null;
      let kind = 'user';
      if (tokenMode === 'system') {
        token = systemTokenFor(dll, sessionId);
        if (token) kind = 'system';
        else log.warn?.('session-spawn: токен SYSTEM для сеанса не получен — откат на токен пользователя');
      }
      if (!token) {
        const tokenBuf = Buffer.alloc(8); // место под HANDLE (_Out_)
        if (!dll.queryUserToken(sessionId, tokenBuf)) {
          return { ok: false, reason: 'token-failed' };
        }
        token = koffi.decode(tokenBuf, 0, 'void *');
      }
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
        return tokenMode === 'system' ? { ok: true, pid: pi.dwProcessId, token: kind } : { ok: true, pid: pi.dwProcessId };
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

// ADR 0036, security-review 21.10: от SYSTEM хелпер запускается ТОЛЬКО из папки,
// куда обычный пользователь не может писать, — иначе подложенная рядом с exe DLL
// (dxgi.dll и т.п. грузятся из папки программы раньше системной) исполнилась бы
// от SYSTEM. Program Files (установка NSIS, ADR 0029) закрыта; распаковка
// портативки в TEMP и копия в ProgramData — нет (у Users там WD/AD). Вне
// Program Files — прежний путь: токен пользователя и копия в ProgramData
// (подложенная DLL получает права того же пользователя, роста прав нет).
export function helperLaunchPlan({ platform, helperExe, programFiles, envToken, pathApi }) {
  if (platform !== 'win32' || !helperExe) return { tokenMode: 'user', copyToProgramData: false };
  const norm = (p) => pathApi.resolve(p).toLowerCase();
  const root = programFiles ? norm(programFiles) + pathApi.sep : null;
  const protectedDir = root != null && norm(helperExe).startsWith(root);
  if (envToken !== 'user' && protectedDir) return { tokenMode: 'system', copyToProgramData: false };
  return { tokenMode: 'user', copyToProgramData: true };
}

// Спавн helper-процесса в активном консольном сеансе Windows (ADR 0027,
// механика RustDesk launch_privileged_process / windows.cc GetLogonPid):
// служба (SYSTEM) находит winlogon.exe консольного сеанса через Toolhelp-снапшот,
// открывает его токен и создаёт пользовательский процесс CreateProcessAsUserW
// (токен winlogon уже привязан к сеансу — без DuplicateTokenEx, как в RustDesk).
// Честные отказы с причиной, никогда не фейковый успех (конвенции проекта).
// koffi инъекцией — юнит-тесты идут на моках без Electron.

// OpenProcessToken: TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE —
// минимум, который принимает CreateProcessAsUserW.
const TOKEN_ACCESS = 0x0008 | 0x0001 | 0x0002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TH32CS_SNAPPROCESS = 0x2;
const CREATE_FLAGS = 0x00000008 | 0x00000400; // DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT

export function createSessionSpawner({ koffi, log = console } = {}) {
  if (!koffi) {
    return { spawnInConsoleSession: async () => ({ ok: false, reason: 'koffi-unavailable' }) };
  }

  // koffi 3: объявления ТОЛЬКО прототипом-строкой (форма func(sig, {stdcall:true})
  // падает — дефект №11, живой сеанс 28.09). koffi.struct возвращает тип-конструктор:
  // out-параметры CreateProcessAsUserW/Process32NextW пишутся внутрь инстанса
  // (plain-объект koffi на запись не умеет).
  function load() {
    const kernel32 = koffi.load('kernel32.dll');
    const advapi32 = koffi.load('advapi32.dll');

    const StartupInfoW = koffi.struct('EdeskStartupInfoW', {
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
    const ProcessInfo = koffi.struct('EdeskProcessInfo', {
      hProcess: 'void *',
      hThread: 'void *',
      dwProcessId: 'uint32',
      dwThreadId: 'uint32',
    });
    const ProcessEntry32W = koffi.struct('EdeskProcessEntry32W', {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: 'uint16[260]',
    });

    return {
      StartupInfoW,
      ProcessInfo,
      ProcessEntry32W,
      getActiveSession: kernel32.func('uint32 WTSGetActiveConsoleSessionId()'),
      createSnapshot: kernel32.func('void *CreateToolhelp32Snapshot(uint32 Flags, uint32 ParentPid)'),
      process32First: kernel32.func('bool Process32FirstW(void *Snapshot, void *Entry)'),
      process32Next: kernel32.func('bool Process32NextW(void *Snapshot, void *Entry)'),
      pidToSession: kernel32.func('bool ProcessIdToSessionId(uint32 Pid, void *SessionId)'),
      closeHandle: kernel32.func('bool CloseHandle(void *Handle)'),
      openProcess: kernel32.func('void *OpenProcess(uint32 Access, bool Inherit, uint32 Pid)'),
      openToken: advapi32.func('bool OpenProcessToken(void *Process, uint32 Access, void *Token)'),
      createAsUser: advapi32.func(
        'bool CreateProcessAsUserW(void *Token, const void *Application, const void *CommandLine, '
        + 'void *ProcessAttrs, void *ThreadAttrs, bool Inherit, uint32 Flags, void *Environment, '
        + 'const void *Directory, void *StartupInfo, void *ProcessInfo)',
      ),
    };
  }

  // Имя процесса из PROCESSENTRY32W.szExeFile (uint16[260]) → строка до NUL.
  function entryName(entry) {
    const units = entry.szExeFile ?? [];
    let name = '';
    for (const u of units) {
      if (!u) break;
      name += String.fromCharCode(u);
    }
    return name;
  }

  // winlogon.exe целевого сеанса: снапшот всех процессов → ProcessIdToSessionId.
  // (GetLogonPid RustDesk: winlogon живёт в консольном сеансе всегда, в отличие
  // от explorer, которого нет на экране входа.)
  function findWinlogonPid(api, sessionId) {
    const snapshot = api.createSnapshot(TH32CS_SNAPPROCESS, 0);
    if (!snapshot) return { pid: 0, reason: 'snapshot-failed' };
    const entry = new api.ProcessEntry32W();
    entry.dwSize = koffi.sizeof('EdeskProcessEntry32W');
    try {
      let ok;
      try {
        ok = api.process32First(snapshot, entry);
      } catch {
        return { pid: 0, reason: 'snapshot-failed' };
      }
      while (ok) {
        if (entryName(entry).toLowerCase() === 'winlogon.exe') {
          const sidBuf = Buffer.alloc(4);
          if (api.pidToSession(entry.th32ProcessID, sidBuf)
            && sidBuf.readUInt32LE(0) === sessionId) {
            return { pid: entry.th32ProcessID };
          }
        }
        ok = api.process32Next(snapshot, entry);
      }
      return { pid: 0, reason: 'winlogon-not-found' };
    } finally {
      try { api.closeHandle(snapshot); } catch { /* снапшот уже мёртв */ }
    }
  }

  // Запуск helper'а в консольном сеансе. → { ok, pid } | { ok:false, reason }.
  async function spawnInConsoleSession({ exePath, commandLine, desktop = 'winsta0\\default' }) {
    if (typeof exePath !== 'string' || !exePath) return { ok: false, reason: 'bad-exe' };
    if (typeof commandLine !== 'string' || !commandLine) return { ok: false, reason: 'bad-commandline' };
    try {
      const api = load();
      const sessionId = api.getActiveSession();
      if (!sessionId || sessionId === 0xFFFFFFFF) return { ok: false, reason: 'no-active-session' };

      const win = findWinlogonPid(api, sessionId);
      if (!win.pid) return { ok: false, reason: win.reason };

      const proc = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, win.pid);
      if (!proc) return { ok: false, reason: 'winlogon-open-failed' };
      try {
        const tokenBuf = Buffer.alloc(8); // место под HANDLE, пишет OpenProcessToken
        if (!api.openToken(proc, TOKEN_ACCESS, tokenBuf)) {
          return { ok: false, reason: 'token-failed' };
        }
        const token = koffi.decode(tokenBuf, 0, 'void *');
        try {
          const utf16 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
          const si = new api.StartupInfoW();
          si.cb = koffi.sizeof('EdeskStartupInfoW');
          si.lpDesktop = utf16(desktop);
          const pi = new api.ProcessInfo();
          const spawned = api.createAsUser(token, utf16(exePath), utf16(commandLine),
            null, null, false, CREATE_FLAGS, null, null, si, pi);
          if (!spawned) return { ok: false, reason: 'create-failed' };
          return { ok: true, pid: pi.dwProcessId };
        } finally {
          try { api.closeHandle(token); } catch { /* токен уже мёртв */ }
        }
      } finally {
        try { api.closeHandle(proc); } catch { /* процесс уже мёртв */ }
      }
    } catch (e) {
      log.warn?.(`session-spawn: ${e?.message ?? e}`);
      return { ok: false, reason: 'native-unavailable' };
    }
  }

  return { spawnInConsoleSession };
}

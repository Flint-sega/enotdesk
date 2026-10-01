// Спавн helper-процесса в активном консольном сеансе Windows (ADR 0027,
// механика RustDesk launch_privileged_process / windows.cc GetLogonPid):
// служба (SYSTEM) находит winlogon.exe консольного сеанса через Toolhelp-снапшот,
// открывает его токен и создаёт пользовательский процесс CreateProcessAsUserW
// (токен winlogon уже привязан к сеансу — без DuplicateTokenEx, как в RustDesk).
// Честные отказы с причиной, никогда не фейковый успех (конвенции проекта).
// koffi инъекцией — юнит-тесты идут на моках без Electron.
//
// v0.6 fix (ревью GLM-5.3): koffi 3.2.1 koffi.struct() возвращает TypeObject, а
// НЕ конструктор — структуры передаются plain-объектами, а в прототипах выходные
// параметры помечены _Out_/_Inout_ (паттерн native-input.mjs и доки koffi);
// регистрация типов мемоизирована (повторная koffi.struct с тем же именем
// кидает Duplicate type name — на долгоживущей службе падал бы 2-й сеанс).

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

  // Мемоизация: koffi.load и koffi.struct(имя) — на вызов один раз за процесс.
  let api = null;

  function load() {
    if (api) return api;
    const kernel32 = koffi.load('kernel32.dll');
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
    koffi.struct('EdeskProcessEntry32W', {
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

    api = {
      getActiveSession: kernel32.func('uint32 WTSGetActiveConsoleSessionId()'),
      createSnapshot: kernel32.func('void *CreateToolhelp32Snapshot(uint32 Flags, uint32 ParentPid)'),
      // Структуры с size-полем (Process32* требует dwSize ДО вызова) идут через
      // koffi.pack/unpack + void*: _Out_ у koffi выделяет НУЛЁВУЮ структуру и
      // стирает dwSize (живая диагностика V8 — Process32FirstW возвращал false).
      // CreateProcessAsUserW: StartupInfo как _Inout_ (вход, включая cb и
      // lpDesktop, пакуется из объекта), ProcessInfo как _Out_ (читаем pid).
      process32First: kernel32.func('bool Process32FirstW(void *Snapshot, void *Entry)'),
      process32Next: kernel32.func('bool Process32NextW(void *Snapshot, void *Entry)'),
      pidToSession: kernel32.func('bool ProcessIdToSessionId(uint32 Pid, _Out_ void *SessionId)'),
      closeHandle: kernel32.func('bool CloseHandle(void *Handle)'),
      openProcess: kernel32.func('void *OpenProcess(uint32 Access, bool Inherit, uint32 Pid)'),
      openToken: advapi32.func('bool OpenProcessToken(void *Process, uint32 Access, _Out_ void *Token)'),
      createAsUser: advapi32.func(
        'bool CreateProcessAsUserW(void *Token, const void *Application, const void *CommandLine, '
        + 'void *ProcessAttrs, void *ThreadAttrs, bool Inherit, uint32 Flags, void *Environment, '
        + 'const void *Directory, _Inout_ EdeskStartupInfoW *StartupInfo, _Out_ EdeskProcessInfo *ProcessInfo)',
      ),
    };
    return api;
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
  function findWinlogonPid(dll, sessionId) {
    const snapshot = dll.createSnapshot(TH32CS_SNAPPROCESS, 0);
    if (!snapshot) return { pid: 0, reason: 'snapshot-failed' };
    // Process32* требует dwSize ДО вызова, а koffi для _Out_ выделяет нулевую
    // структуру и стирает его (живая диагностика V8: Process32FirstW возвращал
    // false) — поэтому pack/unpack через void*: вход пакуется с dwSize,
    // выход распаковывается из буфера.
    const packEntry = () => koffi.pack('EdeskProcessEntry32W', {
      dwSize: koffi.sizeof('EdeskProcessEntry32W'),
      cntUsage: 0, th32ProcessID: 0, th32DefaultHeapID: 0, th32ModuleID: 0,
      cntThreads: 0, th32ParentProcessID: 0, pcPriClassBase: 0, dwFlags: 0,
      szExeFile: new Array(260).fill(0),
    });
    try {
      let buf = packEntry();
      let ok;
      try {
        ok = dll.process32First(snapshot, buf);
      } catch {
        return { pid: 0, reason: 'snapshot-failed' };
      }
      if (!ok) return { pid: 0, reason: 'snapshot-failed' }; // первая запись не прочиталась — снапшот невалиден
      for (;;) {
        const entry = koffi.unpack('EdeskProcessEntry32W', buf);
        if (entryName(entry).toLowerCase() === 'winlogon.exe') {
          const sidBuf = Buffer.alloc(4);
          if (dll.pidToSession(entry.th32ProcessID, sidBuf)
            && sidBuf.readUInt32LE(0) === sessionId) {
            return { pid: entry.th32ProcessID };
          }
        }
        buf = packEntry();
        ok = dll.process32Next(snapshot, buf);
        if (!ok) return { pid: 0, reason: 'winlogon-not-found' };
      }
    } finally {
      try { dll.closeHandle(snapshot); } catch { /* снапшот уже мёртв */ }
    }
  }

  // Запуск helper'а в консольном сеансе. → { ok, pid } | { ok:false, reason }.
  async function spawnInConsoleSession({ exePath, commandLine, desktop = 'winsta0\\default' }) {
    if (typeof exePath !== 'string' || !exePath) return { ok: false, reason: 'bad-exe' };
    if (typeof commandLine !== 'string' || !commandLine) return { ok: false, reason: 'bad-commandline' };
    try {
      const dll = load();
      const sessionId = dll.getActiveSession();
      if (!sessionId || sessionId === 0xFFFFFFFF) return { ok: false, reason: 'no-active-session' };

      const win = findWinlogonPid(dll, sessionId);
      if (!win.pid) return { ok: false, reason: win.reason };

      const proc = dll.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, win.pid);
      if (!proc) return { ok: false, reason: 'winlogon-open-failed' };
      try {
        const tokenBuf = Buffer.alloc(8); // место под HANDLE, пишет OpenProcessToken (_Out_)
        if (!dll.openToken(proc, TOKEN_ACCESS, tokenBuf)) {
          return { ok: false, reason: 'token-failed' };
        }
        const token = koffi.decode(tokenBuf, 0, 'void *');
        try {
          const utf16 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
          // plain-объекты: koffi упаковывает/распаковывает поля по типу из
          // прототипа (_Inout_/_Out_ void * со struct-типом по имени не связать —
          // koffi 3 берёт раскладку из зарегистрированного koffi.struct по
          // объекту с полями; объект обязан повторять раскладку).
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
          const pi = {
            hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0,
          };
          const spawned = dll.createAsUser(token, utf16(exePath), utf16(commandLine),
            null, null, false, CREATE_FLAGS, null, null, si, pi);
          if (!spawned) return { ok: false, reason: 'create-failed' };
          try { dll.closeHandle(pi.hProcess); } catch { /* хэндл не выделился */ }
          try { dll.closeHandle(pi.hThread); } catch { /* хэндл не выделился */ }
          return { ok: true, pid: pi.dwProcessId };
        } finally {
          try { dll.closeHandle(token); } catch { /* токен уже мёртв */ }
        }
      } finally {
        try { dll.closeHandle(proc); } catch { /* процесс уже мёртв */ }
      }
    } catch (e) {
      log.warn?.(`session-spawn: ${e?.message ?? e}`);
      return { ok: false, reason: 'native-unavailable' };
    }
  }

  return { spawnInConsoleSession };
}

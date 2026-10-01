// Диагностика на живой Windows-машине: reproduces session-spawn findWinlogonPid.
const koffi = require('koffi');
koffi.struct('DiagPE32W', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32', cntThreads: 'uint32',
  th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
  szExeFile: 'uint16[260]',
});
const kernel32 = koffi.load('kernel32.dll');
const getActive = kernel32.func('uint32 WTSGetActiveConsoleSessionId()');
const snap = kernel32.func('void *CreateToolhelp32Snapshot(uint32 Flags, uint32 ParentPid)');
const first = kernel32.func('bool Process32FirstW(void *Snapshot, _Out_ DiagPE32W *Entry)');
const next = kernel32.func('bool Process32NextW(void *Snapshot, _Out_ DiagPE32W *Entry)');
const pid2sess = kernel32.func('bool ProcessIdToSessionId(uint32 Pid, _Out_ void *SessionId)');
const closeHandle = kernel32.func('bool CloseHandle(void *Handle)');

const sid = getActive();
console.log(JSON.stringify({ activeSession: sid }));
const h = snap(2, 0);
console.log(JSON.stringify({ snapshot: typeof h, truthy: !!h }));
const entry = {
  dwSize: koffi.sizeof('DiagPE32W'), cntUsage: 0, th32ProcessID: 0,
  th32DefaultHeapID: 0, th32ModuleID: 0, cntThreads: 0,
  th32ParentProcessID: 0, pcPriClassBase: 0, dwFlags: 0,
  szExeFile: new Array(260).fill(0),
};
let ok = first(h, entry);
console.log(JSON.stringify({ firstOk: ok, firstName: entry.szExeFile.slice(0, 20) }));
let count = 0; const winlogons = [];
while (ok) {
  count += 1;
  let name = '';
  for (const u of entry.szExeFile) { if (!u) break; name += String.fromCharCode(u); }
  if (name.toLowerCase() === 'winlogon.exe') {
    const buf = Buffer.alloc(4);
    const got = pid2sess(entry.th32ProcessID, buf);
    winlogons.push({ pid: entry.th32ProcessID, sess: got ? buf.readUInt32LE(0) : null });
  }
  ok = next(h, entry);
}
closeHandle(h);
console.log(JSON.stringify({ count, winlogons }));

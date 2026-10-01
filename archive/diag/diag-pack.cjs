// Диагностика v2: koffi.pack/unpack для структур session-spawn на живой машине.
const koffi = require('koffi');
koffi.struct('DiagSI', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
  dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
  lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
});
koffi.struct('DiagPE', {
  dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32',
  th32DefaultHeapID: 'uintptr_t', th32ModuleID: 'uint32', cntThreads: 'uint32',
  th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
  szExeFile: 'uint16[260]',
});
const utf16 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
const step = (name, fn) => {
  try { const r = fn(); console.log(name, 'OK', typeof r, r && r.length); return r; }
  catch (e) { console.log(name, 'THROW:', e.message); return null; }
};
const p1 = step('pack PE32', () => koffi.pack('DiagPE', {
  dwSize: koffi.sizeof('DiagPE'), cntUsage: 0, th32ProcessID: 0,
  th32DefaultHeapID: 0, th32ModuleID: 0, cntThreads: 0, th32ParentProcessID: 0,
  pcPriClassBase: 0, dwFlags: 0, szExeFile: new Array(260).fill(0),
}));
const p2 = step('pack SI', () => koffi.pack('DiagSI', {
  cb: koffi.sizeof('DiagSI'), lpReserved: null, lpDesktop: utf16('winsta0\\default'),
  lpTitle: null, dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0,
  dwYCountChars: 0, dwFillAttribute: 0, dwFlags: 0, wShowWindow: 0,
  cbReserved2: 0, lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null,
}));
const u1 = step('unpack PE32', () => koffi.unpack('DiagPE', p1));
if (u1) console.log('unpack PE32 dwSize:', u1.dwSize);
const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');
const snap = kernel32.func('void *CreateToolhelp32Snapshot(uint32 Flags, uint32 ParentPid)');
const first = kernel32.func('bool Process32FirstW(void *Snapshot, void *Entry)');
const next = kernel32.func('bool Process32NextW(void *Snapshot, void *Entry)');
const pid2s = kernel32.func('bool ProcessIdToSessionId(uint32 Pid, _Out_ void *SessionId)');
const closeH = kernel32.func('bool CloseHandle(void *Handle)');
const h = snap(2, 0);
console.log('snapshot truthy:', !!h);
let ok = first(h, p1);
console.log('first:', ok);
if (ok) {
  const e1 = koffi.unpack('DiagPE', p1);
  let name = '';
  for (const u of e1.szExeFile) { if (!u) break; name += String.fromCharCode(u); }
  console.log('first name:', name, 'pid:', e1.th32ProcessID);
  let count = 1; const wl = [];
  while (next(h, p1)) {
    count += 1;
    const e = koffi.unpack('DiagPE', p1);
    let n2 = '';
    for (const u of e.szExeFile) { if (!u) break; n2 += String.fromCharCode(u); }
    if (n2.toLowerCase() === 'winlogon.exe') {
      const b = Buffer.alloc(4);
      pid2s(e.th32ProcessID, b);
      wl.push({ pid: e.th32ProcessID, sess: b.readUInt32LE(0) });
    }
  }
  console.log(JSON.stringify({ count, winlogons: wl }));
}
closeH(h);

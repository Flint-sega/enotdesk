// Диагностика v3: прод-цепочка session-spawn без Toolhelp —
// WTSGetActiveConsoleSessionId → WTSQueryUserToken → CreateProcessAsUserW.
const koffi = require('koffi');
const kernel32 = koffi.load('kernel32.dll');
const wts = koffi.load('wtsapi32.dll');
const advapi32 = koffi.load('advapi32.dll');
koffi.struct('DiagSI3', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
  dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16',
  lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
});
koffi.struct('DiagPI3', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' });
const step = (name, fn) => {
  try { const r = fn(); console.log(name, 'OK'); return r; }
  catch (e) { console.log(name, 'THROW:', e.message); return null; }
};
const getSid = step('decl+get WTSGetActiveConsoleSessionId', () => kernel32.func('uint32 WTSGetActiveConsoleSessionId()')());
console.log('console session:', getSid);
const qUserToken = step('decl WTSQueryUserToken', () => wts.func('bool WTSQueryUserToken(uint32 SessionId, _Out_ void *Token)'));
const tokenBuf = Buffer.alloc(8);
const got = qUserToken(getSid, tokenBuf);
console.log('WTSQueryUserToken:', got);
if (!got) process.exit(1);
const token = koffi.decode(tokenBuf, 0, 'void *');
const utf16 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
const createAsUser = step('decl CreateProcessAsUserW', () => advapi32.func(
  'bool CreateProcessAsUserW(void *Token, const void *Application, const void *CommandLine, '
  + 'void *ProcessAttrs, void *ThreadAttrs, bool Inherit, uint32 Flags, void *Environment, '
  + 'const void *Directory, _Inout_ DiagSI3 *StartupInfo, _Out_ DiagPI3 *ProcessInfo)',
));
const closeH = step('decl CloseHandle', () => kernel32.func('bool CloseHandle(void *Handle)'));
const si = {
  cb: koffi.sizeof('DiagSI3'), lpReserved: null, lpDesktop: utf16('winsta0\\default'),
  lpTitle: null, dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0,
  dwYCountChars: 0, dwFillAttribute: 0, dwFlags: 0, wShowWindow: 0,
  cbReserved2: 0, lpReserved2: null, hStdInput: null, hStdOutput: null, hStdError: null,
};
const pi = { hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0 };
const out = utf16(process.env.TEMP + '\\enot-spawn-whoami.txt');
const cmd = utf16('cmd.exe /c whoami > "' + process.env.TEMP + '\\enot-spawn-whoami.txt"');
const ok = createAsUser(token, utf16('C:\\Windows\\System32\\cmd.exe'), cmd,
  null, null, false, 0x00000008 | 0x00000400, null, null, si, pi);
console.log('CreateProcessAsUserW:', ok, 'pid:', pi.dwProcessId);
if (ok) { try { closeH(pi.hProcess); } catch {} try { closeH(pi.hThread); } catch {} }
console.log('OUT FILE:', process.env.TEMP + '\\enot-spawn-whoami.txt');

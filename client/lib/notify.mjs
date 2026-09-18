// Toast на экран машины (R08, interfaces.md): showToast(platform, text) →
// {ok, reason?}. Различия ОС спрятаны здесь (граница модуля): Windows —
// WTSSendMessageW (wtsapi32 через koffi) в активную сессию — главный путь;
// Linux — notify-send от консольного пользователя (getent + sudo -u);
// macOS — osascript display notification. Любая недоступность платформы —
// честный отказ с причиной, никогда не фейковый успех (конвенции проекта).
// koffi и spawnSync инъекцией — юнит-тесты идут на моках без Electron.

import { spawnSync as nodeSpawnSync } from 'node:child_process';

// Честный лимит текста: сервер отклоняет длиннее, здесь — режем до него.
export const TOAST_MAX = 500;

// Управляющие символы (кроме \n и \t) вычищаются: WTSSendMessageW и
// osascript не обязаны их переживать, а терминальные escape-последовательности
// в чужом диалоге никому не нужны. Наружный trim.
export function sanitizeToastText(text) {
  if (typeof text !== 'string') return '';
  let clean = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const control = (code < 32 || (code >= 0x7F && code <= 0x9F)) && code !== 9 && code !== 10;
    if (!control) clean += ch;
  }
  return clean.trim().slice(0, TOAST_MAX);
}

// Windows (главный путь): сначала kernel32!WTSGetActiveConsoleSessionId —
// активная консольная сессия пользователя (0 — активной нет, экран входа:
// честный отказ 'no-active-session', посылать некому). Затем wtsapi32!
// WTSSendMessageW(WTS_CURRENT_SERVER_HANDLE=null, ЭТОТ sessionId, заголовок,
// сообщение, MB_OK=0, timeout=0 — ждать ответа, bWait). Прототип объявлен
// async: диалог может ждать нажатия минуты — цикл агента (heartbeat, сеансы)
// не должен замерзать. Заголовок/сообщение передаются готовыми буферами
// UTF-16LE + терминатор: длины в WinAPI считаются в байтах.
function winToast(message, title, koffi) {
  const krn32 = koffi.load('kernel32.dll');
  const getActiveSession = krn32.func('uint32 WTSGetActiveConsoleSessionId()', { stdcall: true });
  const sessionId = getActiveSession();
  if (!sessionId) return Promise.resolve({ ok: false, reason: 'no-active-session' });
  const wts = koffi.load('wtsapi32.dll');
  const send = wts.func(
    'bool WTSSendMessageW(void *hServer, uint32 SessionId, const void *pTitle, uint32 TitleLength, '
    + 'const void *pMessage, uint32 MessageLength, uint32 Style, uint32 Timeout, void *pResponse, bool bWait)',
    { stdcall: true, async: true },
  );
  const utf16 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
  const titleBuf = utf16(title);
  const msgBuf = utf16(message);
  const MB_OK = 0;
  const response = Buffer.alloc(4); // DWORD *pResponse
  return Promise.resolve(
    send(null, sessionId, titleBuf, titleBuf.length, msgBuf, msgBuf.length, MB_OK, 0, response, true),
  ).then((sent) => (sent ? { ok: true } : { ok: false, reason: 'native-unavailable' }));
}

// macOS: osascript display notification. Аргументы не идут через shell —
// экранировать нужно только кавычки внутри AppleScript-литерала.
function macToast(message, title, spawnSync) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    const r = spawnSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], { timeout: 5000 });
    return r?.status === 0 ? { ok: true } : { ok: false, reason: 'notify-failed' };
  } catch {
    return { ok: false, reason: 'notify-failed' };
  }
}

// Linux: агент-служба работает от root, уведомление должно появиться у
// консольного пользователя — notify-send через sudo -u. Консольный юзер —
// первый обычный пользователь (uid 1000); нет такого — честный отказ.
function linuxConsoleUser(spawnSync) {
  try {
    const r = spawnSync('getent', ['passwd', '1000'], { encoding: 'utf8', timeout: 3000 });
    return String(r?.stdout ?? '').split(':')[0].trim();
  } catch {
    return '';
  }
}

function linuxToast(message, title, spawnSync) {
  const user = linuxConsoleUser(spawnSync);
  if (!user) return { ok: false, reason: 'no-console-user' };
  try {
    // notify-send <summary> [body]: summary — заголовок, body — текст
    const r = spawnSync('sudo', ['-u', user, 'notify-send', title, message], { timeout: 5000 });
    return r?.status === 0 ? { ok: true } : { ok: false, reason: 'notify-failed' };
  } catch {
    return { ok: false, reason: 'notify-failed' };
  }
}

// Ленивая загрузка koffi (как в native-input): реальный импорт — только когда
// mock не подставлен и платформа реально Windows.
async function defaultKoffi() {
  const mod = await import('koffi');
  return mod.default ?? mod;
}

export async function showToast(platform, text, { koffi = null, spawnSync = nodeSpawnSync, title = 'EnotDesk' } = {}) {
  const message = sanitizeToastText(text);
  if (!message) return { ok: false, reason: 'invalid:text' };
  try {
    if (platform === 'win32') return await winToast(message, title, koffi ?? await defaultKoffi());
    if (platform === 'darwin') return macToast(message, title, spawnSync);
    if (platform === 'linux') return linuxToast(message, title, spawnSync);
  } catch {
    // библиотеки ОС могут отсутствовать — честный отказ вместо падения
    return { ok: false, reason: 'native-unavailable' };
  }
  return { ok: false, reason: 'unsupported-platform' };
}

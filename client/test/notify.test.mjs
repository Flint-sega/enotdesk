import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeToastText, showToast, TOAST_MAX } from '../lib/notify.mjs';

// Шов notify.mjs (interfaces.md): showToast(platform, text) → {ok, reason?}.
// Платформенные вызовы гоняются на моках koffi и spawnSync — никакого Electron
// и реальных OS-библиотек; честный статус на каждую неудачу.

// ---- sanitizeToastText: лимит 500 и контроль-символы ----

test('sanitizeToastText: лимит 500 символов, управляющие символы вычищаются', () => {
  assert.equal(TOAST_MAX, 500, 'лимит текста из таска — 500 символов');
  assert.equal(sanitizeToastText('  привет  '), 'привет', 'обрезка краёв');
  assert.equal(sanitizeToastText('a'.repeat(700)).length, 500, 'длинный текст режется до лимита');
  assert.equal(sanitizeToastText('строка1\nстрока2'), 'строка1\nстрока2', 'перенос строки в сообщении допустим');
  assert.equal(sanitizeToastText('кол\u0000 ContentView\u001B[31mтекст\u007F'), 'кол ContentView[31mтекст', 'управляющие символы терминала вычищаются');
  assert.equal(sanitizeToastText(42), '', 'не-строка — пусто');
  assert.equal(sanitizeToastText(null), '', 'null — пусто');
});

// ---- Windows: активная консольная сессия (WTSGetActiveConsoleSessionId) + WTSSendMessageW ----

function mockKoffi({ sent = true, fail = null, sessionId = 7 } = {}) {
  const calls = { loads: [], funcs: [], sendArgs: null };
  const koffi = {
    load(name) {
      calls.loads.push(name);
      if (fail === 'load') throw new Error('нет системной библиотеки');
      if (name === 'kernel32.dll') {
        return {
          func(sig, opts) {
            calls.funcs.push({ sig, opts });
            return () => sessionId;
          },
        };
      }
      return {
        func(sig, opts) {
          calls.funcs.push({ sig, opts });
          if (fail === 'func') throw new Error('не удалось объявить функцию');
          return (...args) => {
            calls.sendArgs = args;
            return sent ? Promise.resolve(true) : Promise.resolve(false);
          };
        },
      };
    },
  };
  return { calls, koffi };
}

test('showToast win32: sessionId берётся из WTSGetActiveConsoleSessionId и пробрасывается в WTSSendMessageW', async () => {
  const { calls, koffi } = mockKoffi({ sessionId: 7 });
  const r = await showToast('win32', 'Перезагрузите кассу', { koffi, title: 'EnotDesk' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.loads, ['kernel32.dll', 'wtsapi32.dll'], 'сначала активная сессия, затем отправка');
  const active = calls.funcs.find((f) => /WTSGetActiveConsoleSessionId/.test(f.sig));
  assert.ok(active, 'объявлена WTSGetActiveConsoleSessionId');
  const sendDecl = calls.funcs.find((f) => /WTSSendMessageW/.test(f.sig));
  assert.ok(sendDecl, 'объявлена именно WTSSendMessageW');
  assert.equal(sendDecl.opts?.stdcall, true, 'stdcall-конвенция WinAPI');
  // Несущая деталь: async-прототип — иначе bWait/timeout=0 заморозит heartbeat-цикл агента до нажатия OK
  assert.equal(sendDecl.opts?.async, true, 'WTSSendMessageW объявлена async — цикл агента не блокируется');
  const a = calls.sendArgs;
  assert.equal(a[0], null, 'WTS_CURRENT_SERVER_HANDLE — локальный сервер');
  assert.equal(a[1], 7, 'активная консольная сессия из kernel32, не выдуманная константа');
  assert.equal(a[6], 0, 'MB_OK');
  assert.equal(a[7], 0, 'timeout 0 — ждать ответа');
  assert.equal(a[9], true, 'bWait — ждём реакции пользователя');
  assert.equal(a[3], ('EnotDesk'.length + 1) * 2, 'длина заголовка в байтах UTF-16, с терминатором');
  assert.equal(a[5], ('Перезагрузите кассу'.length + 1) * 2, 'длина сообщения в байтах UTF-16, с терминатором');
  assert.equal(a[2].toString('utf16le'), 'EnotDesk\u0000', 'заголовок — UTF-16LE с терминатором');
  assert.equal(a[4].toString('utf16le'), 'Перезагрузите кассу\u0000', 'сообщение — UTF-16LE с терминатором');
});

test('showToast win32: нет активной консольной сессии (экран входа) — честный отказ без отправки', async () => {
  const { calls, koffi } = mockKoffi({ sessionId: 0 });
  const r = await showToast('win32', 'текст', { koffi });
  assert.deepEqual(r, { ok: false, reason: 'no-active-session' });
  assert.equal(calls.sendArgs, null, 'WTSSendMessageW не вызывалась — посылать некому');
});

test('showToast win32: sanitize применяется до вызова WinAPI (лимит и чистка)', async () => {
  const { calls, koffi } = mockKoffi();
  const long = 'х'.repeat(700);
  await showToast('win32', `зло\u0007${long}`, { koffi });
  const msg = calls.sendArgs[4].toString('utf16le');
  assert.equal(msg.length - 1, 500, 'сообщение (без терминатора) обрезано до 500');
  assert.ok(!msg.includes('\u0007'), 'управляющий символ не прошёл в диалог');
});

test('showToast win32: не удалось отправить / нет библиотеки — честный отказ', async () => {
  const refused = await showToast('win32', 'текст', { koffi: mockKoffi({ sent: false }).koffi });
  assert.deepEqual(refused, { ok: false, reason: 'native-unavailable' }, 'WTSSendMessageW вернул FALSE');

  const noLib = await showToast('win32', 'текст', { koffi: mockKoffi({ fail: 'load' }).koffi });
  assert.deepEqual(noLib, { ok: false, reason: 'native-unavailable' }, 'системная библиотека не загрузилась');

  const noFunc = await showToast('win32', 'текст', { koffi: mockKoffi({ fail: 'func' }).koffi });
  assert.deepEqual(noFunc, { ok: false, reason: 'native-unavailable' }, 'функция не объявилась');
});

// ---- macOS: osascript display notification (мок spawnSync) ----

function mockSpawnSync(respond) {
  const calls = [];
  const fn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return respond(file, args, opts) ?? { status: 0 };
  };
  fn.calls = calls;
  return fn;
}

test('showToast darwin: osascript display notification, статус 0 — доставлено', async () => {
  const spawnSync = mockSpawnSync(() => ({ status: 0 }));
  const r = await showToast('darwin', 'Сервер обновлён', { spawnSync, title: 'EnotDesk' });
  assert.deepEqual(r, { ok: true });
  const call = spawnSync.calls[0];
  assert.equal(call.file, 'osascript');
  const script = call.args[1];
  assert.match(script, /display notification "Сервер обновлён"/, 'текст уходит в notification');
  assert.match(script, /with title "EnotDesk"/, 'заголовок');
});

test('showToast darwin: кавычки и бэкслеши экранируются, сбой — честный отказ', async () => {
  const spawnSync = mockSpawnSync(() => ({ status: 0 }));
  await showToast('darwin', 'сказал "привет" \\ и ушёл', { spawnSync });
  const script = spawnSync.calls[0].args[1];
  assert.match(script, /сказал \\"привет\\" \\\\ и ушёл/, 'экранирование не даёт вырваться из строки');

  const failed = await showToast('darwin', 'текст', { spawnSync: mockSpawnSync(() => ({ status: 1 })) });
  assert.deepEqual(failed, { ok: false, reason: 'notify-failed' }, 'ненулевой статус osascript');

  const broken = await showToast('darwin', 'текст', {
    spawnSync: mockSpawnSync(() => { throw new Error('osascript не найден'); }),
  });
  assert.deepEqual(broken, { ok: false, reason: 'notify-failed' }, 'упавший запуск не рвёт вызывающего');
});

// ---- Linux: notify-send от консольного пользователя (getent + sudo -u) ----

test('showToast linux: консольный пользователь из getent, notify-send через sudo -u', async () => {
  const spawnSync = mockSpawnSync((file) => (file === 'getent'
    ? { status: 0, stdout: 'kassa:x:1000:1000:Касса,,,:/home/kassa:/bin/bash\n' }
    : { status: 0 }));
  const r = await showToast('linux', 'Проверьте терминал', { spawnSync, title: 'EnotDesk' });
  assert.deepEqual(r, { ok: true });
  assert.equal(spawnSync.calls.length, 2, 'getent, затем notify-send');
  assert.equal(spawnSync.calls[0].file, 'getent');
  assert.deepEqual(spawnSync.calls[0].args, ['passwd', '1000'], 'обычный пользователь — uid 1000');
  const send = spawnSync.calls[1];
  assert.equal(send.file, 'sudo');
  assert.deepEqual(send.args.slice(0, 4), ['-u', 'kassa', 'notify-send', 'EnotDesk'], 'от консольного пользователя');
  assert.equal(send.args[4], 'Проверьте терминал', 'текст сообщения');
});

test('showToast linux: нет консольного пользователя / сбой notify-send — честный отказ', async () => {
  const nobody = await showToast('linux', 'текст', { spawnSync: mockSpawnSync(() => ({ status: 1, stdout: '' })) });
  assert.deepEqual(nobody, { ok: false, reason: 'no-console-user' }, 'getent пуст — показывать некому');

  const failed = await showToast('linux', 'текст', {
    spawnSync: mockSpawnSync((file) => (file === 'getent'
      ? { status: 0, stdout: 'kassa:x:1000:1000::/home/kassa:/bin/bash\n' }
      : { status: 1 })),
  });
  assert.deepEqual(failed, { ok: false, reason: 'notify-failed' });
});

// ---- общее: пустой текст и неизвестная платформа ----

test('showToast: пустой текст и неизвестная ОС — честные отказы', async () => {
  assert.deepEqual(await showToast('win32', '   ', { koffi: mockKoffi().koffi }), { ok: false, reason: 'invalid:text' });
  assert.deepEqual(await showToast('win32', '', { koffi: mockKoffi().koffi }), { ok: false, reason: 'invalid:text' });
  assert.deepEqual(await showToast('sunos', 'текст'), { ok: false, reason: 'unsupported-platform' });
  assert.deepEqual(await showToast('', 'текст'), { ok: false, reason: 'unsupported-platform' });
});

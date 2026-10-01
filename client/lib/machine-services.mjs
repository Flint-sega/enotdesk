// Сервисы machine-сеанса (W-U6, v0.5): агент принимает от оператора каналы
// 'chat' и 'file' наряду с 'term'. Честные границы v0.5: чат — только
// оператор→машина (тост консольному пользователю, ответного UI на машине нет);
// файлы — только оператор→машина, сохранение в общую папку с уведомлением.
// Обратные направления (tray-UI на машине) — не v0.5, см. docs/MANUAL-QA.md.
import path from 'node:path';
import os from 'node:os';
import * as fs from 'node:fs';
import { parseChatMessage } from './chat.mjs';
import {
  parseFileControl, createFileReceiver, fileAccept, fileReject,
  sanitizeFileName, FILE_MAX,
} from './file-transfer.mjs';

export const CHAT_TOAST_MAX = 500;
// Троттл тостов чата (ревью v0.5: на Windows WTSSendMessageW — модальный диалог,
// серия сообщений складывает стопку модалей консольному пользователю).
export const CHAT_TOAST_MIN_MS = 3000;

export function machineFilesDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  // Служба работает от SYSTEM: %USERPROFILE% указывает в systemprofile — общая
  // %PUBLIC% видна пользователю за консолью. На mac/linux агент и так в
  // пользовательском контексте (launchd asuser / systemd user) — homedir.
  if (platform === 'win32') return path.join(env.PUBLIC || 'C:\\Users\\Public', 'EnotDesk Files');
  return path.join(home, 'EnotDesk Files');
}

export function createMachineServices({
  fsImpl = fs,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  notify = () => {},
  log = console,
} = {}) {
  const dir = machineFilesDir({ platform, env, home });

  function wireChat(ch) {
    let lastToastAt = 0;
    ch.onmessage = (m) => {
      const msg = parseChatMessage(typeof m?.data === 'string' ? m.data : '');
      if (!msg) return;
      const now = Date.now();
      if (now - lastToastAt < CHAT_TOAST_MIN_MS) return; // флуд глушим, не стопкой модалей
      lastToastAt = now;
      notify(`💬 ${msg.text.slice(0, CHAT_TOAST_MAX)}`);
    };
    return true;
  }

  function wireFile(ch) {
    ch.binaryType = 'arraybuffer';
    // Приёмник живёт в замыкании канала (не сервиса): обрыв канала/сеанса сбрасывает
    // его через onclose — прерванная передача не отравляет следующие (ревью v0.5)
    let rx = null;
    ch.onclose = () => {
      rx = null;
    };
    ch.onmessage = (m) => {
      if (typeof m?.data === 'string') {
        const ctl = parseFileControl(m.data);
        if (!ctl) return;
        if (ctl.kind === 'meta') {
          const name = sanitizeFileName(ctl.name);
          if (rx || !name || !Number.isInteger(ctl.size) || ctl.size < 1 || ctl.size > FILE_MAX) {
            try { ch.send(fileReject(ctl.id)); } catch { /* канал закрывается */ }
            if (rx) log.warn?.('Служба: файл уже принимается — новый отклонён');
            return;
          }
          rx = createFileReceiver({ id: ctl.id, name, size: ctl.size });
          try { ch.send(fileAccept(ctl.id)); } catch { /* канал закрывается */ }
        } else if (ctl.kind === 'done') {
          // id сверяется: чужой/опоздавший done не сохраняет мусор и не сбрасывает
          // идущий приём (ревью v0.5)
          if (rx?.meta?.id === ctl.id) {
            const current = rx;
            rx = null;
            void saveReceived(current);
          }
        }
        return;
      }
      rx?.push(m.data);
    };
    return true;
  }

  async function saveReceived(receiver) {
    try {
      const blob = receiver.complete();
      const name = receiver.meta.name;
      if (!blob) {
        notify(`⚠ Файл «${name}» пришёл повреждённым`);
        return;
      }
      const buf = Buffer.from(await blob.arrayBuffer());
      fsImpl.mkdirSync(dir, { recursive: true });
      const target = uniquePath(fsImpl, dir, name);
      fsImpl.writeFileSync(target, buf);
      notify(`📁 Файл сохранён: ${path.basename(target)}`);
    } catch (e) {
      log.warn?.(`Служба: файл не сохранён (${e?.message ?? e})`);
      notify('⚠ Не удалось сохранить файл');
    }
  }

  function handleChannel(label, ch) {
    if (!ch) return false;
    if (label === 'chat') return wireChat(ch);
    if (label === 'file') return wireFile(ch);
    return false;
  }

  return { handleChannel, filesDir: dir };
}

function uniquePath(fsImpl, dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fsImpl.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
  }
  return candidate;
}

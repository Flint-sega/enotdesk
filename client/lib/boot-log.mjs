// Boot-лог окна (v0.6.4, приём RustDesk): ВСЕГДА включённый файловый журнал
// жизни окна/приложения — «окно не молчит» не должно требовать маркера или
// живого stdout: пустое окно у пользователя при чистой системе должно
// оставлять след на диске. Базовая линия на всех платформах (старт, готовность,
// сбои загрузки страницы, падение рендерера); расширенная Windows-диагностика
// по маркеру — svc-diag.mjs. Секреты не пишем: одноразовые join-токены
// маскируются. Логгер никогда не бросает — сбой диагностики не имеет права
// влиять на приложение.

import fs from 'node:fs';
import path from 'node:path';
import { maskJoinTokens } from './svc-diag.mjs';

export function createBootLog({ userDataDir } = {}) {
  const dir = userDataDir ?? null;
  if (!dir) return { write: () => false, logFile: null };
  const logFile = path.join(dir, 'enotdesk-boot.log');
  // Потолок с одноступенчатой ротацией (.1) — как у svc-diag: лог всегда
  // включён и без потолка рос бы неограниченно на машинах пользователей.
  const MAX_LOG_BYTES = 1024 * 1024;
  const write = (tag, msg) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
          fs.rmSync(`${logFile}.1`, { force: true });
          fs.renameSync(logFile, `${logFile}.1`);
        }
      } catch { /* ротация best-effort, записи она не мешает */ }
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${tag}] ${maskJoinTokens(String(msg))}\n`);
      return true;
    } catch { return false; }
  };
  return { write, logFile };
}

// Диагностика Windows-службы (W-U2, ретест 28–29.09): best-effort файловый лог.
// Включается маркер-файлом, НЕ переменной окружения: главная гипотеза №1 —
// «Environment REG_MULTI_SZ не доставлен процессу службы», значит гейт по env
// замкнул бы сам себя. Секреты (код регистрации/токены/пароли) в лог не пишутся —
// только факт наличия и длина. Логгер никогда не бросает: сбой диагностики не
// имеет права влиять на службу.
//
// Пути: %ProgramData%\EnotDesk\svc-diag.enabled (маркер) и svc-diag.log (лог).
// Маркер создаёт windows-diag.bat (выдаётся с /widget-test/ на сервере; при
// --update установщика маршрут Caddy восстанавливать вручную — MANUAL-QA).

import fs from 'node:fs';
import path from 'node:path';

// Ключи с этими подстроками маскируются: значение секретно, важен факт доставки
const SECRET_HINTS = /CODE|TOKEN|PASSWORD|SECRET|KEY/i;

export function maskEnvValue(key, value) {
  if (SECRET_HINTS.test(key)) {
    if (value === undefined || value === null) return '<unset>';
    if (value === '') return '<set,empty>'; // доставлен, но пуст — не «не доставлен»
    return `<set,len:${value.length}>`;
  }
  return String(value ?? '');
}

// enotdesk://join?…&t=<одноразовый токен> приходит argv'ем — токен в лог не пишется
export function maskJoinTokens(s) {
  return String(s).replace(/(enotdesk:\/\/[^"'\\\s]*?[?&]t=)[^"'\\\s]+/gi, '$1<masked>');
}

// Срез EDESK_*/ENOT_* окружения в логобезопасном виде — одна строка на процесс.
export function envDiagSlice(env = process.env) {
  return Object.keys(env)
    .filter((k) => /^EDESK_|^ENOT_/.test(k))
    .sort()
    .map((k) => `${k}=${maskEnvValue(k, env[k])}`)
    .join(' ');
}

// Вне Windows (и в тестах без programData) — глухой логгер: включить нельзя.
export function createSvcDiag({ programData } = {}) {
  const dir = programData
    ?? (process.platform === 'win32' ? (process.env.PROGRAMDATA || 'C:\\ProgramData') : null);
  if (!dir) return { enabled: () => false, write: () => false, logFile: null };
  const enotDir = path.join(dir, 'EnotDesk');
  const marker = path.join(enotDir, 'svc-diag.enabled');
  const logFile = path.join(enotDir, 'svc-diag.log');
  const enabled = () => {
    try { return fs.existsSync(marker); } catch { return false; }
  };
  const write = (tag, msg) => {
    try {
      if (!enabled()) return false;
      fs.mkdirSync(enotDir, { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${tag}] ${msg}\n`);
      return true;
    } catch { return false; }
  };
  return { enabled, write, logFile };
}

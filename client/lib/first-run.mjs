// Резолв адреса сервера при старте клиента. Порядок (spec §первый запуск):
//   сохранённый в settings.json → файл enotdesk-server.txt рядом с exe →
//   вшитый при сборке (ENOT_BAKED_SERVER_URL) → дефолт 127.0.0.1:8080.
// Чтение файла, парсинг и порядок спрятаны здесь (interfaces.md); наружу —
// только resolveServerUrl. Модуль чистый от Electron: работает и в тестах.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeServerUrl } from './server-url.mjs';

export const SERVER_FILE_NAME = 'enotdesk-server.txt';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080';

// Адрес — одна строка; читать больше 4 КБ из файла рядом с exe незачем.
const FILE_LIMIT_BYTES = 4096;

// Адрес из файла или baked задан намеренно (сборщик/self-hostер), а не напечатан
// вслепую — но allowInsecureHttp на эти источники всё равно не распространяется
// (SEC-006): не-loopback http из подброшенного файла/сборки отклоняется. Loopback
// http допустим (дефолт 127.0.0.1:8080 — он и есть http), https — всегда.
function validateProvisioned(raw) {
  return normalizeServerUrl(raw);
}

// null — файла нет или он не читается: источник честно пропускается.
function readServerFile(dir) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, SERVER_FILE_NAME), 'r');
    const buf = Buffer.alloc(FILE_LIMIT_BYTES);
    const bytes = fs.readSync(fd, buf, 0, FILE_LIMIT_BYTES, 0);
    return buf.toString('utf8', 0, bytes);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* уже закрыт */ } }
  }
}

function firstNonEmptyLine(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// saved.json пишется экраном настроек, который уже прогнал normalizeServerUrl;
// рука в settings.json и протухший/сломанный адрес не доверяются вслепую (SEC-007):
// та же валидация при каждом старте, невалидный — источник пропущен (дефолт).
// savedAllowInsecureHttp — явная галочка «Разрешить HTTP» из тех же настроек.
function savedCandidate(saved, savedAllowInsecureHttp) {
  if (typeof saved !== 'string') return null;
  const trimmed = saved.trim();
  if (!trimmed) return null;
  const norm = normalizeServerUrl(trimmed, { allowInsecureHttp: savedAllowInsecureHttp === true });
  return norm.ok ? { url: norm.url, source: 'saved' } : null;
}

function provisionedCandidate(raw, source) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const norm = validateProvisioned(raw);
  return norm.ok ? { url: norm.url, source } : null;
}

export function resolveServerUrl({ saved = null, savedAllowInsecureHttp = false, execPath = null, baked = null, defaultUrl = DEFAULT_SERVER_URL } = {}) {
  const candidates = [savedCandidate(saved, savedAllowInsecureHttp)];

  if (typeof execPath === 'string' && execPath) {
    const text = readServerFile(path.dirname(execPath));
    if (text !== null) {
      const line = firstNonEmptyLine(text);
      if (line) candidates.push(provisionedCandidate(line, 'file'));
    }
  }

  candidates.push(provisionedCandidate(baked, 'baked'));
  candidates.push({ url: defaultUrl, source: 'default' });

  return candidates.find((c) => c !== null);
}

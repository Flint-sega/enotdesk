// Бэкап БД EnotDesk: VACUUM INTO в отдельный файл — безопасно на живой базе
// (WAL не мешает), чистый node:sqlite, sqlite3-CLI не нужен.
// CLI: node server/backup.mjs <dbPath> <backupDir> [keep]   (keep — сколько свежих дампов хранить)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const STAMP_RE = /^enotdesk-\d{4}-\d{2}-\d{2}T\d{6}Z\.db$/;

export function backupDb(dbPath, backupDir, { keep = 10, stamp = new Date(), listDir = (d) => fs.readdirSync(d), unlink = (f) => fs.unlinkSync(f) } = {}) {
  if (!dbPath || !backupDir) throw new Error('Нужны dbPath и backupDir');
  fs.mkdirSync(backupDir, { recursive: true });
  // 2026-01-02T03:04:05.789Z → 2026-01-02T030405Z: сортируется лексикографически
  const stampText = `${stamp.toISOString().replace(/:/g, '').split('.')[0]}Z`;
  const name = `enotdesk-${stampText}.db`;
  const target = path.join(backupDir, name);
  const src = new DatabaseSync(dbPath);
  try {
    // путь внутри SQL-строки: одинарные кавычки удваиваем
    src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  // ретенция: свежие keep дампов, включая только что созданный
  const dumps = listDir(backupDir).filter((f) => STAMP_RE.test(f)).sort().reverse();
  const removed = [];
  for (const f of dumps.slice(keep)) {
    unlink(path.join(backupDir, f));
    removed.push(f);
  }
  return { file: target, name, removed };
}

// CLI: при запуске напрямую — выполняем бэкап и печатаем результат.
const [, , cliDb, cliDir, cliKeep] = process.argv;
if (cliDb && cliDir) {
  const r = backupDb(cliDb, cliDir, { keep: cliKeep ? parseInt(cliKeep, 10) : 10 });
  console.log(`Бэкап готов: ${r.file}`);
  if (r.removed.length) console.log(`Удалены старые дампы: ${r.removed.join(', ')}`);
}

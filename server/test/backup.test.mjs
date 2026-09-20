import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDb } from '../backup.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('backup: дамп читается, ретенция держит keep свежих, права 0600', (t) => {
  const dir = tmpDir(t);
  const dbPath = path.join(dir, 'src.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42)');
  db.close();

  const out = tmpDir(t);
  // созданный «вчера» дамп уходит при keep=1
  const yesterday = new Date(Date.now() - 86_400_000);
  fs.writeFileSync(path.join(out, `enotdesk-${yesterday.toISOString().replace(/:/g, '').split('.')[0]}Z.db`), 'старый');

  const r = backupDb(dbPath, out, { keep: 1 });
  assert.ok(fs.existsSync(r.file), 'дамп создан');
  assert.equal(r.removed.length, 1, 'старый дамп удалён');
  const reopened = new DatabaseSync(r.file);
  const x = reopened.prepare('SELECT x FROM t').get();
  reopened.close();
  assert.equal(x.x, 42, 'дамп содержит данные');
  const mode = fs.statSync(r.file).mode & 0o777;
  assert.equal(mode, 0o600, `права дампа 0600 (фактически ${mode.toString(8)})`);
});

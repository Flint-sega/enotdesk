// Страж уборки временных файлов. До 24.10 тесты оставили во временной папке
// десятки тысяч файлов (5,8 ГБ): tmpDb удалял базу раньше, чем закрывался сервер,
// и SQLite бросал -wal/-shm, а тесты хаба и boot-log не удаляли свои папки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, startServer, tmpDb } from './util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('startServer на своей базе: после теста сервер закрыт, папки базы нет (ни -wal/-shm, ни relay)', async (t) => {
  let srv;
  await t.test('сервер пишет в базу', async (st) => {
    srv = await startServer(st);
    assert.equal((await api(srv.base, 'POST', '/sessions')).status, 201);
    assert.ok(fs.existsSync(`${srv.dbPath}-wal`), 'база в WAL — рядом живёт -wal');
  });
  assert.equal(srv.inst.db.isOpen, false);
  assert.equal(fs.existsSync(path.dirname(srv.dbPath)), false);
});

test('tmpDb раньше startServer: уборка всё равно сначала закрывает сервер на этой базе', async (t) => {
  let srv;
  await t.test('база из tmpDb', async (st) => {
    const dbPath = tmpDb(st); // хук уборки зарегистрирован раньше хука закрытия сервера
    srv = await startServer(st, { dbPath });
    assert.equal((await api(srv.base, 'POST', '/sessions')).status, 201);
  });
  assert.equal(srv.inst.db.isOpen, false);
  // на Windows открытая база не удаляется — папка осталась бы, если бы порядок сломался
  assert.equal(fs.existsSync(path.dirname(srv.dbPath)), false);
});

test('тесты и скрипты, которые создают что-то во временной папке, это удаляют', () => {
  // грубая, но дешёвая проверка по тексту файла: создал временное — в файле есть удаление
  const creates = /mkdtempSync\(|tmpdir\(\)/;
  const removes = /\b(rmSync|unlinkSync)\(/;
  const offenders = [];
  for (const dir of ['server/test', 'client/test', 'hub/test', 'scripts']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
      if (!name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(ROOT, dir, name), 'utf8');
      if (creates.test(src) && !removes.test(src)) offenders.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(offenders, [], 'создают временные файлы и не удаляют их');
});

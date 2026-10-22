import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.mjs';
import { bootstrapAdmin, resetTotp } from '../bootstrap.mjs';

// Аварийное снятие 2FA с консоли сервера (ADR 0037): снимает секрет и резервные
// коды, завершает входы пользователя, пишет запись безопасности даже при
// выключенном журнале действий.

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-reset2fa-'));
  const dbPath = path.join(dir, 'e.db');
  assert.equal(bootstrapAdmin(dbPath, { login: 'Boss', name: 'Босс', password: 'correct-horse-1' }).ok, true);
  return dbPath;
}

test('reset-2fa: снимает секрет, резервные коды и входы; пишет журнал безопасности', () => {
  const dbPath = freshDb();
  const db = openDb(dbPath);
  const id = db.prepare("SELECT id FROM users WHERE login='boss'").get().id;
  db.prepare("UPDATE users SET totp_enabled=1, totp_secret_enc='x', totp_last_counter=5 WHERE id=?").run(id);
  db.prepare("INSERT INTO totp_backup_codes (user_id, code_hash, created_at) VALUES (?, 'h1', 'now'), (?, 'h2', 'now')").run(id, id);
  db.prepare("INSERT INTO auth_tokens (token_hash, user_id, expires_at, created_at) VALUES ('t1', ?, '2999-01-01', 'now')").run(id);
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('audit.enabled', '0', 'now')").run();
  db.close();

  const r = resetTotp(dbPath, '  BOSS ');
  assert.deepEqual(r, { ok: true, wasEnabled: true, tokens: 1 });

  const check = openDb(dbPath);
  const u = check.prepare('SELECT totp_enabled, totp_secret_enc, totp_last_counter FROM users WHERE id=?').get(id);
  assert.deepEqual({ ...u }, { totp_enabled: 0, totp_secret_enc: null, totp_last_counter: null });
  assert.equal(check.prepare('SELECT count(*) c FROM totp_backup_codes WHERE user_id=?').get(id).c, 0);
  assert.equal(check.prepare('SELECT count(*) c FROM auth_tokens WHERE user_id=?').get(id).c, 0);
  const a = check.prepare("SELECT target_id, detail FROM audit WHERE action='totp.reset.console'").get();
  assert.ok(a, 'запись журнала есть, хотя журнал действий выключен');
  assert.equal(a.target_id, id);
  assert.equal(JSON.parse(a.detail).login, 'boss');
  check.close();
});

test('reset-2fa: честные отказы — нет логина, нет базы, нет пользователя', () => {
  const dbPath = freshDb();
  assert.deepEqual(resetTotp(dbPath, ''), { ok: false, reason: 'no_login' });
  assert.deepEqual(resetTotp(path.join(os.tmpdir(), 'enot-no-such-db', 'x.db'), 'boss'), { ok: false, reason: 'no_db' });
  assert.deepEqual(resetTotp(dbPath, 'ghost'), { ok: false, reason: 'not_found' });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { openDb, auditLog } from './db.mjs';
import { hashPassword } from './crypto.mjs';

// Ядро бутстрапа: интерактивный CLI вызывает её, тесты — тоже.
export function bootstrapAdmin(dbPath, { login, name, password }) {
  if (fs.existsSync(dbPath)) {
    const db = openDb(dbPath);
    const admins = db.prepare("SELECT count(*) c FROM users WHERE role='admin' AND active=1").get().c;
    db.close();
    if (admins > 0) {
      return { ok: false, reason: 'exists' };
    }
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = openDb(dbPath);
  try {
    db.prepare(`INSERT INTO users (id, login, name, role, active, password, created_at)
                VALUES (?,?,?,'admin',1,?,?)`)
      .run(crypto.randomUUID(), login.trim().toLowerCase(), name.trim(), hashPassword(password), new Date().toISOString());
    auditLog(db, null, 'bootstrap.admin', null, { login: login.trim().toLowerCase() });
    return { ok: true };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { ok: false, reason: 'login_taken' };
    throw e;
  } finally {
    db.close();
  }
}

export async function runCli(dbPath) {
  console.log('Создание первого администратора EnotDesk.');
  const tty = process.stdin.isTTY === true;

  let pipedLines = null;
  if (!tty) {
    // скриптовый ввод (CI/пайп): stdin может закрыться до вопросов — читаем целиком
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    pipedLines = Buffer.concat(chunks).toString('utf8').split('\n');
    while (pipedLines.length && pipedLines[pipedLines.length - 1] === '') pipedLines.pop();
  }

  const mute = { on: false };
  const rl = tty ? readline.createInterface({
    input: process.stdin,
    output: new Writable({ write(c, _e, cb) { if (!mute.on) process.stdout.write(c); cb(); } }),
    terminal: true,
  }) : null;
  const ask = (prompt, hidden = false) => {
    if (!tty) { process.stdout.write(prompt); return Promise.resolve(pipedLines.shift() ?? ''); }
    return new Promise((resolve) => {
      mute.on = hidden; // в TTY скрываем ввод
      process.stdout.write(prompt);
      rl.question('', (answer) => {
        mute.on = false;
        if (hidden) process.stdout.write('\n');
        resolve(answer);
      });
    });
  };
  try {
    const login = (await ask('Логин: ')).trim();
    if (login.length < 3) { console.log('Ошибка: логин от 3 символов.'); process.exitCode = 1; return; }
    const name = (await ask('Имя (отображаемое): ')).trim();
    if (!name) { console.log('Ошибка: имя не может быть пустым.'); process.exitCode = 1; return; }
    const password = await ask('Пароль (ввод скрыт): ', true);
    if (password.length < 8) { console.log('Ошибка: пароль от 8 символов.'); process.exitCode = 1; return; }
    const repeat = await ask('Повторите пароль: ', true);
    if (password !== repeat) { console.log('Ошибка: пароли не совпадают.'); process.exitCode = 1; return; }
    const result = bootstrapAdmin(dbPath, { login, name, password });
    if (!result.ok) {
      if (result.reason === 'exists') console.log('Ошибка: администратор уже существует. База данных не изменена.');
      else if (result.reason === 'login_taken') console.log('Ошибка: такой логин уже занят.');
      process.exitCode = 1;
      return;
    }
    console.log('Готово: первый администратор создан.');
  } finally {
    if (rl) rl.close();
  }
}

// Аварийное снятие 2FA (ADR 0037, учения восстановления): админ потерял телефон
// и резервные коды, или база восстановлена без прежнего ENOT_SECRET_KEY. Только
// с консоли сервера (доступ к файлу БД = доступ ко всему), не через API. Снимает
// секрет и резервные коды, отзывает токены входа пользователя; запись в журнал
// безопасности пишется всегда (префикс totp.).
export function resetTotp(dbPath, login) {
  const norm = String(login ?? '').trim().toLowerCase();
  if (!norm) return { ok: false, reason: 'no_login' };
  if (!fs.existsSync(dbPath)) return { ok: false, reason: 'no_db' };
  const db = openDb(dbPath);
  try {
    const user = db.prepare('SELECT id, totp_enabled FROM users WHERE login = ?').get(norm);
    if (!user) return { ok: false, reason: 'not_found' };
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_counter = NULL WHERE id = ?').run(user.id);
      const codes = db.prepare('DELETE FROM totp_backup_codes WHERE user_id = ?').run(user.id).changes;
      const tokens = db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(user.id).changes;
      auditLog(db, null, 'totp.reset.console', user.id, { login: norm, wasEnabled: user.totp_enabled === 1, codes, tokens });
      db.exec('COMMIT');
      return { ok: true, wasEnabled: user.totp_enabled === 1, tokens };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

export function runResetTotpCli(dbPath, login) {
  const r = resetTotp(dbPath, login);
  if (!r.ok) {
    const msg = { no_login: 'укажите логин: node server/main.mjs reset-2fa <логин>', no_db: `нет базы ${dbPath} (задайте ENOT_DB)`, not_found: 'пользователь не найден' }[r.reason];
    console.log(`Ошибка: ${msg}.`);
    process.exitCode = 1;
    return;
  }
  console.log(r.wasEnabled
    ? `Готово: 2FA снята, входы пользователя завершены (${r.tokens}). Пусть войдёт по паролю и включит 2FA заново.`
    : 'Готово: 2FA у пользователя и так была выключена; входы завершены.');
}

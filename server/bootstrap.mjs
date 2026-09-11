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

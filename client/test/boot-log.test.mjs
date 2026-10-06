import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, chmodSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBootLog } from '../lib/boot-log.mjs';

// Boot-лог (v0.6.4): always-on журнал окна. Контракт — как у svc-diag:
// никогда не бросает, ротация 1 МБ (.1), join-токены маскируются.
// Всегда-включённость = отсутствие маркера: писать должно и без настроек.

test('boot-log: пишет в файл без всяких маркеров', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enot-boot-'));
  const log = createBootLog({ userDataDir: dir });
  assert.equal(log.write('boot', 'старт 0.6.4'), true);
  const text = readFileSync(log.logFile, 'utf8');
  assert.match(text, /\[boot\] старт 0\.6\.4/);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T/); // ISO-штамп времени
});

test('boot-log: join-токен в сообщении маскируется', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enot-boot-'));
  const log = createBootLog({ userDataDir: dir });
  log.write('join', 'enotdesk://join?server=http%3A%2F%2F10.0.0.1%3A8080&t=SUPERSECRET123');
  const text = readFileSync(log.logFile, 'utf8');
  assert.ok(!text.includes('SUPERSECRET123'), 'токен не должен попасть в лог');
  assert.match(text, /t=<masked>/);
});

test('boot-log: ротация при переполнении (потолок 1 МБ → .1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enot-boot-'));
  const log = createBootLog({ userDataDir: dir });
  writeFileSync(log.logFile, 'x'.repeat(1024 * 1024 + 1));
  log.write('boot', 'после ротации');
  assert.ok(statSync(`${log.logFile}.1`).size > 1024 * 1024, 'старый лог уехал в .1');
  const fresh = readFileSync(log.logFile, 'utf8');
  assert.match(fresh, /после ротации/);
  assert.ok(statSync(log.logFile).size < 1024 * 1024);
});

test('boot-log: недоступный каталог — false, не throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enot-boot-ro-'));
  const sub = join(dir, 'locked');
  mkdirSync(sub);
  chmodSync(sub, 0o500); // r-x: append упадёт — логгер обязан вернуть false
  const log = createBootLog({ userDataDir: join(sub, 'boot') });
  assert.equal(log.write('boot', 'не должно бросить'), false);
  assert.ok(!existsSync(join(sub, 'boot', 'enotdesk-boot.log')));
});

test('boot-log: без userDataDir — глухой логгер (null-путь), не throw', () => {
  const log = createBootLog({});
  assert.equal(log.write('boot', 'никуда'), false);
  assert.equal(log.logFile, null);
  assert.equal(createBootLog().write('boot', 'x'), false);
});

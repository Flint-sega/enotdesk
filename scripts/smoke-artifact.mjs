#!/usr/bin/env node
// Смоук СОБРАННОЙ программы (ACCEPTANCE U-5): запускает упакованный EnotDesk
// в режиме EDESK_SMOKE и проверяет, что окно поднялось, ворота ввода закрыты
// до согласия и открыты после, снимок окна получен, процесс сам завершился.
//   node scripts/smoke-artifact.mjs <путь к исполняемому файлу> [аргументы…]
// Linux без дисплея: xvfb-run -a node scripts/smoke-artifact.mjs dist/linux-unpacked/enotdesk --no-sandbox
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [exe, ...args] = process.argv.slice(2);
if (!exe) {
  console.error('использование: node scripts/smoke-artifact.mjs <исполняемый файл> [аргументы…]');
  process.exit(2);
}
if (!fs.existsSync(exe)) {
  console.error(`нет файла ${exe}`);
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-artifact-smoke-'));
const logFile = path.join(work, 'smoke.log');
const shotFile = path.join(work, 'smoke.png');
const env = {
  ...process.env,
  EDESK_SMOKE: '1',
  EDESK_SMOKE_LOG: logFile,
  EDESK_SMOKE_PATH: shotFile,
  EDESK_ALLOW_MULTI: '1', // не столкнуться с запущенным экземпляром на машине разработчика
};

const started = Date.now();
const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const timer = setTimeout(() => {
  console.error(`таймаут ${TIMEOUT_MS} мс — программа не завершилась сама`);
  child.kill('SIGKILL');
}, TIMEOUT_MS);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  const report = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const text = report || out; // файл — основной источник, stdout — запасной
  const checks = [
    ['процесс завершился сам с кодом 0', code === 0 && signal == null],
    ['окно создано', /SMOKE window: created/.test(text)],
    ['ворота ввода закрыты до согласия', /SMOKE gate closed before approved: true/.test(text)],
    ['ворота ввода открыты после согласия', /SMOKE gate open after approved: true/.test(text)],
    ['снимок окна получен', fs.existsSync(shotFile) && fs.statSync(shotFile).size > 1024],
    ['итог SMOKE OK', /SMOKE OK/.test(text)],
  ];
  console.log(text.trim() || '(вывода нет)');
  console.log(`\nвремя до выхода: ${elapsed} мс (код ${code}${signal ? `, сигнал ${signal}` : ''})`);
  let failed = 0;
  for (const [name, okay] of checks) {
    console.log(`${okay ? 'OK  ' : 'FAIL'} ${name}`);
    if (!okay) failed += 1;
  }
  if (failed && out && report) console.log(`\n--- stdout/stderr ---\n${out.slice(-4000)}`);
  if (process.env.SMOKE_KEEP_SHOT) {
    try { fs.copyFileSync(shotFile, process.env.SMOKE_KEEP_SHOT); } catch { /* снимка нет — уже FAIL выше */ }
  }
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
});

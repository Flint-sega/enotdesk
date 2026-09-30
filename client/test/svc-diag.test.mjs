import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskEnvValue, envDiagSlice, maskJoinTokens, createSvcDiag } from '../lib/svc-diag.mjs';

// W-U2 diag (ретест 28–29.09): файловый лог службы. Ключевые контракты:
// секреты маскируются, логгер никогда не бросает, гейт — маркер-файл, не env.

test('maskEnvValue: секреты превращаются в <set,len:N>, обычные значения идут как есть', () => {
  assert.equal(maskEnvValue('EDESK_AGENT_CODE', 'abc123'), '<set,len:6>');
  assert.equal(maskEnvValue('ENOT_SECRET_KEY', 'x'.repeat(32)), `<set,len:32>`);
  // доставленный-но-пустой секрет НЕ равен «не доставлен» — разные ярлыки
  // (ревью v0.4.4: иначе diag уводил диагноз в неверную гипотезу)
  assert.equal(maskEnvValue('EDESK_AGENT_PASSWORD', ''), '<set,empty>');
  assert.equal(maskEnvValue('EDESK_AGENT_TOKEN', undefined), '<unset>');
  assert.equal(maskEnvValue('EDESK_AGENT', '1'), '1', 'флаг не секрет');
  assert.equal(maskEnvValue('EDESK_AGENT_NAME', 'WIN-PC'), 'WIN-PC');
  assert.equal(maskEnvValue('ENOT_DB', '/data/enotdesk.db'), '/data/enotdesk.db');
});

test('maskJoinTokens: одноразовый токен join-ссылки не попадает в лог', () => {
  const argv = JSON.stringify([
    'C:\\Program Files\\EnotDesk\\EnotDesk.exe',
    'enotdesk://join?server=https%3A%2F%2Fsupport.example.com&t=SECRET_JOIN_TOKEN_789xyz',
  ]);
  const masked = maskJoinTokens(argv);
  assert.ok(!masked.includes('SECRET_JOIN_TOKEN_789xyz'), 'токен замаскирован');
  assert.ok(masked.includes('t=<masked>'), 'ссылка остаётся, токен скрыт');
  // не-join argv не трогается
  assert.equal(maskJoinTokens(JSON.stringify(['EnotDesk.exe', '--no-sandbox'])), JSON.stringify(['EnotDesk.exe', '--no-sandbox']));
});

test('envDiagSlice: только EDESK_*/ENOT_*, сортировка, секреты замаскированы', () => {
  const slice = envDiagSlice({
    PATH: '/usr/bin',
    EDESK_AGENT: '1',
    EDESK_AGENT_CODE: 'top-secret-code',
    ENOT_SECRET_KEY: 'k'.repeat(10),
    HOME: '/root',
  });
  assert.ok(!slice.includes('/usr/bin') && !slice.includes('/root'), 'посторонние ключи не попадают');
  assert.ok(slice.startsWith('EDESK_AGENT=1 EDESK_AGENT_CODE=<set,len:15>'), `сортировка+маска: ${slice}`);
  assert.ok(slice.endsWith('ENOT_SECRET_KEY=<set,len:10>'), slice);
  assert.ok(!slice.includes('top-secret-code'), 'секрет не попал в срез');
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-diag-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('createSvcDiag: без маркера не пишет; с маркером — дописывает строки с тегом и временем', (t) => {
  const dir = tmpDir(t);
  const diag = createSvcDiag({ programData: dir });
  assert.equal(diag.write('main', 'первая строка'), false, 'маркера нет — записи нет');
  assert.equal(fs.existsSync(path.join(dir, 'EnotDesk', 'svc-diag.log')), false);
  fs.mkdirSync(path.join(dir, 'EnotDesk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'EnotDesk', 'svc-diag.enabled'), '');
  assert.equal(diag.enabled(), true);
  assert.equal(diag.write('svc', 'вторая строка'), true);
  assert.equal(diag.write('main', 'третья'), true);
  const log = fs.readFileSync(diag.logFile, 'utf8');
  const lines = log.trim().split('\n');
  assert.equal(lines.length, 2, 'запись без маркера не дошла');
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[svc\] вторая строка$/);
  assert.match(lines[1], /\[main\] третья$/);
});

test('createSvcDiag: сбой записи честно глотается — диагностика не влияет на службу', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'EnotDesk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'EnotDesk', 'svc-diag.enabled'), '');
  const diag = createSvcDiag({ programData: dir });
  assert.equal(diag.write('svc', 'ok'), true);
  // лог-файл становится каталогом: appendFileSync упадёт EISDIR
  fs.rmSync(diag.logFile);
  fs.mkdirSync(diag.logFile);
  assert.equal(diag.write('svc', 'fail-path'), false, 'сбой записи не бросает');
  assert.equal(diag.enabled(), true, 'маркер жив — логгер просто молчит');
});

test('createSvcDiag: вне win32 без programData — глухой логгер', () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const diag = createSvcDiag();
    assert.equal(diag.enabled(), false);
    assert.equal(diag.write('svc', 'x'), false);
    assert.equal(diag.logFile, null);
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
});

test('createSvcDiag: потолок лога с ротацией — маркер забыт, файл не растёт вечно', (t) => {
  // маркер нельзя выключить из кода (только bat off) — без потолка лог рос бы
  // неограниченно на машинах конечных пользователей (ревью v0.4.6, medium)
  const dir = tmpDir(t);
  fs.mkdirSync(path.join(dir, 'EnotDesk'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'EnotDesk', 'svc-diag.enabled'), '');
  const diag = createSvcDiag({ programData: dir });
  fs.writeFileSync(diag.logFile, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(diag.write('svc', 'после ротации'), true);
  assert.ok(fs.existsSync(`${diag.logFile}.1`), 'переполненный лог переехал в .1');
  const fresh = fs.readFileSync(diag.logFile, 'utf8');
  assert.ok(fresh.length < 4096, 'свежий лог начался с нуля');
  assert.match(fresh.trim(), /\[svc\] после ротации$/);
});

// Копия бэкапов вне сервера и наблюдатель (план 1.0, п. 1.12; ACCEPTANCE S-4, S-6):
// scripts/offsite-serve.sh — принудительная команда ssh на сервере, scripts/watch-server.sh —
// таймеры на машине-наблюдателе. Скрипты исполняются по-настоящему; age, ssh и Healthchecks
// подменены: age — заглушкой со строкой версии формата, ssh — вызовом offsite-serve.sh,
// Healthchecks — локальным HTTP-сервером. Живое шифрование age и ssh — на стенде (MANUAL-QA).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVE = path.join(ROOT, 'scripts', 'offsite-serve.sh');
const WATCH = path.join(ROOT, 'scripts', 'watch-server.sh');
const skip = process.platform === 'win32' ? 'скрипты сервера — bash, Linux/macOS' : false;

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
  });
}

const stamp = (hAgo) => `${new Date(Date.now() - hAgo * 3600e3).toISOString().replace(/:/g, '').split('.')[0]}Z`;
function dump(dir, prefix, hAgo, body = `${prefix}${hAgo}`) {
  const f = path.join(dir, `${prefix}${stamp(hAgo)}.db`);
  fs.writeFileSync(f, body);
  const t = new Date(Date.now() - hAgo * 3600e3);
  fs.utimesSync(f, t, t);
  return path.basename(f);
}

// временная папка «сервера»: бэкапы, файл получателей, заглушки age и ssh
function stand(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-offsite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  const recipients = path.join(dir, 'recipients.txt');
  fs.writeFileSync(recipients, '# ключ владельца\nage1testrecipient\n');
  const age = path.join(dir, 'fake-age');
  fs.writeFileSync(age, `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/age-args"\nprintf 'age-encryption.org/v1\\n'\nexec cat\n`, { mode: 0o755 });
  const ssh = path.join(dir, 'fake-ssh');
  // как sshd с принудительной командой: последний аргумент — SSH_ORIGINAL_COMMAND
  fs.writeFileSync(ssh, `#!/bin/bash\nprintf '%s\\n' "$*" > "${dir}/ssh-args"\nSSH_ORIGINAL_COMMAND="\${@: -1}" exec bash "${SERVE}"\n`, { mode: 0o755 });
  // файл настроек — свой, иначе тест прочитал бы /etc/enotdesk/offsite.conf машины
  const env = { ENOT_OFFSITE_BACKUPS: backups, ENOT_OFFSITE_DATA: dir, ENOT_OFFSITE_RECIPIENTS: recipients, ENOT_OFFSITE_AGE: age,
    ENOT_OFFSITE_CONF: path.join(dir, 'offsite.conf') };
  return { dir, backups, recipients, age, ssh, env };
}

// поддельный Healthchecks + health сервера, ответ health меняется по ходу теста
async function fakeHttp(t) {
  const pings = [];
  const state = { health: { status: 200, body: '{"ok":true,"version":"9.9.9","activeSessions":0}' } };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/api/v1/health') { res.writeHead(state.health.status); res.end(state.health.body); return; }
      pings.push({ url: req.url, body });
      res.end('OK');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { base: `http://127.0.0.1:${srv.address().port}`, pings, state };
}

function conf(dir, lines) {
  const f = path.join(dir, 'watch.conf');
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
}

test('offsite-serve status: свежие дампы обеих баз, их возраст и диск', { skip }, async (t) => {
  const s = stand(t);
  dump(s.backups, 'enotdesk-', 30);
  const main = dump(s.backups, 'enotdesk-', 3);
  const hub = dump(s.backups, 'hub-', 5);
  const r = await run('bash', [SERVE, 'status'], s.env);
  assert.equal(r.code, 0, r.stderr);
  const js = JSON.parse(r.stdout.toString());
  assert.equal(js.ok, true);
  assert.equal(js.mainBackup, main);
  assert.equal(js.mainBackupAgeH, 3);
  assert.equal(js.hubBackup, hub);
  assert.equal(js.hubBackupAgeH, 5);
  assert.ok(js.diskUsedPct >= 0 && js.diskUsedPct <= 100);
  // дополнительные базы не настроены — пустой список, а не пропажа
  assert.deepEqual(js.extraBackups, []);
  assert.equal(js.extraBackupAgeH, null);
  assert.equal(js.extraMissing, 0);
});

test('offsite-serve status без дампов: ok=false и null, а не падение', { skip }, async (t) => {
  const s = stand(t);
  const js = JSON.parse((await run('bash', [SERVE, 'status'], s.env)).stdout.toString());
  assert.equal(js.ok, false);
  assert.equal(js.mainBackup, null);
  assert.equal(js.hubBackupAgeH, null);
});

test('offsite-serve: команды только из списка, хвост в SSH_ORIGINAL_COMMAND — отказ', { skip }, async (t) => {
  const s = stand(t);
  dump(s.backups, 'enotdesk-', 1);
  for (const cmd of ['fetch; id', 'status && id', 'cat /etc/shadow', '']) {
    const r = await run('bash', [SERVE], { ...s.env, SSH_ORIGINAL_COMMAND: cmd });
    assert.equal(r.code, 2, `«${cmd}» отклонена`);
    assert.equal(r.stdout.length, 0);
  }
});

test('offsite-serve fetch: без age или без ключей получателя открытую копию не отдаёт', { skip }, async (t) => {
  const s = stand(t);
  dump(s.backups, 'enotdesk-', 1, 'SECRET-DB');
  fs.writeFileSync(s.recipients, '# пусто\n\n');
  let r = await run('bash', [SERVE, 'fetch'], s.env);
  assert.equal(r.code, 3);
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr, /нет открытых ключей/);
  fs.writeFileSync(s.recipients, 'age1testrecipient\n');
  r = await run('bash', [SERVE, 'fetch'], { ...s.env, ENOT_OFFSITE_AGE: path.join(s.dir, 'no-such-age') });
  assert.equal(r.code, 3);
  assert.equal(r.stdout.length, 0);
});

test('offsite-serve fetch: tar свежих дампов + SHA256SUMS, шифрование на файл получателей', { skip }, async (t) => {
  const s = stand(t);
  dump(s.backups, 'enotdesk-', 26, 'OLD');
  const main = dump(s.backups, 'enotdesk-', 2, 'MAIN-DB');
  const hub = dump(s.backups, 'hub-', 2, 'HUB-DB');
  // дамп моложе минуты ещё может писаться (VACUUM INTO) — берётся предыдущий
  fs.writeFileSync(path.join(s.backups, `enotdesk-${stamp(0)}.db`), 'PARTIAL');
  const r = await run('bash', [SERVE, 'fetch'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.dir, 'age-args'), 'utf8').trim(), `-R ${s.recipients}`);
  const head = 'age-encryption.org/v1\n';
  assert.equal(r.stdout.subarray(0, head.length).toString(), head);
  const tarFile = path.join(s.dir, 'copy.tar');
  fs.writeFileSync(tarFile, r.stdout.subarray(head.length));
  const out = path.join(s.dir, 'out');
  fs.mkdirSync(out);
  assert.equal((await run('tar', ['-xf', tarFile, '-C', out])).code, 0);
  assert.deepEqual(fs.readdirSync(out).sort(), ['SHA256SUMS', hub, main].sort());
  assert.equal(fs.readFileSync(path.join(out, main), 'utf8'), 'MAIN-DB');
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8');
  assert.match(sums, new RegExp(`^[0-9a-f]{64}  ${main}$`, 'm'));
  assert.match(sums, new RegExp(`^[0-9a-f]{64}  ${hub}$`, 'm'));
});

// папка дополнительной базы: свой таймер кладёт туда дампы с тем же форматом имён
function extraDir(s, name = 'extra') {
  const d = path.join(s.dir, name);
  fs.mkdirSync(d);
  return d;
}

test('offsite-serve: дополнительные базы — возраст в status, дамп и сумма в копии, пропажа не срывает fetch', { skip }, async (t) => {
  const s = stand(t);
  const main = dump(s.backups, 'enotdesk-', 2, 'MAIN-DB');
  const ex = extraDir(s);
  dump(ex, 'tk-', 30, 'OLD-TK');
  const tk = dump(ex, 'tk-', 6, 'TK-DB');
  // ссылка с именем свежего дампа может вести на чужой файл — root её не берёт
  const foreign = path.join(s.dir, 'foreign');
  fs.writeFileSync(foreign, 'FOREIGN');
  const old = new Date(Date.now() - 2 * 3600e3);
  fs.utimesSync(foreign, old, old);
  fs.symlinkSync(foreign, path.join(ex, `tk-${stamp(1)}.db`));
  const env = { ...s.env, ENOT_OFFSITE_EXTRA: `${ex}/tk- ${path.join(s.dir, 'none')}/nx-` };

  let r = await run('bash', [SERVE, 'status'], env);
  assert.equal(r.code, 0, r.stderr);
  const js = JSON.parse(r.stdout.toString());
  assert.equal(js.mainBackup, main);
  assert.deepEqual(js.extraBackups, [tk]);
  assert.equal(js.extraBackupAgeH, 6);
  assert.equal(js.extraMissing, 1, 'база без дампа видна наблюдателю');

  r = await run('bash', [SERVE, 'fetch'], env);
  assert.equal(r.code, 0, r.stderr);
  const head = 'age-encryption.org/v1\n';
  const tarFile = path.join(s.dir, 'copy.tar');
  fs.writeFileSync(tarFile, r.stdout.subarray(head.length));
  const out = path.join(s.dir, 'out');
  fs.mkdirSync(out);
  assert.equal((await run('tar', ['-xf', tarFile, '-C', out])).code, 0);
  assert.deepEqual(fs.readdirSync(out).sort(), ['SHA256SUMS', main, tk].sort());
  assert.equal(fs.readFileSync(path.join(out, tk), 'utf8'), 'TK-DB');
  assert.match(fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8'), new RegExp(`^[0-9a-f]{64}  ${tk}$`, 'm'));
});

test('offsite-serve: файл настроек — строка ENOT_OFFSITE_EXTRA; чужая запись, мусор и плохие пути — отказ', { skip }, async (t) => {
  const s = stand(t);
  dump(s.backups, 'enotdesk-', 2);
  const ex = extraDir(s);
  const tk = dump(ex, 'tk-', 3);
  const cf = s.env.ENOT_OFFSITE_CONF;
  fs.writeFileSync(cf, `# дополнительные базы\nENOT_OFFSITE_EXTRA="${ex}/tk-"\n`, { mode: 0o600 });
  let r = await run('bash', [SERVE, 'status'], s.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.toString()).extraBackups, [tk]);

  fs.chmodSync(cf, 0o620);
  r = await run('bash', [SERVE, 'status'], s.env);
  assert.equal(r.code, 5);
  assert.equal(r.stdout.length, 0);
  assert.match(r.stderr, /запись доступна не только владельцу/);
  fs.chmodSync(cf, 0o600);

  const bad = ['ENOT_OFFSITE_EXTRA=relative/tk-', `ENOT_OFFSITE_EXTRA=/tk-`, `ENOT_OFFSITE_EXTRA=${ex}/../tk-`,
    `ENOT_OFFSITE_EXTRA=${ex}/`, `ENOT_OFFSITE_EXTRA=${ex}/enotdesk-`, `ENOT_OFFSITE_EXTRA=${ex}/a;id`,
    `ENOT_OFFSITE_EXTRA=${ex}/*`, `ENOT_OFFSITE_EXTRA=${ex}/tk- ${ex}/tk-`, 'RM_RF=/'];
  for (const line of bad) {
    fs.writeFileSync(cf, `${line}\n`);
    for (const cmd of ['status', 'fetch']) {
      r = await run('bash', [SERVE, cmd], s.env);
      assert.equal(r.code, 5, `«${line}» → ${cmd}`);
      assert.equal(r.stdout.length, 0);
    }
  }
});

test('watch-server check: дополнительная база — возраст в итоге; старый дамп или пропажа — тревога', { skip }, async (t) => {
  const s = stand(t);
  const h = await fakeHttp(t);
  dump(s.backups, 'enotdesk-', 4);
  const fresh = extraDir(s, 'fresh');
  dump(fresh, 'tk-', 5);
  const stale = extraDir(s, 'stale');
  dump(stale, 'tk-', 30);
  const cfg = conf(s.dir, [`WATCH_URL=${h.base}`, 'WATCH_SSH=root@server', `WATCH_SSH_BIN=${s.ssh}`,
    `WATCH_PING_CHECK=${h.base}/ping/c`, 'WATCH_RETRY_SEC=0']);

  let r = await run('bash', [WATCH, 'check', cfg], { ...s.env, ENOT_OFFSITE_EXTRA: `${fresh}/tk-` });
  assert.equal(r.code, 0, r.stdout.toString() + r.stderr);
  assert.equal(h.pings.at(-1).url, '/ping/c');
  assert.match(h.pings.at(-1).body, /на сервере: диск \d+%, дамп 4 ч, доп\. 5 ч/);

  r = await run('bash', [WATCH, 'check', cfg], { ...s.env, ENOT_OFFSITE_EXTRA: `${stale}/tk-` });
  assert.equal(r.code, 1);
  assert.equal(h.pings.at(-1).url, '/ping/c/fail');
  assert.match(h.pings.at(-1).body, /дампу доп\. базы 30 ч/);

  r = await run('bash', [WATCH, 'check', cfg], { ...s.env, ENOT_OFFSITE_EXTRA: `${path.join(s.dir, 'none')}/tk-` });
  assert.equal(r.code, 1);
  assert.equal(h.pings.at(-1).url, '/ping/c/fail');
  assert.match(h.pings.at(-1).body, /нет готового дампа доп\. базы: 1/);
});

test('watch-server check: всё в порядке — пинг успеха; health упал — пинг /fail с причиной', { skip }, async (t) => {
  const s = stand(t);
  const h = await fakeHttp(t);
  dump(s.backups, 'enotdesk-', 4);
  const cfg = conf(s.dir, [`WATCH_URL=${h.base}`, `WATCH_SSH=root@server`, `WATCH_SSH_BIN=${s.ssh}`,
    `WATCH_PING_CHECK="${h.base}/ping/check-uuid"`, 'WATCH_RETRY_SEC=0']);
  let r = await run('bash', [WATCH, 'check', cfg], s.env);
  assert.equal(r.code, 0, r.stdout.toString() + r.stderr);
  assert.equal(h.pings.at(-1).url, '/ping/check-uuid');
  assert.match(h.pings.at(-1).body, /сервер: версия 9\.9\.9/);
  assert.match(h.pings.at(-1).body, /на сервере: диск \d+%, дамп 4 ч/);
  // -n: иначе ssh съедает stdin — так на стенде оборвался скрипт, пришедший через bash -s
  assert.match(fs.readFileSync(path.join(s.dir, 'ssh-args'), 'utf8'), /^-n .*root@server status$/m);

  h.state.health = { status: 502, body: 'Bad Gateway' };
  r = await run('bash', [WATCH, 'check', cfg], s.env);
  assert.equal(r.code, 1);
  assert.equal(h.pings.at(-1).url, '/ping/check-uuid/fail');
  assert.match(h.pings.at(-1).body, /^СБОЙ сервер: /m);

  h.state.health = { status: 200, body: '{"ok":false}' };
  r = await run('bash', [WATCH, 'check', cfg], s.env);
  assert.equal(r.code, 1);
  assert.equal(h.pings.at(-1).url, '/ping/check-uuid/fail');
  assert.match(h.pings.at(-1).body, /ok":true/);
});

test('watch-server check: старый дамп и переполненный диск — тревога', { skip }, async (t) => {
  const s = stand(t);
  const h = await fakeHttp(t);
  dump(s.backups, 'enotdesk-', 30);
  dump(s.backups, 'hub-', 2);
  const cfg = conf(s.dir, [`WATCH_URL=${h.base}`, 'WATCH_SSH=root@server', `WATCH_SSH_BIN=${s.ssh}`,
    `WATCH_PING_CHECK=${h.base}/ping/c`, 'WATCH_RETRY_SEC=0', 'WATCH_DISK_MAX=0']);
  const r = await run('bash', [WATCH, 'check', cfg], s.env);
  assert.equal(r.code, 1);
  const last = h.pings.at(-1);
  assert.equal(last.url, '/ping/c/fail');
  assert.match(last.body, /дампу основной базы 30 ч/);
  assert.match(last.body, /диск занят/);
  assert.match(last.body, /^сервер: версия/m, 'то, что в порядке, тоже видно в тексте тревоги');
});

test('watch-server check: URL пинга не попадает в аргументы curl', { skip }, async (t) => {
  // секрет проверки Healthchecks виден любому, кто смотрит список процессов, если он в argv
  const src = fs.readFileSync(WATCH, 'utf8');
  const pingFn = src.slice(src.indexOf('ping_hc() {'), src.indexOf('ssh_server() {'));
  assert.match(pingFn, /printf 'url = "%s%s"\\n' "\$1" "\$2" \| curl .* -K -/);
  assert.doesNotMatch(pingFn, /curl[^|]*"\$1"/);
  t.diagnostic('ping_hc передаёт URL через конфиг curl на stdin');
});

test('watch-server pull: копия age в папке, старые сверх WATCH_KEEP удалены, пинг копии', { skip }, async (t) => {
  const s = stand(t);
  const h = await fakeHttp(t);
  dump(s.backups, 'enotdesk-', 2, 'MAIN-DB');
  const dir = path.join(s.dir, 'offsite');
  fs.mkdirSync(dir);
  for (const old of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) {
    fs.writeFileSync(path.join(dir, `enotdesk-offsite-${old}.tar.age`), 'old');
  }
  const cfg = conf(s.dir, [`WATCH_URL=${h.base}`, 'WATCH_SSH=root@server', `WATCH_SSH_BIN=${s.ssh}`,
    `WATCH_DIR=${dir}`, 'WATCH_KEEP=2', `WATCH_PING_BACKUP=${h.base}/ping/b`, 'WATCH_RETRY_SEC=0']);
  const r = await run('bash', [WATCH, 'pull', cfg], s.env);
  assert.equal(r.code, 0, r.stdout.toString() + r.stderr);
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2);
  assert.equal(files[0], 'enotdesk-offsite-20260103T000000Z.tar.age');
  assert.match(files[1], /^enotdesk-offsite-\d{8}T\d{6}Z\.tar\.age$/);
  assert.equal(fs.readFileSync(path.join(dir, files[1])).subarray(0, 21).toString(), 'age-encryption.org/v1');
  assert.equal(h.pings.at(-1).url, '/ping/b');
  assert.match(h.pings.at(-1).body, /всего копий 2/);
});

test('watch-server pull: сервер отказал — файла нет, пинг /fail с текстом сервера', { skip }, async (t) => {
  const s = stand(t);
  const h = await fakeHttp(t);
  dump(s.backups, 'enotdesk-', 2);
  fs.writeFileSync(s.recipients, '');
  const dir = path.join(s.dir, 'offsite');
  const cfg = conf(s.dir, [`WATCH_URL=${h.base}`, 'WATCH_SSH=root@server', `WATCH_SSH_BIN=${s.ssh}`,
    `WATCH_DIR=${dir}`, `WATCH_PING_BACKUP=${h.base}/ping/b`, 'WATCH_RETRY_SEC=0']);
  const r = await run('bash', [WATCH, 'pull', cfg], s.env);
  assert.equal(r.code, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(h.pings.at(-1).url, '/ping/b/fail');
  assert.match(h.pings.at(-1).body, /нет открытых ключей age/);
});

test('watch-server: неизвестный ключ конфига и пустой WATCH_URL — отказ до проверок', { skip }, async (t) => {
  const s = stand(t);
  let r = await run('bash', [WATCH, 'check', conf(s.dir, ['WATCH_URL=http://x', 'RM_RF=/'])]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /неизвестный ключ «RM_RF»/);
  r = await run('bash', [WATCH, 'check', conf(s.dir, ['WATCH_TLS_DAYS=3'])]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /нужен WATCH_URL/);
  r = await run('bash', [WATCH, 'nope', conf(s.dir, ['WATCH_URL=http://x'])]);
  assert.equal(r.code, 2);
  // кавычка в URL пинга дописала бы в конфиг curl свою опцию (например, output = …)
  r = await run('bash', [WATCH, 'check', conf(s.dir, ['WATCH_URL=http://x', 'WATCH_PING_CHECK=https://hc/x"&output="/tmp/p'])]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /недопустимый символ/);
  r = await run('bash', [WATCH, 'check', conf(s.dir, ['WATCH_URL=http://x', 'WATCH_PING_CHECK=https://hc/a b'])]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /недопустимый символ/);
  r = await run('bash', [WATCH, 'check', conf(s.dir, ['WATCH_URL=http://x', 'WATCH_PING_BACKUP=file:///etc/passwd'])]);
  assert.equal(r.code, 2);
});

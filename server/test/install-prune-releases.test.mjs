// Уборка старых релизов в scripts/install-server.sh (слово владельца 27.10.2026: на проде
// накопилось 36 релизов, ~800 МБ). Функция prune_releases вырезается из установщика и
// исполняется bash'ем на временной папке: остаются текущий и KEEP_PREV_RELEASES предыдущих.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// на Windows checkout отдаёт \r\n — контракт текста сверяем по \n
const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'install-server.sh'), 'utf8').replace(/\r\n/g, '\n');
const skip = process.platform === 'win32' ? 'установщик сервера — bash, Linux/macOS' : false;
const start = SCRIPT.indexOf('prune_releases() {');
const FN = SCRIPT.slice(start, SCRIPT.indexOf('\n}\n', start) + 3);

const R = (day, hash) => `202610${String(day).padStart(2, '0')}120000-${hash}`;
const SIX = [R(1, 'aaa'), R(2, 'bbb'), R(3, 'ccc'), R(4, 'ddd'), R(5, 'eee'), R(6, 'fff'), 'legacy-20260930080000'];

// releases/<имя>/server/main.mjs и current: имя релиза, 'dir' (каталог вместо симлинка),
// 'outside' (симлинк мимо releases/) или null (current нет)
function stand(t, names, current) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rel = path.join(root, 'releases');
  for (const n of names) {
    fs.mkdirSync(path.join(rel, n, 'server'), { recursive: true });
    fs.writeFileSync(path.join(rel, n, 'server', 'main.mjs'), n);
  }
  const cur = path.join(root, 'current');
  if (current === 'dir') fs.mkdirSync(cur);
  else if (current === 'outside') {
    fs.mkdirSync(path.join(root, 'elsewhere', 'x'), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere', 'x'), cur);
  } else if (current) fs.symlinkSync(path.join(rel, current), cur);
  return { rel, cur };
}

function prune({ rel, cur }) {
  const harness = `set -euo pipefail
info() { echo "==> $*"; }
RELEASES_DIR="$1"; CURRENT_LINK="$2"; KEEP_PREV_RELEASES=3
${FN}
prune_releases`;
  const r = spawnSync('bash', ['-c', harness, 'prune', rel, cur], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, left: fs.readdirSync(rel).sort() };
}

test('install-server.sh: остаются текущий и 3 предыдущих, legacy и старые удаляются', { skip }, (t) => {
  const { out, left } = prune(stand(t, SIX, R(6, 'fff')));
  assert.deepEqual(left, [R(3, 'ccc'), R(4, 'ddd'), R(5, 'eee'), R(6, 'fff')]);
  assert.match(out, /удалено 3, оставлены текущий и 3 предыдущих/);
});

test('install-server.sh: текущий — старый релиз (тот же hash переиспользован) — он остаётся вместе с 3 свежими', { skip }, (t) => {
  const { left } = prune(stand(t, SIX, R(2, 'bbb')));
  assert.deepEqual(left, [R(2, 'bbb'), R(4, 'ddd'), R(5, 'eee'), R(6, 'fff')]);
});

test('install-server.sh: релизов не больше четырёх — ничего не удаляется и не печатается', { skip }, (t) => {
  const names = [R(1, 'aaa'), R(2, 'bbb'), R(3, 'ccc'), R(4, 'ddd')];
  const { out, left } = prune(stand(t, names, R(4, 'ddd')));
  assert.deepEqual(left, names);
  assert.equal(out, '');
});

for (const [what, current] of [['current — каталог, а не симлинк', 'dir'], ['current смотрит мимо releases/', 'outside'], ['current нет', null]]) {
  test(`install-server.sh: ${what} — релизы не трогаются`, { skip }, (t) => {
    const { left } = prune(stand(t, SIX, current));
    assert.deepEqual(left, [...SIX].sort());
  });
}

test('install-server.sh: уборка — один раз, после health обеих служб, и держит 3 предыдущих', () => {
  assert.match(SCRIPT, /^KEEP_PREV_RELEASES=3$/m);
  const calls = [...SCRIPT.matchAll(/^\s*prune_releases\s*$/gm)];
  assert.equal(calls.length, 1, 'вызов один');
  const at = calls[0].index;
  assert.ok(at > SCRIPT.indexOf('info "health: ok"'), 'после health сервера');
  assert.ok(at > SCRIPT.indexOf('hub health: ok'), 'после health хаба');
  assert.ok(start > 0 && FN.endsWith('\n}\n'), 'функция найдена целиком');
});

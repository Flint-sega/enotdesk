// P2-5 (ревью 22.10): права на %ProgramData%\EnotDesk — без Windows, на
// фейковой файловой системе и записи вызовов icacls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secureProgramDataDir, aclPlan, isPlainFile, icaclsPath } from '../lib/programdata-acl.mjs';
import { createSvcDiag } from '../lib/svc-diag.mjs';

const BASE = 'C:\\ProgramData';
const DIR = 'C:\\ProgramData\\EnotDesk';

// entries: path → { kind: 'dir'|'file'|'link', nlink }
function fakeFs(entries = {}) {
  const map = new Map(Object.entries(entries));
  const enoent = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  const stat = (e) => ({
    isSymbolicLink: () => e.kind === 'link',
    isDirectory: () => e.kind === 'dir',
    isFile: () => e.kind === 'file',
    nlink: e.nlink ?? 1,
  });
  const children = (dir) => [...map.keys()].filter((k) => path.win32.dirname(k) === dir);
  return {
    map,
    lstatSync: (p) => { const e = map.get(p); if (!e) throw enoent(p); return stat(e); },
    renameSync: (a, b) => {
      for (const k of [...map.keys()]) {
        if (k === a || k.startsWith(`${a}\\`)) { map.set(b + k.slice(a.length), map.get(k)); map.delete(k); }
      }
    },
    mkdirSync: (p) => {
      for (let cur = p; cur !== BASE && !map.has(cur); cur = path.win32.dirname(cur)) map.set(cur, { kind: 'dir' });
    },
    readdirSync: (p) => children(p).map((k) => ({ name: path.win32.basename(k) })),
    rmdirSync: (p) => { if (map.get(p)?.kind !== 'link') throw new Error('not a link'); map.delete(p); },
    unlinkSync: (p) => { map.delete(p); },
  };
}

const record = () => { const calls = []; return { calls, run: (args) => { calls.push(args); } }; };

test('programdata-acl: вне Windows ничего не делает', () => {
  const r = record();
  const out = secureProgramDataDir({ platform: 'darwin', run: r.run, fsApi: fakeFs() });
  assert.equal(out.skipped, true);
  assert.equal(r.calls.length, 0);
});

test('programdata-acl: пустая машина — папка и helper создаются, ACL по SID', () => {
  const f = fakeFs();
  const r = record();
  const out = secureProgramDataDir({ platform: 'win32', programData: BASE, fsApi: f, run: r.run });
  assert.equal(out.ok, true, out.error);
  assert.ok(f.map.has(DIR) && f.map.has(`${DIR}\\helper`));
  assert.deepEqual(r.calls, aclPlan(DIR));
  const flat = r.calls.flat().join(' ');
  // только SID — имена групп на русской Windows другие
  assert.match(flat, /\*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(flat, /\*S-1-5-32-544:\(OI\)\(CI\)F/);
  assert.doesNotMatch(flat, /SYSTEM|Administrators|Users/);
  // владелец — SYSTEM, явные записи сброшены, наследование выключено
  assert.deepEqual(r.calls[0], [DIR, '/setowner', '*S-1-5-18', '/Q']);
  assert.deepEqual(r.calls[1], [DIR, '/reset', '/Q']);
  assert.ok(r.calls[2].includes('/inheritance:r') && r.calls[2].includes('/grant:r'));
  // Пользователям — только сама папка, без наследования на журналы
  assert.ok(r.calls[2].includes('*S-1-5-32-545:(RX)'));
  // helper\ — RX пользователям: копию хелпера запускает токен пользователя
  assert.deepEqual(r.calls.at(-1), [`${DIR}\\helper`, '/grant', '*S-1-5-32-545:(OI)(CI)RX', '/Q']);
  // содержимое тоже принадлежит SYSTEM (журнал от токена пользователя был его)
  assert.ok(r.calls.some((c) => c[0] === `${DIR}\\*` && c[1] === '/setowner' && c[2] === '*S-1-5-18' && c.includes('/T')));
});

test('programdata-acl: папка-junction отодвигается, создаётся настоящая', () => {
  const f = fakeFs({ [DIR]: { kind: 'link' } });
  const r = record();
  const out = secureProgramDataDir({ platform: 'win32', programData: BASE, fsApi: f, run: r.run, now: () => 42 });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.moved, `${DIR}.untrusted-42`);
  assert.equal(f.map.get(`${DIR}.untrusted-42`).kind, 'link');
  assert.equal(f.map.get(DIR).kind, 'dir');
});

test('programdata-acl: ссылки внутри удаляются после закрытия корня, чужие файлы не трогаем', () => {
  const f = fakeFs({
    [DIR]: { kind: 'dir' },
    [`${DIR}\\enotdesk-video.log`]: { kind: 'file', nlink: 2 }, // жёсткая ссылка на чужой файл
    [`${DIR}\\svc-diag.log`]: { kind: 'link' }, // symlink
    [`${DIR}\\svc-diag.enabled`]: { kind: 'file' },
    [`${DIR}\\helper`]: { kind: 'dir' },
    [`${DIR}\\helper\\enotdesk-video.exe`]: { kind: 'file' },
    [`${DIR}\\helper\\x`]: { kind: 'link' },
  });
  const order = [];
  const run = (args) => order.push(`icacls ${args[1]}`);
  const unlink = f.unlinkSync;
  f.unlinkSync = (p) => { order.push(`unlink ${path.win32.basename(p)}`); unlink(p); };
  const out = secureProgramDataDir({ platform: 'win32', programData: BASE, fsApi: f, run });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.removed.sort(), ['enotdesk-video.log', 'svc-diag.log', 'x'].sort());
  assert.ok(f.map.has(`${DIR}\\svc-diag.enabled`));
  assert.ok(f.map.has(`${DIR}\\helper\\enotdesk-video.exe`));
  // чистка — только после смены владельца и ACL корня
  assert.ok(order.indexOf('unlink enotdesk-video.log') > order.indexOf('icacls /inheritance:r'));
});

test('programdata-acl: пустая папка — сбой icacls на «*» не ошибка', () => {
  const run = (args) => { if (args[0].endsWith('*')) throw new Error('No files match'); };
  const out = secureProgramDataDir({ platform: 'win32', programData: BASE, fsApi: fakeFs(), run });
  assert.equal(out.ok, true, out.error);
});

test('programdata-acl: сбой icacls — ok:false с шагом, без исключения', () => {
  const run = (args) => { if (args[1] === '/setowner') throw new Error('Access is denied'); };
  const out = secureProgramDataDir({ platform: 'win32', programData: BASE, fsApi: fakeFs(), run });
  assert.equal(out.ok, false);
  assert.equal(out.step, '/setowner');
  assert.match(out.error, /denied/);
});

test('programdata-acl: icacls — абсолютный путь из SystemRoot', () => {
  assert.equal(icaclsPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\icacls.exe');
  assert.equal(icaclsPath({}), 'C:\\Windows\\System32\\icacls.exe');
});

test('svc-diag: не пишет в журнал-ссылку и в папку-ссылку', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-acl-'));
  try {
    const dir = path.join(root, 'EnotDesk');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'svc-diag.enabled'), '');
    const diag = createSvcDiag({ programData: root });
    assert.equal(diag.write('t', 'обычная запись'), true);
    // жёсткая ссылка вместо журнала
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'чужое');
    fs.rmSync(diag.logFile);
    fs.linkSync(victim, diag.logFile);
    assert.equal(isPlainFile(diag.logFile), false);
    assert.equal(diag.write('t', 'через ссылку'), false);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'чужое');
    // папка-ссылка
    fs.rmSync(dir, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'svc-diag.enabled'), '');
    fs.symlinkSync(elsewhere, dir, 'junction');
    assert.equal(diag.write('t', 'через папку-ссылку'), false);
    assert.equal(fs.existsSync(path.join(elsewhere, 'svc-diag.log')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

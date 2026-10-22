// Права на %ProgramData%\EnotDesk (ревью безопасности 22.10, P2-5).
// Туда пишут от SYSTEM служба (svc-diag) и хелпер видео (журнал, ADR 0036),
// а ProgramData позволяет любому пользователю заранее создать подпапку и
// стать её владельцем. Подменив папку junction'ом или журнал ссылкой, он
// направил бы запись SYSTEM в чужой файл; заодно журнал читался всеми.
//
// Служба на старте (от SYSTEM, до первой записи):
//   1) папка-ссылка → отодвигается в сторону, создаётся настоящая;
//   2) владелец папки и содержимого — SYSTEM, явные записи ACL сбрасываются, наследование
//      выключено: SYSTEM и Администраторы — полный доступ, Пользователи —
//      только сама папка (RX, без наследования: содержимое им не видно);
//   3) ссылки внутри (symlink/junction, файлы с жёсткими ссылками) удаляются;
//   4) helper\ — Пользователи RX: копию хелпера запускает токен пользователя
//      (путь вне Program Files, session-spawn.mjs).
// Сбой — честный отчёт и `ok:false`, никогда не throw: служба обязана
// стартовать. Хелпер всё равно перепроверяет путь перед записью (win.rs
// open_journal), svc-diag — здесь же (isPlainFile).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// SID'ы, а не имена: на русской Windows «СИСТЕМА» и «Администраторы»
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINS = '*S-1-5-32-544';
const SID_USERS = '*S-1-5-32-545';

export function icaclsPath(env = process.env) {
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
}

// Аргументы icacls по шагам — отдельно, чтобы тест сверял их без Windows
export function aclPlan(dir) {
  const helper = path.win32.join(dir, 'helper');
  return [
    [dir, '/setowner', SID_SYSTEM, '/Q'],
    [dir, '/reset', '/Q'],
    [dir, '/inheritance:r', '/grant:r',
      `${SID_SYSTEM}:(OI)(CI)F`, `${SID_ADMINS}:(OI)(CI)F`, `${SID_USERS}:(RX)`, '/Q'],
    // дети наследуют новый ACL (старые файлы читались всеми) и принадлежат
    // SYSTEM: журнал, созданный хелпером от токена пользователя, оставался
    // его собственностью — владелец вернул бы себе доступ (ВМ лабы, 22.10)
    [path.win32.join(dir, '*'), '/reset', '/T', '/C', '/Q'],
    [path.win32.join(dir, '*'), '/setowner', SID_SYSTEM, '/T', '/C', '/Q'],
    [helper, '/grant', `${SID_USERS}:(OI)(CI)RX`, '/Q'],
  ];
}

const isLink = (st) => st.isSymbolicLink(); // junction на Windows — тоже symlink для lstat

// Обычный файл с одной ссылкой (или его ещё нет) — можно писать от SYSTEM
export function isPlainFile(p, fsApi = fs) {
  try {
    const st = fsApi.lstatSync(p);
    return st.isFile() && !isLink(st) && st.nlink === 1;
  } catch (e) {
    return e?.code === 'ENOENT';
  }
}

// Удаляет ссылки на уровне `dir` и одну ступень вглубь (helper\)
function dropLinks(dir, fsApi, removed, depth = 0) {
  for (const ent of fsApi.readdirSync(dir, { withFileTypes: true })) {
    const p = path.win32.join(dir, ent.name);
    let st;
    try { st = fsApi.lstatSync(p); } catch { continue; }
    if (isLink(st)) {
      // rmdir снимает сам junction, не трогая цель; unlink — symlink на файл
      try { fsApi.rmdirSync(p); } catch { fsApi.unlinkSync(p); }
      removed.push(ent.name);
    } else if (st.isFile() && st.nlink > 1) {
      fsApi.unlinkSync(p); // удаляется только наше имя, чужой файл цел
      removed.push(ent.name);
    } else if (st.isDirectory() && depth === 0) {
      dropLinks(p, fsApi, removed, depth + 1);
    }
  }
}

export function secureProgramDataDir({
  programData,
  platform = process.platform,
  fsApi = fs,
  run = (args) => execFileSync(icaclsPath(), args, { windowsHide: true, stdio: 'ignore', timeout: 30_000 }),
  now = () => Date.now(),
} = {}) {
  if (platform !== 'win32') return { ok: true, skipped: true };
  const base = programData ?? (process.env.PROGRAMDATA || 'C:\\ProgramData');
  const dir = path.win32.join(base, 'EnotDesk');
  const report = { ok: false, dir, moved: null, removed: [], step: '' };
  try {
    report.step = 'lstat';
    let st = null;
    try { st = fsApi.lstatSync(dir); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    if (st && (isLink(st) || !st.isDirectory())) {
      report.step = 'move';
      report.moved = `${dir}.untrusted-${now()}`;
      fsApi.renameSync(dir, report.moved);
      st = null;
    }
    report.step = 'mkdir';
    fsApi.mkdirSync(path.win32.join(dir, 'helper'), { recursive: true });
    const plan = aclPlan(dir);
    // владелец и ACL корня — до чистки: после них чужая запись в папку закрыта
    for (const args of plan.slice(0, 3)) { report.step = args[1]; run(args); }
    report.step = 'links';
    dropLinks(dir, fsApi, report.removed);
    for (const args of plan.slice(3)) {
      report.step = args[1];
      // пустая папка: '*' ни с чем не совпал — не ошибка
      try { run(args); } catch (e) { if (!args[0].endsWith('*')) throw e; }
    }
    report.step = 'done';
    report.ok = true;
  } catch (e) {
    report.error = String(e?.message ?? e).slice(0, 200);
  }
  return report;
}

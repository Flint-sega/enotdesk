// Резолв консольного пользователя для терминала агента (SEC-001): агент-служба
// работает от root, и без него spawnShellFor поднимал бы root-shell даже на
// машине, которую использует живой человек. Паттерн — как у notify.mjs:
// Linux — getent passwd, первый обычный пользователь (uid>=1000); macOS —
// uid активной консоли (/dev/console) + имя через id -un. Вызывается один раз
// при старте агента, синхронно. Не нашли — null: вызывающий честно остаётся
// в контексте 'service' (spawnShellFor), фейкового успеха не выдумываем.
// spawnSync инъекцией — юнит-тесты идут на моках.

import { spawnSync as nodeSpawnSync } from 'node:child_process';

function linuxConsole(spawnSync) {
  try {
    const r = spawnSync('getent', ['passwd'], { encoding: 'utf8', timeout: 3000 });
    for (const line of String(r?.stdout ?? '').split('\n')) {
      const fields = line.split(':');
      const uid = Number.parseInt(fields[2], 10);
      if (fields[0] && Number.isInteger(uid) && uid >= 1000) return { user: fields[0], uid };
    }
  } catch { /* getent недоступен — честный null */ }
  return null;
}

function darwinConsole(spawnSync) {
  try {
    const r = spawnSync('stat', ['-f', '%u', '/dev/console'], { encoding: 'utf8', timeout: 3000 });
    const uid = Number.parseInt(String(r?.stdout ?? '').trim(), 10);
    if (!Number.isInteger(uid) || uid <= 0) return null; // консоли нет (экран входа) — контекст service
    let user = '';
    try {
      const n = spawnSync('id', ['-un', String(uid)], { encoding: 'utf8', timeout: 3000 });
      user = String(n?.stdout ?? '').trim();
    } catch { /* имя не критично: launchctl требует uid, а не имя */ }
    return { user: user || String(uid), uid };
  } catch { /* stat недоступен — честный null */ }
  return null;
}

export function resolveConsoleUser({ platform = process.platform, spawnSync = nodeSpawnSync } = {}) {
  try {
    if (platform === 'linux') return linuxConsole(spawnSync);
    if (platform === 'darwin') return darwinConsole(spawnSync);
  } catch { /* сбой резолва не роняет старт агента */ }
  return null;
}

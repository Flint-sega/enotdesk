import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyDesktopEntry, buildDesktopEntry, DESKTOP_ID, DESKTOP_MIME } from '../lib/desktop-entry.mjs';

function fakeIo(existing = new Map()) {
  const files = new Map(existing);
  const calls = { mkdir: [], copy: [], writes: [] };
  const io = {
    exists: (p) => files.has(p),
    mkdir: (p) => calls.mkdir.push(p),
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return v; },
    writeFile: (p, data) => { calls.writes.push(p); files.set(p, data); },
    copyFile: (src, dst) => { calls.copy.push([src, dst]); files.set(dst, 'PNG'); },
    _files: files,
    _calls: calls,
  };
  return io;
}

test('buildDesktopEntry: обязательные поля и кавычки вокруг пути с пробелом', () => {
  const e = buildDesktopEntry({ execPath: '/opt/EnotDesk/enotdesk', iconPath: '/home/u/.local/share/icons/enotdesk.png', comment: 'Помощь' });
  assert.match(e, /^\[Desktop Entry\]\n/);
  assert.match(e, /^Type=Application$/m);
  assert.match(e, /^Exec=\/opt\/EnotDesk\/enotdesk$/m);
  assert.match(e, /^Icon=\/home\/u\/\.local\/share\/icons\/enotdesk\.png$/m);
  assert.match(e, /^StartupWMClass=EnotDesk$/m);
  assert.match(e, new RegExp(`^MimeType=${DESKTOP_MIME}$`, 'm'));
  const spaced = buildDesktopEntry({ execPath: '/opt/My App/enotdesk' });
  assert.match(spaced, /^Exec="\/opt\/My App\/enotdesk"$/m);
  // Экранирование freedesktop Exec (ревью 10.10): % удваивается, " и \
  // экранируются, кавычки нужны и когда пробела нет, но есть кавычка.
  assert.match(buildDesktopEntry({ execPath: '/opt/50%apps/EnotDesk' }), /^Exec=\/opt\/50%%apps\/EnotDesk$/m);
  assert.match(buildDesktopEntry({ execPath: '/opt/a"b/app' }), /^Exec=\/opt\/a\\"b\/app$/m);
  assert.match(buildDesktopEntry({ execPath: String.raw`/opt\a/app` }), /^Exec=\/opt\\\\a\/app$/m);
  assert.match(buildDesktopEntry({ execPath: '/opt/1% and "x"/app' }), /^Exec="\/opt\/1%% and \\"x\\"\/app"$/m);
});

test('applyDesktopEntry: создаёт запись и копирует иконку, повторный вызов — no-op', () => {
  const io = fakeIo();
  const home = '/home/u';
  const iconSource = '/app/assets/icon.png';
  io._files.set(iconSource, 'PNG');
  const run = [];
  const r1 = applyDesktopEntry({ home, execPath: '/opt/EnotDesk/enotdesk', iconSource, runXdgMime: (...a) => run.push(a) }, io);
  assert.equal(r1.changed, true);
  // пути — только через path.join: на Windows разделитель другой
  assert.equal(r1.entryFile, path.join(home, '.local', 'share', 'applications', DESKTOP_ID));
  assert.equal(r1.iconPath, path.join(home, '.local', 'share', 'icons', 'enotdesk.png'));
  assert.deepEqual(io._calls.copy, [[iconSource, r1.iconPath]]);
  assert.deepEqual(run, [['default', DESKTOP_ID, DESKTOP_MIME]]);

  const r2 = applyDesktopEntry({ home, execPath: '/opt/EnotDesk/enotdesk', iconSource, runXdgMime: () => { throw new Error('не должен зваться'); } }, io);
  assert.equal(r2.changed, false);
});

test('applyDesktopEntry: смена пути Exec перезаписывает запись; нет иконки — fallback на имя', () => {
  const io = fakeIo();
  const home = '/home/u';
  applyDesktopEntry({ home, execPath: '/opt/EnotDesk/enotdesk' }, io);
  const r = applyDesktopEntry({ home, execPath: '/opt/new/enotdesk' }, io);
  assert.equal(r.changed, true);
  assert.equal(r.iconPath, null);
  assert.match(io._files.get(r.entryFile), /^Icon=EnotDesk$/m);
  assert.match(io._files.get(r.entryFile), /^Exec=\/opt\/new\/enotdesk$/m);
});

test('applyDesktopEntry: недоступная иконка не мешает записи', () => {
  const io = fakeIo();
  const r = applyDesktopEntry({ home: '/home/u', execPath: '/opt/EnotDesk/enotdesk', iconSource: '/missing/icon.png' }, io);
  assert.equal(r.changed, true);
  assert.equal(r.iconPath, null);
});

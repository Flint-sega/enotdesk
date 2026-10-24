import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gdmVideoStatus } from '../lib/gdm-status.mjs';

test('gdmVideoStatus: реальный статус захвата моста вместо «платформа не поддерживается»', () => {
  assert.deepEqual(gdmVideoStatus({ state: 'running' }), { state: 'running' });
  assert.deepEqual(gdmVideoStatus({ state: 'unavailable', reason: 'NotAllowedError' }), { state: 'error', reason: 'video-capture-unavailable' });
  assert.equal(gdmVideoStatus(null), null, 'мост ещё не отчитался — статус не шлём');
  assert.equal(gdmVideoStatus({ state: 'stopped' }), null);
});

test('main: на Linux video.start() не отвечает video-unsupported-platform, пока мост даёт видео', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'main.mjs'), 'utf8');
  const start = main.indexOf('if (!videoHost && gdmVideo)');
  const unsupported = main.indexOf("reason: 'video-unsupported-platform'");
  assert.ok(start > 0 && unsupported > start, 'ветка моста (gdm) проверяется раньше честного unsupported');
  assert.match(main, /videoForward\?\.setGdm\?\.\(\{ state: payload\?\.state/, 'статус моста доходит до агента');
});

test('main: скрытое окно моста не тормозится как фоновое (кадры Linux-захвата, 25.10)', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'main.mjs'), 'utf8');
  const at = main.indexOf("preload: path.join(import.meta.dirname, 'agent-bridge', 'preload.cjs')");
  assert.ok(at > 0, 'окно моста найдено');
  const prefs = main.slice(at, main.indexOf('});', at));
  assert.match(prefs, /backgroundThrottling: false/);
  assert.match(prefs, /sandbox: true/, 'песочница моста на месте');
});

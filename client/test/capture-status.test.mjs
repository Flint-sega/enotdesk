// A-2w (стенд 22.10, GNOME Wayland): клиент помощи не обещает «оператор видит ваш
// экран», пока захват не пошёл; на Wayland подсказывает выбрать экран в окне GNOME и
// честно сообщает оператору статус (machine-video); /operator показывает понятный текст.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ru from '../locales/ru.mjs';
import en from '../locales/en.mjs';

const dir = path.join(import.meta.dirname, '..');
const read = (...p) => readFileSync(path.join(dir, ...p), 'utf8');
const media = read('renderer', 'session-media.js');
const app = read('renderer', 'app.js');
const html = read('renderer', 'index.html');
const main = read('main.mjs');
const preload = read('preload.cjs');
const operator = readFileSync(path.join(dir, '..', 'web', 'operator.mjs'), 'utf8');

test('клиент помощи: «оператор видит ваш экран» — только после старта захвата', () => {
  assert.match(html, /<p id="connected-intro" class="hidden" data-i18n-html="client\.connectedIntroHtml">/);
  assert.match(app, /hide\(\$\('connected-intro'\)\);\s*try \{ await startHostRtc\(\);/, 'после согласия подпись спрятана');
  assert.match(media, /state\.localStream = stream;\s*captureStartedStatus\(\);/, 'подпись — когда поток есть');
  assert.match(media.slice(media.indexOf('function captureStartedStatus')), /show\(\$\('connected-intro'\)\)/);
});

test('клиент помощи: на Wayland подсказка и статус оператору — до запроса экранов', () => {
  const acquire = media.slice(media.indexOf('async function acquirePrimaryStream'), media.indexOf('let portalPending'));
  const hint = acquire.indexOf("t('client.waylandPick')");
  const status = acquire.indexOf("enot.captureStatus('connecting', 'wayland-portal')");
  const select = acquire.indexOf('enot.selectPrimaryScreen()');
  assert.ok(hint > 0 && status > 0 && select > hint && select > status, 'системное окно GNOME открывает уже список экранов');
  assert.equal((acquire.match(/captureFailedStatus\(\)/g) ?? []).length, 3, 'каждый сбой захвата сообщается оператору');
  assert.match(media, /enot\.captureStatus\('error', 'capture-denied'\)/);
  assert.match(media, /enot\.captureStatus\('running'\)/);
});

test('клиент помощи: на Wayland окно GNOME «поделиться экраном» — один раз', () => {
  // стенд 24.10: getSources в selectPrimaryScreen и второй — в обработчике захвата
  // открывали окно GNOME дважды; источник из первого выбора переиспользуется
  const pick = main.slice(main.indexOf('async function selectPrimaryScreen'), main.indexOf('function permissionsReport'));
  assert.match(pick, /selectedSource = \{[^}]*bounds, source: src \};/);
  const pickAny = main.slice(main.indexOf('async function selectSource'), main.indexOf('async function selectPrimaryScreen'));
  assert.equal((pickAny.match(/source: src \};/g) ?? []).length, 2, 'и при смене экрана');
  const handler = main.slice(main.indexOf('session.defaultSession.setDisplayMediaRequestHandler((_opts'));
  const reuse = handler.indexOf('if (isWaylandSession() && selectedSource.source) {');
  assert.ok(reuse > 0 && reuse < handler.indexOf('desktopCapturer.getSources'), 'до повторного getSources');
  assert.match(handler, /callback\(\{ video: selectedSource\.source \}\);\s*return;/);
  assert.match(main, /function permissionsReport\(\) \{\s*const wayland = isWaylandSession\(\);/);
});

test('клиент помощи: «Сменить экран» на Wayland — одно окно GNOME и без второго списка', () => {
  const list = main.slice(main.indexOf('async function listSources'), main.indexOf('const coordScale'));
  assert.match(list, /listedSources = new Map\(isWaylandSession\(\) \? sources\.map\(\(s\) => \[s\.id, s\]\) : \[\]\);/);
  const sel = main.slice(main.indexOf('async function selectSource'), main.indexOf('async function selectPrimaryScreen'));
  assert.match(sel, /const listed = listedSources\.get\(id\);\s*const sources = listed \? \[listed\] : await desktopCapturer\.getSources/);
  assert.match(main, /selectedSource = null;[^\n]*\n\s*listedSources = new Map\(\);/, 'конец сеанса забывает список');
  assert.match(main, /ipcMain\.handle\('enot:sources', async \(e\) => \{ guard\(e\); return \{ items: await listSources\(\), systemPicked: isWaylandSession\(\) \}; \}\);/);
  const picker = media.slice(media.indexOf('async function showSourcePicker'), media.indexOf('async function acquireStream'));
  assert.match(picker, /if \(srcs\.systemPicked && srcs\.items\.length === 1\) return onChoose\(srcs\.items\[0\]\.id, document\.createElement\('div'\)\);/);
  assert.ok(picker.indexOf('srcs.systemPicked') < picker.indexOf("document.createElement('div');\n  pick.className"), 'до показа своего списка');
});

test('клиент помощи: подсказка про окно GNOME уходит, когда захват пошёл', () => {
  const started = media.slice(media.indexOf('function captureStartedStatus'), media.indexOf('let hostRtcEpoch'));
  assert.match(started, /if \(portalPending\) \{\s*portalPending = false;[\s\S]*text\(\$\('client-live-note'\), streamPaused \? t\('client\.pausedNote'\) : ''\);/);
});

test('мост: enot:captureStatus проверяет отправителя и пускает только allowlist', () => {
  assert.match(preload, /captureStatus: \(state, reason\) => ipcRenderer\.invoke\('enot:captureStatus', \{ state, reason \}\)/);
  const h = main.slice(main.indexOf("ipcMain.handle('enot:captureStatus'"), main.indexOf("ipcMain.handle('enot:sendSignal'"));
  assert.match(h, /^ipcMain\.handle\('enot:captureStatus', \(e, status\) => \{\s*guard\(e\);/);
  assert.match(h, /\['connecting', 'running', 'error'\]\.includes\(status\?\.state\)/);
  assert.match(h, /\['wayland-portal', 'capture-denied'\]\.includes\(status\?\.reason\)/);
  assert.match(h, /signal\.sendMachineVideo\(/);
});

test('/operator: понятные тексты для Wayland и сбоя захвата; ключи в ru и en', () => {
  assert.match(operator, /msg\.reason === 'wayland-portal'\) setVideoStatus\(t\('web\.video\.waylandPortal'\)\)/);
  assert.match(operator, /msg\.reason === 'capture-denied'\) setVideoStatus\(t\('web\.video\.captureDenied'\)\)/);
  for (const k of ['client.waylandPick', 'web.video.waylandPortal', 'web.video.captureDenied']) {
    assert.ok(ru[k] && en[k], `нет ключа ${k}`);
  }
  assert.match(ru['client.waylandPick'], /GNOME/);
});

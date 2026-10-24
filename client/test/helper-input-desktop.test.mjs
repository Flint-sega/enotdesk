// W-4 (автопрогон 24.10, Win11-ВМ): через службу курсор двигался, а клавиши и кнопки мыши —
// нет: SendInput на потоке, прицепленном к рабочему столу ввода, получал ERROR_ACCESS_DENIED.
// Синтетическому вводу нужно право DESKTOP_JOURNALPLAYBACK на рабочем столе потока.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', '..');
const win = readFileSync(path.join(root, 'helper/video/src/win.rs'), 'utf8');

test('хелпер: attach к рабочему столу ввода — с правом на синтетический ввод', () => {
  const fn = win.slice(win.indexOf('pub fn attach_input_desktop()'), win.indexOf('pub fn virtual_desktop_metrics_pub()'));
  const open = fn.slice(fn.indexOf('OpenInputDesktop('), fn.indexOf('SetThreadDesktop('));
  for (const right of ['DESKTOP_READOBJECTS', 'DESKTOP_WRITEOBJECTS', 'DESKTOP_SWITCHDESKTOP', 'DESKTOP_JOURNALPLAYBACK']) {
    assert.match(open, new RegExp(`${right}\\.0`), `маска OpenInputDesktop без ${right}`);
  }
  assert.match(win, /use windows::Win32::System::StationsAndDesktops::\{[^}]*DESKTOP_JOURNALPLAYBACK/);
});

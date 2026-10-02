import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeepAwake } from '../lib/keep-awake.mjs';

function fakeKoffi() {
  const calls = [];
  const lib = {
    func() {
      return (flags) => {
        calls.push(flags >>> 0);
        return flags;
      };
    },
  };
  const koffi = { load: () => lib };
  return { koffi, calls };
}

test('keep-awake: acquire шлёт CONTINUOUS|SYSTEM|DISPLAY, release — только CONTINUOUS', () => {
  const { koffi, calls } = fakeKoffi();
  const ka = createKeepAwake({ koffi, platform: 'win32' });
  assert.equal(ka.isOn(), false);
  ka.acquire();
  assert.equal(ka.isOn(), true);
  ka.acquire(); // повторный acquire не дублирует вызов
  assert.equal(calls.length, 1);
  assert.equal(calls[0], (0x80000000 | 0x1 | 0x2) >>> 0);
  ka.release();
  assert.equal(ka.isOn(), false);
  assert.equal(calls[1], 0x80000000 >>> 0);
  ka.release(); // повторный release — тоже
  assert.equal(calls.length, 2);
});

test('keep-awake: не-win32 и отсутствие koffi — честный no-op без throw', () => {
  const mac = createKeepAwake({ koffi: null, platform: 'darwin' });
  mac.acquire();
  assert.equal(mac.isOn(), true); // флаг живёт, вызовов наружу не было
  mac.release();
  assert.equal(mac.isOn(), false);
  const noKoffi = createKeepAwake({ koffi: null, platform: 'win32' });
  noKoffi.acquire();
  noKoffi.release();
});

test('keep-awake: падение koffi.load — no-op, не роняет вызывающего', () => {
  const ka = createKeepAwake({
    koffi: { load: () => { throw new Error('no kernel32'); } },
    platform: 'win32',
  });
  ka.acquire();
  assert.equal(ka.isOn(), true);
  ka.release();
  assert.equal(ka.isOn(), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeepAwake } from '../lib/keep-awake.mjs';

function fakeKoffi() {
  const calls = [];
  const lib = {
    func(signature) {
      // SendMessageTimeoutW: возвращаем «есть такая-то функция», данные копим
      if (signature.includes('SendMessageTimeoutW')) {
        return () => { calls.push('wake'); return 1; };
      }
      return (flags) => {
        calls.push(`es:${(flags >>> 0).toString(16)}`);
        return flags;
      };
    },
  };
  return { koffi: { load: () => lib }, calls };
}

test('keep-awake: acquire будит дисплей (SC_MONITORPOWER -1) и держит ES-флаги', () => {
  const { koffi, calls } = fakeKoffi();
  const ka = createKeepAwake({ koffi, platform: 'win32' });
  ka.acquire();
  assert.equal(calls.filter(c => c === 'wake').length, 1); // будящий тычок первым
  assert.equal(calls.filter(c => c.startsWith('es:')).length, 1);
  assert.equal(calls.find(c => c.startsWith('es:')), 'es:80000003');
  ka.acquire(); // повторный acquire не дублирует ни wake, ни ES
  assert.equal(calls.length, 2);
  ka.release();
  ka.release();
  assert.equal(calls.length, 3); // только финальный es:80000000
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


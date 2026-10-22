import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// ADR 0037: подпись mac-сборки собственным сертификатом проекта — afterPack-хук
// electron-builder; без переменных ENOT_MAC_SIGN_* сборка, как раньше, без подписи.

const root = path.join(import.meta.dirname, '..', '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const hook = createRequire(import.meta.url)(path.join(root, 'build', 'mac-self-sign.cjs')).default;

test('хук подписи: не mac и без сертификата — ничего не делает', async () => {
  const saved = { k: process.env.ENOT_MAC_SIGN_KEYCHAIN, i: process.env.ENOT_MAC_SIGN_IDENTITY };
  delete process.env.ENOT_MAC_SIGN_KEYCHAIN; delete process.env.ENOT_MAC_SIGN_IDENTITY;
  try {
    await hook({ electronPlatformName: 'win32' });
    await hook({ electronPlatformName: 'linux' });
    await hook({ electronPlatformName: 'darwin', appOutDir: '/нет', packager: { appInfo: { productFilename: 'EnotDesk' } } });
  } finally {
    if (saved.k !== undefined) process.env.ENOT_MAC_SIGN_KEYCHAIN = saved.k;
    if (saved.i !== undefined) process.env.ENOT_MAC_SIGN_IDENTITY = saved.i;
  }
});

test('electron-builder: afterPack — хук подписи; своя подпись EB выключена; entitlements рядом', () => {
  const yml = read('build/electron-builder.yml');
  assert.match(yml, /^afterPack: build\/mac-self-sign\.cjs$/m);
  assert.match(yml, /^ {2}identity: null$/m);
  const ent = read('build/entitlements.mac.plist');
  assert.match(ent, /com\.apple\.security\.cs\.disable-library-validation/, 'koffi.node без Team ID грузится');
});

test('release.yml: импорт сертификата только при секретах, гейт проверяет подпись в zip', () => {
  const yml = read('.github/workflows/release.yml');
  assert.match(yml, /MAC_SELF_SIGN_P12: \$\{\{ secrets\.MAC_SELF_SIGN_P12 \}\}/);
  assert.match(yml, /сертификата нет — mac-сборка без подписи"; exit 0/);
  assert.match(yml, /codesign --verify --deep --strict "\$RUNNER_TEMP\/zipcheck\/EnotDesk\.app"/);
  assert.doesNotMatch(yml, /# - name: Import macOS signing certificate/, 'старый нерабочий блок удалён');
});

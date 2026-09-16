import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersionFromFilename, isNewerVersion, latestVersionFrom } from '../lib/version-check.mjs';

test('версия из имени файла: сборки всех платформ и мусор', () => {
  assert.equal(parseVersionFromFilename('EnotDesk-0.2.1-win-x64.zip'), '0.2.1');
  assert.equal(parseVersionFromFilename('EnotDesk-1.10.3-arm64.exe'), '1.10.3');
  assert.equal(parseVersionFromFilename('EnotDesk-0.1.0.AppImage'), '0.1.0');
  assert.equal(parseVersionFromFilename('readme.txt'), null);
  assert.equal(parseVersionFromFilename(''), null);
  assert.equal(parseVersionFromFilename(null), null);
});

test('сравнение версий: строго новее — да, равные и старше — нет, ведущие нули не важны', () => {
  assert.equal(isNewerVersion('0.1.0', '0.2.1'), true);
  assert.equal(isNewerVersion('0.2.1', '0.1.0'), false);
  assert.equal(isNewerVersion('0.2.1', '0.2.1'), false, 'равные не считаются новее');
  assert.equal(isNewerVersion('1.9.9', '1.10.0'), true, 'числовое, не лексикографическое');
  assert.equal(isNewerVersion('0.1.0', '0.1'), false, 'неполная версия не парсится — новее не считаем');
  assert.equal(isNewerVersion('мусор', '0.2.0'), false);
  assert.equal(isNewerVersion('0.1.0', null), false);
});

test('свежая версия из списка имён файлов', () => {
  assert.equal(latestVersionFrom([
    'EnotDesk-0.1.0-win-x64.zip',
    'EnotDesk-0.3.0-mac-arm64.zip',
    'EnotDesk-0.2.5.AppImage',
    'EnotDesk-0.3.0-mac-arm64.zip', // дубликат не мешает
  ]), '0.3.0');
  assert.equal(latestVersionFrom(['мусор.zip']), null);
  assert.equal(latestVersionFrom([]), null);
  assert.equal(latestVersionFrom(undefined), null);
});

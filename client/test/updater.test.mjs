import test from 'node:test';
import assert from 'node:assert/strict';
import { updateFeedUrl, platformFeedName, updateDecision, updateInstallDecision } from '../lib/updater.mjs';

// Фид — то, что release.yml прикладывает к релизу рядом с артефактами:
// минимальный формат latest*.yml от electron-builder. Ожидания разобраны вручную
// из формата документации electron-updater, а не из кода под тестом.

const FEED = [
  'version: 1.2.3',
  'path: EnotDesk-1.2.3-mac-arm64.zip',
  'sha512: AbCd==',
  'releaseDate: \'2026-09-17T10:00:00.000Z\'',
  'files:',
  '  - url: EnotDesk-1.2.3-mac-arm64.zip',
  '    sha512: AbCd==',
  '    size: 117565534',
].join('\n');

test('адрес фида — GitHub Releases latest/download репозитория проекта', () => {
  assert.equal(updateFeedUrl(), 'https://github.com/Flint-sega/enotdesk/releases/latest/download/');
  assert.equal(updateFeedUrl({ owner: 'o', repo: 'r' }), 'https://github.com/o/r/releases/latest/download/');
  assert.equal(updateFeedUrl({ owner: '', repo: 'r' }), null);
  assert.equal(updateFeedUrl(null), null);
});

test('имя файла фида по платформе: mac/linux/win, остальное — null', () => {
  assert.equal(platformFeedName('darwin'), 'latest-mac.yml');
  assert.equal(platformFeedName('linux'), 'latest-linux.yml');
  assert.equal(platformFeedName('win32'), 'latest.yml');
  assert.equal(platformFeedName('freebsd'), null);
});

test('парсер фида: версия и список файлов; мусор и пусто — честный null', () => {
  const d = updateDecision({ current: '1.2.2', feedText: FEED });
  assert.equal(d.version, '1.2.3');
  assert.equal(d.update, true);
  assert.deepEqual(d.files, ['EnotDesk-1.2.3-mac-arm64.zip']);

  const same = updateDecision({ current: '1.2.3', feedText: FEED });
  assert.equal(same.update, false, 'та же версия — обновления нет');
  const older = updateDecision({ current: '2.0.0', feedText: FEED });
  assert.equal(older.update, false, 'фид старше текущей — обновления нет');
  assert.equal(older.version, '1.2.3', 'версию из фида всё равно сообщаем');
});

test('парсер фида: невалидный ввод не решает ничего — update:false, версия null', () => {
  for (const feedText of ['', null, undefined, 'не yaml вообще', 'version: не версия']) {
    const d = updateDecision({ current: '0.1.0', feedText });
    assert.deepEqual(d, { update: false, version: null, files: [] }, `feedText=${String(feedText)}`);
  }
  assert.equal(updateDecision({ current: null, feedText: FEED }).update, false, 'нет текущей версии — решения нет');
});

test('фид с несколькими платформенными файлами сохраняет их порядок', () => {
  const multi = FEED.replace('  - url: EnotDesk-1.2.3-mac-arm64.zip\n', '  - url: EnotDesk-1.2.3-mac-arm64.zip\n  - url: EnotDesk-1.2.3-win-x64.exe\n');
  const d = updateDecision({ current: '1.0.0', feedText: multi });
  assert.deepEqual(d.files, ['EnotDesk-1.2.3-mac-arm64.zip', 'EnotDesk-1.2.3-win-x64.exe']);
});

// SEC-010: автоустановка — только после явного подтверждения; Windows portable —
// всегда только уведомление; дефолт (без подтверждения) — только уведомление.

test('SEC-010: mac/linux без подтверждения — скачать можно, ставить при выходе нельзя', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(
      updateInstallDecision({ platform }),
      { autoDownload: true, autoInstallOnAppQuit: false, askConfirm: true },
      platform,
    );
  }
});

test('SEC-010: mac/linux после явного подтверждения — автоустановка при выходе включена', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(
      updateInstallDecision({ platform, confirmed: true }),
      { autoDownload: true, autoInstallOnAppQuit: true, askConfirm: false },
      platform,
    );
  }
});

test('SEC-010: win32 portable — никогда не качает и не ставит, только уведомление', () => {
  assert.deepEqual(
    updateInstallDecision({ platform: 'win32', confirmed: true }),
    { autoDownload: false, autoInstallOnAppQuit: false, askConfirm: false },
  );
  assert.deepEqual(
    updateInstallDecision({ platform: 'win32' }),
    { autoDownload: false, autoInstallOnAppQuit: false, askConfirm: false },
  );
});

test('SEC-010: подтверждение принимается только явным true', () => {
  assert.equal(updateInstallDecision({ platform: 'darwin', confirmed: 'yes' }).autoInstallOnAppQuit, false);
  assert.equal(updateInstallDecision({ platform: 'darwin', confirmed: 1 }).autoInstallOnAppQuit, false);
  assert.equal(updateInstallDecision({ platform: 'darwin', confirmed: null }).askConfirm, true);
});

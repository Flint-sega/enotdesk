// afterPack-хук electron-builder (ADR 0037): подпись mac-сборки собственным
// сертификатом проекта — без покупки Apple Developer. Предупреждение
// Gatekeeper при первом запуске остаётся, зато «личность» программы
// (designated requirement = identifier + корень сертификата) одинакова у всех
// версий: разрешения «Запись экрана» и «Универсальный доступ» не слетают после
// обновления. Подписываем ДО упаковки в zip/dmg, поэтому electron-builder
// собирает их уже из подписанного .app (его собственная подпись выключена:
// identity: null — недоверенный сертификат он не находит).
// Включается только переменными окружения (их ставит release.yml, когда в
// секретах есть сертификат); без них хук ничего не делает.
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function macSelfSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const keychain = process.env.ENOT_MAC_SIGN_KEYCHAIN;
  const identity = process.env.ENOT_MAC_SIGN_IDENTITY;
  if (!keychain || !identity) {
    console.log('  • mac-self-sign: сертификат не задан — сборка без подписи');
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(__dirname, 'entitlements.mac.plist');
  execFileSync('codesign', [
    '--force', '--deep', '--options', 'runtime', '--timestamp=none',
    '--entitlements', entitlements, '--keychain', keychain, '--sign', identity, app,
  ], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const req = execFileSync('codesign', ['-dr', '-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!/certificate root = H"[0-9a-f]{40}"/.test(req)) throw new Error(`mac-self-sign: неожиданное требование подписи: ${req}`);
  console.log(`  • mac-self-sign: подписано (${identity})`);
};

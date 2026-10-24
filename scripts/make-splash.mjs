// Заставка портативной Windows-сборки (build/portable-splash.bmp): её показывает
// самораспаковщик, пока приложение распаковывается во временную папку (portable.splashImage
// в build/electron-builder.yml) — пользователь сразу видит, что программа запускается.
// NSIS BgImage понимает только BMP, поэтому кадр рисуется через Electron и пишется
// 24-битным BMP без зависимостей. Запуск: npx electron@44.9.3 scripts/make-splash.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const url = (p) => pathToFileURL(path.join(root, p)).href;
const W = 480;
const H = 270;
const OUT = 'build/portable-splash.bmp';

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Inter;font-weight:100 900;src:url('${url('site/assets/fonts/inter-latin.woff2')}') format('woff2')}
@font-face{font-family:Inter;font-weight:100 900;src:url('${url('site/assets/fonts/inter-cyrillic.woff2')}') format('woff2')}
*{margin:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#020D0B;font-family:Inter,sans-serif;color:#EAF6F1}
.art{position:absolute;inset:0 0 0 auto;width:300px;background:url('${url('site/assets/hero-neon-square.webp')}') center/cover}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,#020D0B 0%,#020D0B 38%,rgba(2,13,11,.6) 60%,rgba(2,13,11,.1) 100%)}
.text{position:absolute;left:30px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:12px}
h1{font-size:40px;font-weight:800;letter-spacing:-.03em;line-height:1}
h1 span{background:linear-gradient(96deg,#09EFB8 10%,#2ADBFF 92%);-webkit-background-clip:text;color:transparent}
p{font-size:15px;color:#A6C0B7;line-height:1.4}
.bar{width:150px;height:4px;border-radius:2px;background:linear-gradient(90deg,#1AEEB2,#2ADBFF);box-shadow:0 0 12px rgba(26,238,178,.6)}
</style>
<div class="art"></div><div class="shade"></div>
<div class="text"><h1>Enot<span>Desk</span></h1><div class="bar"></div><p>Запускается…<br>Starting…</p></div>`;

// BGRA (toBitmap) → BMP 24 бит, строки снизу вверх с выравниванием до 4 байт
function toBmp(bgra, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      buf[dst + x * 3] = bgra[s];
      buf[dst + x * 3 + 1] = bgra[s + 1];
      buf[dst + x * 3 + 2] = bgra[s + 2];
    }
  }
  return buf;
}

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-splash-'));
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  try {
    const file = path.join(tmp, 'splash.html');
    fs.writeFileSync(file, html);
    await win.loadFile(file);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
    let img = await win.webContents.capturePage({ x: 0, y: 0, width: W, height: H });
    if (img.getSize().width !== W) img = img.resize({ width: W, height: H, quality: 'best' });
    fs.writeFileSync(path.join(root, OUT), toBmp(img.toBitmap(), W, H));
    console.log(`${OUT}: ${W}×${H}`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    win.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  }
});

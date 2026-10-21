// Собирает картинки для соцсетей из арта героя и токенов Neon Emerald (Electron, без зависимостей):
//   site/assets/social-preview.png — 1280×640, превью репозитория на GitHub (английский текст);
//   site/assets/og-neon.png        — 1200×630, og:image витрины (русский текст, сайт lang="ru").
// Запуск: npx electron@44.9.0 scripts/make-social.mjs
// Версия берётся из package.json — перед запуском убедиться, что она совпадает с последним тегом.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const url = (p) => pathToFileURL(path.join(root, p)).href;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const CARDS = [
  {
    out: 'site/assets/social-preview.png', width: 1280, height: 640,
    chip: 'Open source · Self-hosted · AGPL-3.0',
    tagline: 'Remote support without installing',
    sub: 'One-time ID and password · browser operator · unattended agent',
    release: `v${version} “Crumb”`,
  },
  {
    out: 'site/assets/og-neon.png', width: 1200, height: 630,
    chip: 'Open source · Self-hosted · AGPL-3.0',
    tagline: 'Удалённая помощь без установки',
    sub: 'Одноразовый ID и пароль · оператор в браузере · постоянный доступ',
    release: `v${version} «Кроха»`,
  },
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(c) {
  const fonts = ['inter-latin', 'inter-cyrillic'].map((f) =>
    `@font-face{font-family:Inter;font-weight:100 900;src:url('${url(`site/assets/fonts/${f}.woff2`)}') format('woff2')}`).join('');
  // Арт прижат вправо и занимает ~70% ширины; слева — затемнение под текст.
  return `<!doctype html><meta charset="utf-8"><style>${fonts}
*{box-sizing:border-box;margin:0}
html,body{width:${c.width}px;height:${c.height}px;overflow:hidden;background:#020D0B}
body{position:relative;font-family:Inter,sans-serif;color:#EAF6F1}
.art{position:absolute;inset:0 0 0 auto;width:${Math.round(c.width * 0.72)}px;background:url('${url('site/assets/hero-neon.webp')}') right center/cover no-repeat}
.shade{position:absolute;inset:0;background:linear-gradient(90deg,#020D0B 0%,#020D0B 30%,rgba(2,13,11,.86) 44%,rgba(2,13,11,.25) 62%,rgba(2,13,11,0) 76%),
  linear-gradient(0deg,rgba(2,13,11,.7) 0%,rgba(2,13,11,0) 26%)}
.text{position:absolute;left:${Math.round(c.width * 0.07)}px;top:0;bottom:0;width:${Math.round(c.width * 0.5)}px;display:flex;flex-direction:column;justify-content:center;gap:22px}
.chip{align-self:flex-start;display:flex;align-items:center;gap:10px;padding:9px 18px;border:1px solid rgba(46,242,181,.32);border-radius:999px;background:rgba(4,17,13,.75);
  font-size:15px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#C6DAD3}
.chip::before{content:'';width:9px;height:9px;border-radius:50%;background:#1AEEB2;box-shadow:0 0 10px #1AEEB2}
h1{font-size:${Math.round(c.height * 0.165)}px;line-height:1;font-weight:800;letter-spacing:-.03em}
h1 span{background:linear-gradient(96deg,#09EFB8 10%,#2ADBFF 92%);-webkit-background-clip:text;color:transparent}
.tag{font-size:${Math.round(c.height * 0.05)}px;line-height:1.25;font-weight:600;color:#EAF6F1;max-width:16em;text-wrap:balance}
.sub{font-size:${Math.round(c.height * 0.03)}px;line-height:1.45;color:#A6C0B7;max-width:26em;text-wrap:balance}
.foot{position:absolute;left:${Math.round(c.width * 0.07)}px;bottom:${Math.round(c.height * 0.075)}px;display:flex;gap:10px;font-size:15px;font-weight:600;color:#A6C0B7}
.foot b{padding:6px 12px;border-radius:8px;background:rgba(10,29,22,.85);border:1px solid rgba(46,242,181,.13);font-weight:600}
.foot b.ver{color:#4CF6C6;border-color:rgba(26,238,178,.42)}
</style>
<div class="art"></div><div class="shade"></div>
<div class="text">
  <div class="chip">${esc(c.chip)}</div>
  <h1>Enot<span>Desk</span></h1>
  <p class="tag">${esc(c.tagline)}</p>
  <p class="sub">${esc(c.sub)}</p>
</div>
<div class="foot"><b class="ver">${esc(c.release)}</b><b>Windows</b><b>macOS</b><b>Linux</b></div>`;
}

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-social-'));
  // Одно окно на все карточки: второе offscreen-окно в Electron 44 падает с ERR_FAILED на loadFile.
  const win = new BrowserWindow({ width: 1280, height: 640, show: false, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  try {
    for (const c of CARDS) {
      const html = path.join(tmp, `${path.basename(c.out, '.png')}.html`);
      fs.writeFileSync(html, page(c));
      win.setContentSize(c.width, c.height);
      await win.loadFile(html);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
      let img = await win.webContents.capturePage({ x: 0, y: 0, width: c.width, height: c.height });
      if (img.getSize().width !== c.width) img = img.resize({ width: c.width, height: c.height, quality: 'best' });
      fs.writeFileSync(path.join(root, c.out), img.toPNG());
      console.log(`${c.out}: ${img.getSize().width}×${img.getSize().height}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    win.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  }
});

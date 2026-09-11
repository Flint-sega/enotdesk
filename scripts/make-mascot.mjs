// Вырезает маскот-ассеты из эталонов редизайна (Electron nativeImage, без зависимостей).
// Запуск: npx electron@44.3.0 scripts/make-mascot.mjs
//
// Координаты кропов подобраны вручную по эталонам; при смене эталонов — перепроверить глазами.
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const refDir = path.join(root, '.autopilot', 'enotdesk-redesign', 'reference');

const CROPS = [
  // Маскот с ноутбуком из hero приложения: весь правый блок со свечением.
  { src: 'app.png', out: 'assets/mascot-app.png', rect: { x: 835, y: 140, width: 690, height: 780 } },
  // Маскот с ноутбуком из hero сайта (низ — граница hero-панели эталона, ~y=440).
  { src: 'site.png', out: 'assets/mascot-site.png', rect: { x: 800, y: 68, width: 736, height: 372 } },
  // Квадрат головы/плеч для иконки (из app.png — голова крупнее);
  // низ до ноутбука (~y=640), справа не задевает рукописный текст (~x=1330).
  { src: 'app.png', out: 'assets/icon-source.png', rect: { x: 982, y: 300, width: 340, height: 340 } },
];

app.whenReady().then(() => {
  let failed = false;
  for (const { src, out, rect } of CROPS) {
    const srcPath = path.join(refDir, src);
    const img = nativeImage.createFromPath(srcPath);
    const size = img.getSize();
    if (size.width === 0) { console.error(`НЕ ЧИТАЕТСЯ: ${srcPath}`); failed = true; continue; }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > size.width || rect.y + rect.height > size.height) {
      console.error(`${out}: кроп ${JSON.stringify(rect)} выходит за ${size.width}×${size.height}`);
      failed = true;
      continue;
    }
    const outPath = path.join(root, out);
    fs.writeFileSync(outPath, img.crop(rect).toPNG());
    console.log(`${out}: ${src} ${size.width}×${size.height} → ${rect.width}×${rect.height} @ (${rect.x},${rect.y})`);
  }
  app.exit(failed ? 1 : 0);
});

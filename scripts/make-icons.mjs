// Генерация иконок упаковки из assets/icon.png (1024×1024):
//   assets/icon.icns — macOS (iconutil, только на этой ОС);
//   assets/icon.ico   — Windows (PNG-в-ICO, 256×256, стандартный формат Vista+).
// Linux использует assets/icon.png напрямую. Запуск: npm run icons.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'assets', 'icon.png');
if (process.platform !== 'darwin') {
  console.error('npm run icons использует macOS-утилиты sips/iconutil: на Windows/Linux не работает. Запускайте на macOS.');
  process.exit(1);
}
if (!fs.existsSync(src)) { console.error('Нет assets/icon.png — сначала сгенерируйте его (см. assets/README.md)'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enotdesk-icons-'));
try {
  // --- icns (macOS) ---
  if (process.platform === 'darwin') {
    const set = path.join(tmp, 'icon.iconset');
    fs.mkdirSync(set);
    const sizes = [16, 32, 128, 256, 512];
    for (const s of sizes) {
      execFileSync('sips', ['-z', String(s), String(s), src, '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'pipe' });
      execFileSync('sips', ['-z', String(s * 2), String(s * 2), src, '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'pipe' });
    }
    const icns = path.join(root, 'assets', 'icon.icns');
    execFileSync('iconutil', ['-c', 'icns', set, '-o', icns], { stdio: 'pipe' });
    console.log(`Создан ${icns}`);
  }

  // --- ico (Windows): один PNG-элемент 256×256 (ширина/высота 0 = 256) ---
  const png256 = path.join(tmp, 'icon-256.png');
  execFileSync('sips', ['-z', '256', '256', src, '--out', png256], { stdio: 'pipe' });
  const png = fs.readFileSync(png256);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // width 256 → 0
  entry.writeUInt8(0, 1); // height 256 → 0
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset = 6 + 16
  const ico = path.join(root, 'assets', 'icon.ico');
  fs.writeFileSync(ico, Buffer.concat([header, entry, png]));
  console.log(`Создан ${ico}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

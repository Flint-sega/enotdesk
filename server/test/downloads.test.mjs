import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, api } from './util.mjs';

test('корень сайта: GET / → 302 на /downloads', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/downloads');
});

test('/downloads: лендинг с брендом и иконкой', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/downloads');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  assert.match(html, /EnotDesk/);
  assert.match(html, /\/brand\/enot-icon\.svg/);
  assert.match(html, /\/brand\/enot-mascot\.svg/);
});

test('/brand/: бренд-статика отдаётся, traversal и лишние имена — 404', async (t) => {
  const { base } = await startServer(t);
  const icon = await fetch(base + '/brand/enot-icon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.match(await icon.text(), /<svg/);

  const png = await fetch(base + '/brand/icon.png');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');

  assert.equal((await fetch(base + '/brand/../../etc/passwd', { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(base + '/brand/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await fetch(base + '/brand/README.md')).status, 404);
});

test('ENOT_DIST_DIR: артефакт из temp-каталога виден в /api/v1/downloads', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = 'EnotDesk-1.2.3.AppImage';
  fs.writeFileSync(path.join(dir, name), 'ARTIFACT');
  const prev = process.env.ENOT_DIST_DIR;
  process.env.ENOT_DIST_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.ENOT_DIST_DIR;
    else process.env.ENOT_DIST_DIR = prev;
  });

  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/downloads');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((f) => f.name), [name]);
  assert.equal(res.json.items[0].platform, 'linux');
  assert.equal(res.json.items[0].size, 'ARTIFACT'.length);
});

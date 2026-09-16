import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, api } from './util.mjs';

function tempDist(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-dist-'));
  const prev = process.env.ENOT_DIST_DIR;
  process.env.ENOT_DIST_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.ENOT_DIST_DIR;
    else process.env.ENOT_DIST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('корень сайта: GET / → 302 на /downloads', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/downloads');
});

test('/downloads: hero, чипы, шаги, карточки платформ и футер с версией', async (t) => {
  const dir = tempDist(t);
  fs.writeFileSync(path.join(dir, 'EnotDesk-3.2.1-mac-arm64.zip'), 'ARTIFACT');
  const { base } = await startServer(t, { version: '3.2.1' });
  const res = await fetch(base + '/downloads');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();

  assert.match(html, /<h1[^>]*>EnotDesk<\/h1>/);
  assert.match(html, /Удалённая поддержка/);
  assert.match(html, /href="#download"/);
  assert.match(html, /href="#how"/);
  assert.match(html, /href="\/invite"/);
  assert.match(html, /\/brand\/mascot-site\.png/);
  for (const chip of ['Безопасное соединение', 'Быстрое подключение', 'Без установки']) {
    assert.ok(html.includes(chip), `нет чипа «${chip}»`);
  }
  assert.equal((html.match(/class="step"/g) || []).length, 4);
  assert.match(html, /Скачать для вашей системы/);
  assert.match(html, /EnotDesk-3\.2\.1-mac-arm64\.zip/);
  assert.match(html, /href="\/api\/v1\/downloads-files\/EnotDesk-3\.2\.1-mac-arm64\.zip"/);
  assert.match(html, /v3\.2\.1/);
  assert.match(html, /С заботой о ваших задачах/);
  assert.match(html, /Скоро будет/);
});

test('/invite: тот же стиль, шапка и футер с версией', async (t) => {
  const { base } = await startServer(t, { version: '4.5.6' });
  const html = await (await fetch(base + '/invite')).text();
  assert.match(html, /Приглашение в команду EnotDesk/);
  assert.match(html, /class="site-head"/);
  assert.match(html, /v4\.5\.6/);
  assert.match(html, /С заботой о ваших задачах/);
});

test('/brand/: бренд-статика и маскоты отдаются, traversal и лишние имена — 404', async (t) => {
  const { base } = await startServer(t);
  const icon = await fetch(base + '/brand/enot-icon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.match(await icon.text(), /<svg/);

  for (const name of ['mascot-site.png', 'mascot-app.png']) {
    const res = await fetch(base + '/brand/' + name);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], name);
  }

  assert.equal((await fetch(base + '/brand/../../etc/passwd', { redirect: 'manual' })).status, 404);
  assert.equal((await fetch(base + '/brand/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await fetch(base + '/brand/README.md')).status, 404);
});

test('ENOT_DIST_DIR: артефакт из temp-каталога виден в /api/v1/downloads', async (t) => {
  const dir = tempDist(t);
  const name = 'EnotDesk-1.2.3.AppImage';
  fs.writeFileSync(path.join(dir, name), 'ARTIFACT');

  const { base } = await startServer(t);
  const res = await api(base, 'GET', '/downloads');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items.map((f) => f.name), [name]);
  assert.equal(res.json.items[0].platform, 'linux');
  assert.equal(res.json.items[0].size, 'ARTIFACT'.length);
});

test('downloads-files: Range → 206 точными байтами, без Range → 200 с Content-Length', async (t) => {
  const dir = tempDist(t);
  const name = 'EnotDesk-9.9.9.zip';
  const body = Buffer.from('0123456789abcdef'.repeat(100)); // 1600 байт
  fs.writeFileSync(path.join(dir, name), body);
  const { base } = await startServer(t);
  const url = `${base}/api/v1/downloads-files/${name}`;

  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(body.length));
  assert.equal(Buffer.compare(Buffer.from(await full.arrayBuffer()), body), 0);

  // HEAD — те же заголовки без тела (качалки и менеджеры загрузок)
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(body.length));
  assert.equal(await head.text(), '');
  const headPart = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=0-1023' } });
  assert.equal(headPart.status, 206);
  assert.equal(headPart.headers.get('content-length'), '1024');

  const part = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-length'), '1024');
  assert.equal(part.headers.get('content-range'), `bytes 0-1023/${body.length}`);
  assert.equal(Buffer.compare(Buffer.from(await part.arrayBuffer()), body.subarray(0, 1024)), 0);

  const tail = await fetch(url, { headers: { Range: 'bytes=-100' } });
  assert.equal(tail.status, 206);
  assert.equal(Buffer.compare(Buffer.from(await tail.arrayBuffer()), body.subarray(body.length - 100)), 0);

  // RFC 9110: невалидный/чужой Range игнорируется — полный 200 без Content-Range
  for (const invalid of ['bytes=abc', 'bytes=0-1,5-6', 'items=', 'bytes=5-1']) {
    const res = await fetch(url, { headers: { Range: invalid } });
    assert.equal(res.status, 200, invalid);
    assert.equal(res.headers.get('content-range'), null, invalid);
    assert.equal(res.headers.get('content-length'), String(body.length), invalid);
  }

  const beyond = await fetch(url, { headers: { Range: 'bytes=99999-' } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get('content-range'), `bytes */${body.length}`);

  const zeroSuffix = await fetch(url, { headers: { Range: 'bytes=-0' } });
  assert.equal(zeroSuffix.status, 416);
  assert.equal(zeroSuffix.headers.get('content-range'), `bytes */${body.length}`);
});

test('downloads-files: traversal — 400, запрещённое имя — 404 и нет в /api/v1/downloads', async (t) => {
  const dir = tempDist(t);
  fs.writeFileSync(path.join(dir, 'secrets.zip'), 'NOPE');
  const { base } = await startServer(t);
  assert.equal((await fetch(base + '/api/v1/downloads-files/..%2F..%2Fetc%2Fpasswd')).status, 400);
  assert.equal((await fetch(base + '/api/v1/downloads-files/%2e%2e%2fsecret.zip')).status, 400);
  assert.equal((await fetch(base + '/api/v1/downloads-files/secrets.zip')).status, 404);
  const res = await api(base, 'GET', '/downloads');
  assert.deepEqual(res.json.items, []);
});

test('downloads: страница отдаётся с защитными заголовками (CSP, nosniff, DENY)', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(base + '/downloads');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

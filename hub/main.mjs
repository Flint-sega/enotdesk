import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHub } from './app.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// БД хаба — СВОЯ (hub.db рядом с enotdesk.db, но не та же): в bare-metal юните
// enotdesk-hub общий EnvironmentFile с сервером, поэтому ENOT_DB означает
// каталог сервера; хаб берёт из него только каталог, имя файла всегда hub.db.
const dbPath = process.env.ENOT_HUB_DB
  || (process.env.ENOT_DB ? path.join(path.dirname(process.env.ENOT_DB), 'hub.db') : 'hub.db');

const host = process.env.ENOT_HUB_HOST || '127.0.0.1';
const port = process.env.ENOT_HUB_PORT ? parseInt(process.env.ENOT_HUB_PORT, 10) : 8090;
const enotdeskUrl = process.env.ENOTDESK_URL || 'http://127.0.0.1:8080';
const publicUrl = process.env.HUB_URL || '';

const inst = createHub({
  version: pkg.version,
  dbPath,
  host,
  port,
  enotdeskUrl,
  // публичный адрес хаба (https://домен/hub или https://домен): https включает
  // Secure у cookie enot_hub_sid; наружу хаб отдаётся через Caddy
  publicUrl,
  secretKey: process.env.ENOT_SECRET_KEY || '',
  // доверенные обратные прокси (IP/CIDR через запятую) — тот же паттерн, что у
  // сервера: пусто — X-Forwarded-For не доверяется (лимиты по адресу сокета)
  trustedProxy: process.env.ENOT_TRUSTED_PROXY || '',
});
const listenPort = await inst.start();
console.log(`EnotDesk Hub listening on ${host}:${listenPort} (EnotDesk: ${enotdeskUrl})`);

// systemd останавливает SIGTERM-ом: закрываем HTTP-сервер и БД корректно
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`EnotDesk Hub: получен ${sig}, останавливаюсь`);
    inst.close().then(() => process.exit(0), () => process.exit(1));
  });
}

import { readFileSync } from 'node:fs';
import { createServer } from './app.mjs';
import { runCli } from './bootstrap.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (process.argv[2] === 'bootstrap') {
  const dbPath = process.env.ENOT_DB || 'enotdesk.db';
  await runCli(dbPath);
  process.exit(process.exitCode || 0);
}

const dbPath = process.env.ENOT_DB || 'enotdesk.db';
const inst = createServer({
  version: pkg.version,
  dbPath,
  distDir: process.env.ENOT_DIST_DIR,
  host: process.env.ENOT_HOST || '127.0.0.1',
  port: process.env.ENOT_PORT ? parseInt(process.env.ENOT_PORT, 10) : 8080,
  publicUrl: process.env.ENOT_PUBLIC_URL || '',
  turnUrls: process.env.ENOT_TURN_URLS || '',
  turnUsername: process.env.ENOT_TURN_USERNAME || '',
  turnPassword: process.env.ENOT_TURN_PASSWORD || '',
  // секрет coturn: задан — /rtc-config раздаёт эфемерные HMAC-креды вместо статического пароля
  turnSecret: process.env.ENOT_TURN_SECRET || '',
  // доверенные обратные прокси (IP или IPv4-CIDR через запятую); пусто — X-Forwarded-For не доверяется
  trustedProxy: process.env.ENOT_TRUSTED_PROXY || '',
  graceMs: process.env.ENOT_GRACE_MS ? parseInt(process.env.ENOT_GRACE_MS, 10) : undefined,
  retentionDays: process.env.ENOT_RETENTION_DAYS ? parseInt(process.env.ENOT_RETENTION_DAYS, 10) : undefined,
  maxSessions: process.env.ENOT_MAX_SESSIONS ? parseInt(process.env.ENOT_MAX_SESSIONS, 10) : undefined,
});
const port = await inst.start();
console.log(`EnotDesk server listening on ${process.env.ENOT_HOST || '127.0.0.1'}:${port}`);

// systemd останавливает SIGTERM-ом: закрываем WS и БД корректно, без WAL-мусора
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`EnotDesk server: получен ${sig}, останавливаюсь`);
    inst.close().then(() => process.exit(0), () => process.exit(1));
  });
}

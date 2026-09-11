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
  host: process.env.ENOT_HOST || '127.0.0.1',
  port: process.env.ENOT_PORT ? parseInt(process.env.ENOT_PORT, 10) : 8080,
  publicUrl: process.env.ENOT_PUBLIC_URL || '',
  turnUrls: process.env.ENOT_TURN_URLS || '',
  turnUsername: process.env.ENOT_TURN_USERNAME || '',
  turnPassword: process.env.ENOT_TURN_PASSWORD || '',
});
const port = await inst.start();
console.log(`EnotDesk server listening on ${process.env.ENOT_HOST || '127.0.0.1'}:${port}`);

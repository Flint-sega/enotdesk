import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

if (process.argv.length !== 2) throw new Error('The pilot launcher accepts settings through ENOT_PILOT_* only');

const pilot = (name) => process.env[`ENOT_PILOT_${name}`] ?? '';
const data = path.resolve(pilot('DATA_DIR') || '.guest-pilot-data');
const port = pilot('PORT') || '17880';
const turnUrls = pilot('TURN_URLS');
const turnSecret = pilot('TURN_SECRET');

if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('ENOT_PILOT_PORT must be a TCP port from 1 to 65535');
}
if (turnUrls && turnSecret.length < 32) {
  throw new Error('ENOT_PILOT_TURN_SECRET must contain at least 32 characters when TURN is configured');
}

const settings = {
  ENOT_DB: path.join(data, 'guest-pilot.db'),
  ENOT_HOST: pilot('HOST') || '127.0.0.1',
  ENOT_PORT: port,
  ENOT_GUEST_ONLY: '1',
  ENOT_PUBLIC_URL: pilot('PUBLIC_URL'),
  ENOT_TRUSTED_PROXY: pilot('TRUSTED_PROXY'),
  ENOT_TURN_URLS: turnUrls,
  ENOT_TURN_SECRET: turnSecret,
};

// A pilot invocation must never inherit the regular installation's database,
// TURN settings, secrets, or network address.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ENOT_') && !name.startsWith('ENOT_PILOT_')) delete process.env[name];
}
Object.assign(process.env, settings);
mkdirSync(data, { recursive: true, mode: 0o700 });
await import('../server/main.mjs');

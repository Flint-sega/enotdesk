import { createServer } from '../app.mjs';
import { bootstrapAdmin } from '../bootstrap.mjs';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function tmpDb(t) {
  const file = path.join(os.tmpdir(), `enot-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  t.after(() => { try { fs.rmSync(file, { force: true }); } catch { /* удалять нечего */ } });
  return file;
}

export async function startServer(t, extra = {}) {
  const inst = createServer({
    dbPath: extra.dbPath ?? tmpDb(t),
    heartbeatMs: extra.heartbeatMs ?? 200,
    leaseMs: extra.leaseMs ?? 800,
    authTimeoutMs: extra.authTimeoutMs ?? 500,
    ...extra,
  });
  const port = await inst.start();
  t.after(() => inst.close());
  return { inst, port, base: `http://127.0.0.1:${port}` };
}

export async function api(base, method, p, { token, body } = {}) {
  const res = await fetch(base + '/api/v1' + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* не JSON (HTML-страницы) */ }
  return { status: res.status, json };
}

const ADMIN = { login: 'root-admin', password: 'Пароль-админа-123' };

export function wsConnect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`);
  ws.log = []; // все входящие сообщения — wait() сначала смотрит сюда, потом слушает поток
  ws.on('message', (raw) => {
    try { ws.log.push(JSON.parse(raw.toString())); } catch { ws.log.push(null); }
  });
  ws.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error('unexpected response ' + res.statusCode)));
  });
  ws.wait = (pred, ms = 2000) => new Promise((resolve, reject) => {
    const check = (m) => m && pred(m);
    const buffered = ws.log.find(check);
    if (buffered) return resolve(buffered);
    const timer = setTimeout(() => {
      ws.off('message', on);
      reject(new Error('timeout: не дождались сообщения'));
    }, ms);
    const on = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (pred(m)) {
        clearTimeout(timer);
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
  ws.closeCode = (ms = 2000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: сокет не закрылся')), ms);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  return ws;
}

export async function wsAuth(ws, payload) {
  await ws.opened;
  const ready = ws.wait((m) => m.type === 'ready' || m.type === 'error');
  ws.send(JSON.stringify(payload));
  return ready;
}

// Бутстрап первого админа + логин; возвращает {token, user, password}
export async function adminLogin(dbPath, base) {
  const r = bootstrapAdmin(dbPath, { login: ADMIN.login, name: 'Главный Енот', password: ADMIN.password });
  if (!r.ok) throw new Error('bootstrap failed: ' + r.reason);
  const res = await api(base, 'POST', '/auth/login', { body: { login: ADMIN.login, password: ADMIN.password } });
  if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res.json));
  return { ...res.json, password: ADMIN.password };
}

export { ADMIN };

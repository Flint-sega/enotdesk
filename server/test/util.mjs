import { createServer } from '../app.mjs';
import { bootstrapAdmin } from '../bootstrap.mjs';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Дедлайн ожидания события, которое ОБЯЗАНО прийти (wait/closeCode без явного ms).
// Это верхняя граница, а не окно: больше значение — только позже падение при
// настоящем дефекте, проверки не ослабляются. 2 с хватало на тихой машине, но под
// нагрузкой (load avg 100+, гигиена 19.10) давало ложные «не дождались сообщения».
// Отрицательные проверки («сообщения НЕ будет») обязаны передавать ms явно.
// 22.10: 6 с оставляли ~1 с запаса над грейсом 5 с — под нагрузкой (load avg
// 20–46 на машине разработки, windows-раннер релиза) ложные падения грейс-тестов.
export const WAIT_MS = Number(process.env.ENOT_TEST_WAIT_MS) || 10000;

// Временная база теста живёт в своей папке: рядом SQLite держит -wal/-shm, а сервер —
// каталог relay. После теста папка удаляется целиком, но сначала закрываются серверы
// на этой базе. Раньше удалялся только файл базы, и до закрытия сервера (хуки t.after
// идут в порядке регистрации): SQLite не делал чекпойнт и бросал -wal/-shm — к 24.10
// во временной папке их накопилось на 5,8 ГБ (страж — tmp-cleanup.test.mjs).
const serversOnDb = new Map(); // путь временной базы → серверы startServer на ней

export function tmpDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enot-test-'));
  const file = path.join(dir, 'e.db');
  serversOnDb.set(file, []);
  t.after(async () => {
    await Promise.all(serversOnDb.get(file).map((inst) => inst.close()));
    serversOnDb.delete(file);
    // базу, открытую мимо startServer, Windows удалить не даст — тест из-за уборки не падает
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* останется во временной папке */ }
  });
  return file;
}

export async function startServer(t, extra = {}) {
  const dbPath = extra.dbPath ?? tmpDb(t);
  const inst = createServer({
    heartbeatMs: extra.heartbeatMs ?? 200,
    leaseMs: extra.leaseMs ?? 800,
    // 2 с, как в host-id/session-flow/operator-page: 500 мс под нагрузкой рвали
    // сокет 4001 раньше, чем тест успевал прислать auth (сам auth-таймаут ни
    // один тест по умолчанию не проверяет)
    authTimeoutMs: extra.authTimeoutMs ?? 2000,
    ...extra,
    dbPath,
  });
  serversOnDb.get(dbPath)?.push(inst);
  const port = await inst.start();
  t.after(() => inst.close());
  return { inst, port, base: `http://127.0.0.1:${port}`, dbPath };
}

export async function api(base, method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(base + '/api/v1' + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
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
  ws.wait = (pred, ms = WAIT_MS) => new Promise((resolve, reject) => {
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
  ws.closeCode = (ms = WAIT_MS) => new Promise((resolve, reject) => {
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

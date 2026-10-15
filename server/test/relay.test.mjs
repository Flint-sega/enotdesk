import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, api, adminLogin, tmpDb, wsConnect, wsAuth } from './util.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('relay: upload по hostToken → 201, скачивание по ссылке, битый токен → 403', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);

  // загрузка сырым телом
  const payload = Buffer.from('EnotDesk relay file content — проверка', 'utf8');
  const res = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('test-file.txt'),
    },
    body: payload,
  });
  assert.equal(res.status, 201, 'upload 201');
  const up = await res.json();
  assert.equal(up.name, 'test-file.txt');
  assert.ok(up.url.startsWith('/api/v1/relay/'), 'относительная ссылка');

  // скачивание по токену
  const dl = await fetch(base + up.url);
  assert.equal(dl.status, 200);
  const text = Buffer.from(await dl.arrayBuffer()).toString('utf8');
  assert.equal(text, payload.toString('utf8'));

  // битый токен → 403
  const bad = await fetch(base + `/api/v1/relay/${up.id}?token=wrong`);
  assert.equal(bad.status, 403);

  // без токена → 403
  const noToken = await fetch(base + `/api/v1/relay/${up.id}`);
  assert.equal(noToken.status, 403);
  inst.close();
});

test('relay: кириллическое имя (encoded) сохраняется корректно', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);

  const name = encodeURIComponent('отчёт за год.txt');
  const res = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': name,
    },
    body: Buffer.from('данные'),
  });
  assert.equal(res.status, 201);
  const up = await res.json();
  assert.equal(up.name, 'отчёт за год.txt', 'имя декодировано и сохранено');
  inst.close();
});

test('relay: auth-отказы — без токена 401, лишний размер 413', async (t) => {
  // 201 МБ под проверку размера аллоцируем ДО сеанса: аллокация на загруженном
  // раннере вставала секундной паузой ПОСЛЕ auth WS, а сеанс до consent умирает
  // мгновенно при обрыве host-WS (fail-closed, ADR 0013) — гонка отдавала 401
  // вместо 413 (флейк CI 06.10). Между claim и запросом остаются миллисекунды.
  const big = Buffer.alloc(201 * 1024 * 1024, 7);
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  const noAuth = await fetch(base + '/api/v1/relay', { method: 'POST', body: Buffer.from('x') });
  assert.equal(noAuth.status, 401);

  // Проверка 413 — от админ-токена: путь авторизации оператора не зависит от
  // состояния сеанса. Хост-токен здесь флейкал на медленном CI: между claim и
  // запросом сервер успевал завершить сеанс без heartbeat'а (lease-логика) —
  // тест не обязан держать сеанс живым, чтобы проверить лимит размера.
  const tooBig = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.token}`, 'content-length': String(big.length) },
    body: big,
  });
  assert.equal(tooBig.status, 413);
  inst.close();
});

test('relay: chunked (без Content-Length) → 411 (ревью 10.10), валидный путь не задет', async (t) => {
  const dbPath = tmpDb(t);
  const { inst, base, port } = await startServer(t, { dbPath });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  const claim = await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });
  assert.equal(claim.status, 201);

  // chunked-загрузка (undici шлёт Transfer-Encoding: chunked, когда body —
  // поток без длины): глобальный потолок релея считает байты по декларации,
  // отсутствие декларации раньше обнуляло её и обходило потолок.
  // Кривую декларацию («5, 5», мусор) raw-клиент не доставит — HTTP-парсер
  // Node режет её до обработчика; гард Number.isFinite в коде — защита
  // в глубину, отдельного пути через undici нет.
  const { Readable } = await import('node:stream');
  const chunked = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': 'chunked.bin',
    },
    body: Readable.from([Buffer.from('chunk'), Buffer.from('-body')]),
    duplex: 'half',
  });
  assert.equal(chunked.status, 411, 'без Content-Length — честный отказ');

  // обычная загрузка с валидной декларацией по-прежнему работает
  const fine = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': 'ok.txt',
    },
    body: Buffer.from('нормально'),
  });
  assert.equal(fine.status, 201, 'валидный путь не задет');
  inst.close();
});

// Аудит 12.10 (P1/P2): ошибки fs-стримов релея не должны ронять сервер.
// До фикса: 'error' у WriteStream/ReadStream без слушателя → uncaughtException
// → крах процесса со всеми живыми сеансами (ENOSPC/ENOTDIR/EISDIR/TOCTOU).

test('relay: ошибка записи (ENOTDIR) → честный 400, сервер жив (P1)', async (t) => {
  const dbPath = tmpDb(t);
  const relayDir = path.join(os.tmpdir(), `enot-relay-err-${Date.now()}`);
  const { base, port, inst } = await startServer(t, { dbPath, relayDir });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });

  // каталог релея превращаем в файл: createWriteStream(<файл>/x.bin) → ENOTDIR
  t.after(() => { try { fs.rmSync(relayDir, { force: true }); } catch { /* нет */ } });
  fs.rmSync(relayDir, { recursive: true, force: true });
  fs.writeFileSync(relayDir, 'now a file');

  const up = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': 'boom.bin',
    },
    body: Buffer.from('данные, которым некуда писаться'),
  });
  assert.equal(up.status, 400, 'ошибка записи — честный отказ, не крах процесса');

  // главный критерий: сервер пережил ошибку стрима
  const health = await fetch(base + '/api/v1/health');
  assert.equal(health.status, 200, 'процесс жив после ошибки WriteStream');
  inst.close();
});

test('relay: ошибка чтения (EISDIR/TOCTOU) при скачивании → обрыв ответа, сервер жив (P2)', async (t) => {
  const dbPath = tmpDb(t);
  const relayDir = path.join(os.tmpdir(), `enot-relay-dl-${Date.now()}`);
  t.after(() => { try { fs.rmSync(relayDir, { recursive: true, force: true }); } catch { /* нет */ } });
  const { base, port, inst } = await startServer(t, { dbPath, relayDir });
  const admin = await adminLogin(dbPath, base);
  const reg = await api(base, 'POST', '/sessions');
  const { sessionId, password, hostToken } = reg.json;
  const host = wsConnect(port);
  await wsAuth(host, { type: 'auth', role: 'host', sessionId, token: hostToken });
  await api(base, 'POST', `/sessions/${sessionId}/claim`, { token: admin.token, body: { password } });

  const up = await fetch(base + '/api/v1/relay', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${hostToken}`,
      'content-type': 'application/octet-stream',
      'x-file-name': 'ok.txt',
    },
    body: Buffer.from('нормальная загрузка'),
  }).then((r) => r.json());
  assert.ok(up?.id, 'загрузка прошла');

  // подменяем путь на каталог: existsSync(dir)=true, createReadStream(dir) → EISDIR.
  // stream.on('error') рвёт ответ (res.destroy()) — сам fetch может упасть с
  // UND_ERR_SOCKET ДО чтения заголовков: обрыв на любом этапе = ожидаемый
  // результат, критерий один — сервер жив.
  inst.db.prepare('UPDATE relay_files SET path = ? WHERE id = ?').run(relayDir, up.id);
  try {
    const dl = await fetch(base + `/api/v1/relay/${up.id}?token=${up.token}`);
    await dl.arrayBuffer().catch(() => { /* обрыв тела — ожидаемо */ });
  } catch { /* сокет оборван до ответа — тоже ожидаемо */ }

  // главный критерий: сервер пережил 'error' у ReadStream
  const health = await fetch(base + '/api/v1/health');
  assert.equal(health.status, 200, 'процесс жив после ошибки ReadStream');
  inst.close();
});

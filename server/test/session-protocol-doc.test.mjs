// docs/SESSION_PROTOCOL.md сверяется с кодом (ACCEPTANCE R-2): всё, что код
// реально шлёт и принимает, обязано быть описано, а таблицы документа — не
// придумывать того, чего в коде нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const doc = read('docs/SESSION_PROTOCOL.md');
const app = read('server/app.mjs');
const protocol = read('client/lib/protocol.mjs');
const arbiter = read('client/lib/input-arbiter.mjs');
const bridge = read('client/agent-bridge/bridge.mjs');
const sessionMedia = read('client/renderer/session-media.js');
const sessionServices = read('client/renderer/session-services.js');
const operatorJs = read('web/operator.mjs');
const term = read('client/lib/term.mjs');
const fileTransfer = read('client/lib/file-transfer.mjs');

const documented = (token) => doc.includes(`\`${token}\``);
const section = (title) => {
  const start = doc.indexOf(title);
  assert.ok(start >= 0, `в документе нет раздела «${title}»`);
  const next = doc.indexOf('\n## ', start + title.length);
  const nextSub = doc.indexOf('\n### ', start + title.length);
  const end = [next, nextSub].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), doc.length);
  return doc.slice(start, end);
};
// первая колонка таблицы: | `token` | …
const tableTokens = (text) => [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

// сигналинг: часть server/app.mjs от onSocket до конца обработчика сообщений
const sigStart = app.indexOf('function onSocket(ws)');
const sig = app.slice(sigStart, app.indexOf('\n  return {', sigStart));
const sigTypes = new Set([
  ...[...sig.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]),
  ...[...sig.matchAll(/msg\.type === '([a-z-]+)'/g)].map((m) => m[1]),
  ...[...sig.matchAll(/msg\.type !== '([a-z-]+)'/g)].map((m) => m[1]),
]);
// эти шлёт endSession/participantLost вне onSocket — тоже часть /signal
for (const extra of ['ended', 'peer-reconnecting']) assert.ok(app.includes(`type: '${extra}'`), extra);
sigTypes.add('ended'); sigTypes.add('peer-reconnecting');

test('SESSION_PROTOCOL: каждый тип сообщения /signal из кода описан', () => {
  assert.ok(sigTypes.size >= 15, `слишком мало типов найдено в коде: ${[...sigTypes]}`);
  for (const t of sigTypes) assert.ok(documented(t), `тип /signal «${t}» есть в server/app.mjs, но не описан`);
});

test('SESSION_PROTOCOL: таблица сообщений /signal не описывает несуществующих типов', () => {
  const rows = tableTokens(section('### Сообщения'));
  assert.ok(rows.length >= 15);
  for (const t of rows) assert.ok(sigTypes.has(t), `в документе «${t}», а в коде сигналинга такого нет`);
});

test('SESSION_PROTOCOL: коды закрытия WebSocket совпадают с кодом', () => {
  const codes = [...app.matchAll(/ws\.close\((\d{4}), '([a-z-]+)'\)/g)].concat([...app.matchAll(/oldWs\.close\((\d{4}), '([a-z-]+)'\)/g)]);
  assert.ok(codes.length >= 6);
  for (const [, code, reason] of codes) {
    assert.ok(documented(code), `код закрытия ${code} не описан`);
    assert.ok(documented(reason), `причина закрытия «${reason}» не описана`);
  }
  for (const code of tableTokens(section('### Коды закрытия'))) {
    assert.ok(codes.some(([, c]) => c === code), `код ${code} описан, но в коде не используется`);
  }
});

test('SESSION_PROTOCOL: причины завершения совпадают с кодом', () => {
  const reasons = new Set([
    ...[...app.matchAll(/endSession\([^,]+, '([a-z-]+)'\)/g)].map((m) => m[1]),
    ...[...app.matchAll(/endOperatorSessions\([^,]+, '([a-z-]+)'\)/g)].map((m) => m[1]),
    ...[...app.matchAll(/\? '([a-z-]+)' : '([a-z-]+)'\);\s*\n\s*const changed = endSession/g)].flatMap((m) => [m[1], m[2]]),
  ]);
  for (const r of ['host-lost', 'operator-lost', 'idle', 'ended']) reasons.add(r);
  const rows = tableTokens(section('## 5. Причины завершения'));
  for (const r of reasons) assert.ok(rows.includes(r), `причина «${r}» есть в коде, но не в таблице`);
  for (const r of rows) assert.ok(reasons.has(r), `причина «${r}» описана, но в коде её нет`);
});

test('SESSION_PROTOCOL: маршруты сеанса описаны', () => {
  const routes = [
    ['/sessions', 'POST'], ['/sessions/:id/claim', 'POST'], ['/sessions/:id/connect', 'GET'],
    ['/sessions/:id/decision', 'POST'], ['/sessions/:id/end', 'POST'], ['/rtc-config', 'GET'],
    ['/machines/:id/claim', 'POST'], ['/agent/register', 'POST'], ['/agent/session', 'GET'], ['/agent/heartbeat', 'POST'],
  ];
  for (const [route, method] of routes) {
    const re = route.includes(':id')
      ? new RegExp(`p\\.match\\(/\\^\\\\/${route.split('/')[1]}\\\\/\\(\\[\\^/\\]\\+\\)\\\\/${route.split('/').pop()}\\$/\\)`)
      : new RegExp(`p === '${route}' && req\\.method === '${method}'`);
    assert.match(app, re, `маршрута ${method} ${route} нет в server/app.mjs — поправьте документ`);
    assert.ok(documented(`${method} ${route}`), `маршрут ${method} ${route} не описан`);
  }
});

test('SESSION_PROTOCOL: каналы данных — те, что создают хост и оператор', () => {
  const hostLabels = /for \(const label of \[([^\]]+)\]\)/.exec(sessionMedia)?.[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1)) ?? [];
  const bridgeLabels = /LABELS = new Set\(\[([^\]]+)\]\)/.exec(bridge)?.[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1)) ?? [];
  const opLabels = [...operatorJs.matchAll(/createDataChannel\('([a-z]+)'\)/g)].map((m) => m[1]);
  const all = new Set([...hostLabels, ...bridgeLabels, ...opLabels]);
  assert.ok(all.size >= 5, `каналы: ${[...all]}`);
  const rows = tableTokens(section('## 6. Каналы данных'));
  for (const l of all) assert.ok(rows.includes(l), `канал «${l}» не описан`);
  for (const l of rows) assert.ok(all.has(l), `канал «${l}» описан, но никто его не создаёт`);
});

test('SESSION_PROTOCOL: события ввода и служебные сообщения управления', () => {
  const validate = protocol.slice(protocol.indexOf('export function validateInputEvent'), protocol.indexOf('export function validateOutgoingSignal'));
  const inputTypes = [...validate.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);
  assert.deepEqual(new Set(tableTokens(section('### 6.1. События ввода'))), new Set(inputTypes));
  const control = new Set([
    ...[...arbiter.matchAll(/m\.type === '([a-z-]+)'/g)].map((m) => m[1]),
    ...[...arbiter.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]).filter((x) => x !== 'invalid'),
    ...[...sessionServices.matchAll(/type: '(input-grant|session-info)'/g)].map((m) => m[1]),
  ]);
  assert.deepEqual(new Set(tableTokens(section('### 6.2.'))), control);
});

test('SESSION_PROTOCOL: форматы файла и терминала названы как в коде', () => {
  for (const t of ['file-meta', 'file-accept', 'file-reject', 'file-done']) {
    assert.ok(fileTransfer.includes(`'${t}'`) && documented(t), `файл: ${t}`);
  }
  for (const t of ['in', 'resize', 'close', 'opened', 'out', 'exit', 'error']) {
    assert.ok(term.includes(`'${t}'`) && documented(t), `терминал: ${t}`);
  }
});

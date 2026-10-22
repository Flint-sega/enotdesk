import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Гигиена 19.10 (B1/B5): AGENTS.md стал публичным (лежит в git). Приватное —
// лаба, прод, доступы, история волн — живёт в .local/AGENTS.private.md. Тест
// не даёт приватному протечь обратно (агенты и autopilot пишут в AGENTS.md
// по привычке) и ловит дрейф ссылок: ADR-номер и пути из документа.

const root = path.join(import.meta.dirname, '..', '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const agents = read('AGENTS.md');

test('AGENTS.md: публичный и компактный', () => {
  assert.ok(Buffer.byteLength(agents) < 24 * 1024, `AGENTS.md ${Buffer.byteLength(agents)} байт — держать < 24 КБ, подробности в docs/ и .local/`);
});

test('AGENTS.md: без приватных деталей стенда, прода и доступов', () => {
  const markers = [
    /\b192\.168\.\d+\.\d+/, // адреса лабы
    /\b10\.10\.10\.\d+/,
    /enot-lab-secrets/,
    /ssh -i /,
    /ACCESS\.md/,
    /prod-admin\.env|staging-admin\.env/,
    /<!-- autopilot:start -->/, // блок autopilot генерирует полную (приватную) версию
  ];
  for (const re of markers) assert.ok(!re.test(agents), `AGENTS.md содержит приватный маркер ${re}`);
});

test('AGENTS.md: «следующий номер ADR» совпадает с docs/adr', () => {
  const nums = readdirSync(path.join(root, 'docs', 'adr'))
    .map((f) => /^(\d{4})-/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = String(Math.max(...nums) + 1).padStart(4, '0');
  assert.match(agents, new RegExp(`следующий номер — ${next}`), `в docs/adr последний ${Math.max(...nums)}, AGENTS.md обязан звать следующим ${next}`);
});

test('AGENTS.md: пути в бэктиках существуют в репозитории', () => {
  const pathLike = /^(client|server|hub|web|helper|docker|docs|scripts|build|site|\.github)\/[\w./-]+$/;
  const missing = [];
  for (const m of agents.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim();
    if (!pathLike.test(tok) || tok.includes('*')) continue;
    if (!existsSync(path.join(root, tok))) missing.push(tok);
  }
  assert.deepEqual(missing, [], `в AGENTS.md ссылки на несуществующие пути: ${missing.join(', ')}`);
});

// Файл инструкций агента живёт только локально (в git не хранится с 22.10): если он
// лежит рядом — проверяем, что ссылается лишь на файлы репозитория, а приватное
// тянет отдельный локальный файл; в CI его нет — проверять нечего.
const AGENT_FILE = 'CLAUDE.md';
test('файл инструкций агента (локальный) ссылается только на файлы из репозитория', (t) => {
  if (!existsSync(path.join(root, AGENT_FILE))) return t.skip('файла инструкций агента нет — он только локальный');
  const text = read(AGENT_FILE);
  for (const m of text.matchAll(/@([\w./-]+)/g)) {
    assert.ok(!m[1].startsWith('.local/'), `${AGENT_FILE} не должен тянуть приватный ${m[1]} — для этого локальный файл заметок`);
    assert.ok(existsSync(path.join(root, m[1])), `${AGENT_FILE} ссылается на отсутствующий ${m[1]}`);
  }
});

test('файл инструкций агента не хранится в git', () => {
  const tracked = execFileSync('git', ['ls-files', '--', AGENT_FILE], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(tracked, '', `${AGENT_FILE} снова попал в git — он только локальный (.git/info/exclude)`);
});

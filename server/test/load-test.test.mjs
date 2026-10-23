// Нагрузочный прогон S-8 (scripts/load-test.mjs): статистика — чистыми функциями,
// сам скрипт — коротким настоящим прогоном (свой сервер, временная база), чтобы
// он не сгнил между ручными запусками.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile, createRecorder, verdict } from '../../scripts/load-stats.mjs';

const script = fileURLToPath(new URL('../../scripts/load-test.mjs', import.meta.url));

test('load-stats: перцентиль «ближайший ранг»', () => {
  const a = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(a, 50), 10);
  assert.equal(percentile(a, 95), 19);
  assert.equal(percentile(a, 100), 20);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 95), null);
});

test('load-stats: копилка и вердикт — p95 сверх порога, ошибки и недобор сеансов/агентов валят прогон', () => {
  const r = createRecorder();
  for (let i = 1; i <= 100; i += 1) r.time('fast', i);
  r.time('slow', 500);
  r.error('slow', 'HTTP 500');
  const s = r.summary();
  assert.equal(s.fast.count, 100);
  assert.equal(s.fast.p95, 95);
  assert.equal(s.slow.errors, 1);
  const good = verdict({ api: { fast: s.fast }, ws: {}, sessions: { planned: 2, approved: 2 }, agents: { planned: 3, onlineAtEnd: 3 }, p95Ms: 200 });
  assert.deepEqual(good, { ok: true, failures: [] });
  const bad = verdict({ api: s, ws: {}, sessions: { planned: 2, approved: 1 }, agents: { planned: 3, onlineAtEnd: 2 }, p95Ms: 200 });
  assert.equal(bad.ok, false);
  assert.equal(bad.failures.length, 4); // slow: p95 и ошибка; сеансы; агенты
  // вход и приём приглашения (scrypt) мерятся своим порогом
  const login = { 'auth.login': { p95: 300, errors: 0 }, 'invites.accept': { p95: 450, errors: 0 } };
  assert.equal(verdict({ api: login, ws: {}, sessions: { planned: 0, approved: 0 }, agents: { planned: 0, onlineAtEnd: 0 }, p95Ms: 200, slowP95Ms: 500 }).ok, true);
  assert.equal(verdict({ api: login, ws: {}, sessions: { planned: 0, approved: 0 }, agents: { planned: 0, onlineAtEnd: 0 }, p95Ms: 200 }).ok, false);
});

test('load-test: короткий прогон (6 агентов, 2 сеанса) проходит и пишет отчёт', { timeout: 120_000 }, async () => {
  const reportPath = path.join(os.tmpdir(), `enotdesk-load-report-${process.pid}.json`);
  const env = {
    ...process.env, LOAD_AGENTS: '6', LOAD_SESSIONS: '2', LOAD_OPERATORS: '1',
    LOAD_DURATION_S: '1', LOAD_RAMP_S: '1', LOAD_HEARTBEAT_MS: '500', LOAD_P95_MS: '5000', LOAD_P95_SLOW_MS: '5000', LOAD_REPORT: reportPath,
  };
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [script], { env, timeout: 110_000 }, (e, stdout, stderr) => resolve({ code: e?.code ?? 0, stdout, stderr }));
  });
  try {
    assert.equal(out.code, 0, `прогон упал:\n${out.stdout.slice(-1500)}\n${out.stderr.slice(-800)}`);
    const rep = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(rep.ok, true);
    assert.equal(rep.sessions.approved, 2); // один attended, один машинный
    assert.equal(rep.agents.onlineAtEnd, 6);
    assert.ok(rep.api['agent.heartbeat'].count > 0);
    assert.ok(rep.ws['relay.offer'].count === 2);
    // пароль временного админа не попадает ни в вывод, ни в отчёт
    assert.doesNotMatch(out.stdout + JSON.stringify(rep), /password/i);
  } finally {
    fs.rmSync(reportPath, { force: true });
  }
});

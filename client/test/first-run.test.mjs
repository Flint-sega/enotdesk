import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveServerUrl, SERVER_FILE_NAME } from '../lib/first-run.mjs';

// Временный «exe»: рядом с ним живёт enotdesk-server.txt
function makeExeDir({ withFile = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'enot-first-run-'));
  if (withFile !== null) writeFileSync(path.join(dir, SERVER_FILE_NAME), withFile);
  const execPath = path.join(dir, 'EnotDesk');
  return { dir, execPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Ожидания заданы порядком из спецификации (Решения §первый запуск):
// сохранённый в settings → файл enotdesk-server.txt рядом с exe →
// вшитый при сборке baked → дефолт 127.0.0.1:8080. Не пересчётом через код.

test('сохранённый адрес сильнее файла, baked и дефолта', () => {
  assert.deepEqual(
    resolveServerUrl({ saved: 'https://saved.example.com', execPath: null, baked: 'https://baked.example.com' }),
    { url: 'https://saved.example.com', source: 'saved' },
  );
});

test('адрес из файла рядом с exe берётся, обрезается и сильнее baked', () => {
  const t = makeExeDir({ withFile: '\n  https://file.example.com  \nhttp://after.example.com\n' });
  try {
    assert.deepEqual(
      resolveServerUrl({ saved: null, execPath: t.execPath, baked: 'https://baked.example.com' }),
      { url: 'https://file.example.com', source: 'file' },
    );
  } finally { t.cleanup(); }
});

test('мусор в файле пропускает источник: побеждает baked, без baked — дефолт', () => {
  for (const garbage of ['не адрес', 'ftp://example.com', '\n\n   \n']) {
    const t = makeExeDir({ withFile: garbage });
    try {
      assert.deepEqual(
        resolveServerUrl({ saved: null, execPath: t.execPath, baked: 'https://baked.example.com' }),
        { url: 'https://baked.example.com', source: 'baked' },
        garbage,
      );
      assert.deepEqual(
        resolveServerUrl({ saved: null, execPath: t.execPath, baked: null }),
        { url: 'http://127.0.0.1:8080', source: 'default' },
        garbage,
      );
    } finally { t.cleanup(); }
  }
});

test('нет файла рядом с exe — источник файла пропущен', () => {
  const t = makeExeDir();
  try {
    assert.deepEqual(
      resolveServerUrl({ saved: null, execPath: t.execPath, baked: null }),
      { url: 'http://127.0.0.1:8080', source: 'default' },
    );
  } finally { t.cleanup(); }
});

test('без execPath файловая ветка недостижима (модуль не падает)', () => {
  assert.deepEqual(
    resolveServerUrl({ saved: null, execPath: null, baked: 'https://baked.example.com' }),
    { url: 'https://baked.example.com', source: 'baked' },
  );
  assert.deepEqual(
    resolveServerUrl({ saved: null, execPath: null, baked: null }),
    { url: 'http://127.0.0.1:8080', source: 'default' },
  );
});

test('мусор в baked отклоняется — честный дефолт, а не сломанный адрес', () => {
  assert.deepEqual(
    resolveServerUrl({ saved: null, execPath: null, baked: 'почти адрес' }),
    { url: 'http://127.0.0.1:8080', source: 'default' },
  );
});

test('пустые saved и baked не отваливают дефолт', () => {
  assert.deepEqual(
    resolveServerUrl({ saved: '   ', execPath: null, baked: '' }),
    { url: 'http://127.0.0.1:8080', source: 'default' },
  );
});

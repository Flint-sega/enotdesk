// Регрессия v0.2.0 (релизные сборки: «кнопки не нажимаются»): рендерер —
// sandbox + contextIsolation, CSP script-src 'self' блокирует ЛЮБОЙ node:-
// скрипт в графе ES-модулей, а один упавший статический импорт роняет ВЕСЬ
// модульный граф (app.js не выполняется → ни один слушатель не повешен).
// Поймал CDP: «Loading the script 'node:child_process' violates … script-src
// 'self'» — в граф рендерера попадал lib/term.mjs (import node:child_process)
// через session-services.js.
//
// Контракт (без Electron, чистый статический разбор): граф импортов от
// client/renderer/app.js должен (1) состоять только из относительных
// спецификаторов, (2) резолвиться в существующие файлы под client/** (то, что
// пакует electron-builder), (3) не тянуть node:/bare-модулей — ни статически,
// ни динамически.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RENDERER_ENTRY = path.join(ROOT, 'client', 'renderer', 'app.js');

// Выкидываем строки-комментарии (// …) ДО разбора: в текстах комментариев
// встречается `import 'node:child_process'` как упоминание (иначе регэксп
// поймает комментарий). Блочных комментариев с import-синтаксисом в клиенте
// нет; строки кода внутри блока не начинаются с «//».
function dropLineComments(source) {
  return source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
}

// Статические импорты/реэкспорты: `import … from 'x'`, `export … from 'x'`
// (многострочные списки — ок) и сайд-эффект `import 'x'`.
function staticSpecifiers(source) {
  const specs = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of dropLineComments(source).matchAll(re)) specs.push(m[1] ?? m[2]);
  return specs;
}

// Динамические: import('x') / import("x") — строки, где перед ним нет «//».
function dynamicSpecifiers(source) {
  const specs = [];
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('//')) continue;
    for (const m of line.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  }
  return specs;
}

function resolveSpecifier(fromFile, spec) {
  return path.resolve(path.dirname(fromFile), spec);
}

test('граф импортов рендерера: только относительные существующие файлы client/**, без node:/bare-модулей', () => {
  assert.equal(existsSync(RENDERER_ENTRY), true, 'нет точки входа рендерера app.js');

  const seen = new Set();
  const queue = [RENDERER_ENTRY];
  const graph = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    assert.equal(
      existsSync(file), true,
      `файл из графа рендерера отсутствует (мёртвый импорт — валит весь граф): ${file}`,
    );
    assert.equal(
      file.startsWith(path.join(ROOT, 'client') + path.sep), true,
      `файл графа рендерера вне client/** — не попадёт в сборку electron-builder: ${file}`,
    );

    const source = readFileSync(file, 'utf8');
    graph.push(path.relative(ROOT, file));

    for (const spec of staticSpecifiers(source)) {
      assert.equal(
        spec.startsWith('.'), true,
        `СТАТИЧЕСКИЙ не-относительный импорт '${spec}' в ${path.relative(ROOT, file)} — ` +
        'в sandbox-рендерере CSP script-src \'self\' блокирует node:/bare-скрипт и роняет ВЕСЬ модульный граф (регресс v0.2.0)',
      );
      const resolved = resolveSpecifier(file, spec);
      assert.equal(existsSync(resolved), true, `импорт '${spec}' не резолвится из ${path.relative(ROOT, file)}`);
      queue.push(resolved);
    }

    for (const spec of dynamicSpecifiers(source)) {
      assert.equal(
        spec.startsWith('.'), true,
        `ДИНАМИЧЕСКИЙ импорт '${spec}' в ${path.relative(ROOT, file)} — node:/bare недопустимы в графе рендерера`,
      );
      queue.push(resolveSpecifier(file, spec));
    }
  }

  // Ключевые узлы графа на месте: локали (исторический питфолл) и чистый
  // term-протокол (регресс v0.2.0: вместо lib/term.mjs с node:child_process).
  assert.ok(graph.includes(path.join('client', 'lib', 'i18n.mjs')), 'в графе нет i18n.mjs');
  assert.ok(graph.includes(path.join('client', 'locales', 'ru.mjs')), 'в графе нет словаря ru.mjs');
  assert.ok(graph.includes(path.join('client', 'locales', 'en.mjs')), 'в графе нет словаря en.mjs');
  assert.ok(graph.includes(path.join('client', 'lib', 'term-protocol.mjs')), 'в графе нет term-protocol.mjs');
  assert.ok(!graph.includes(path.join('client', 'lib', 'term.mjs')),
    'lib/term.mjs (node:child_process) не должен быть в графе рендерера — только term-protocol.mjs');
});

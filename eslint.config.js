// ESLint (flat config): только реальные ошибки, стилистика не обсуждаем.
// Правило дома: комментарии в пустых блоках обязательны — это ловит no-empty.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**', 'dist/**', 'archive/**', '.autopilot/**',
      'graphify-out/**', 'docs/**', 'assets/**', 'build/**', '.zcode/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // main-процесс живёт в Node, рендерер — в браузере; пересечение безвредно
    files: ['client/**/*.mjs', 'client/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];

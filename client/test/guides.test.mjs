// Руководства людям (docs/guides, ACCEPTANCE K-2/K-3): ссылки живые, кнопки
// и пункты меню называются так же, как в словаре программы, форма issue на месте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ru from '../locales/ru.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const guidesDir = path.join(root, 'docs/guides');
const guides = readdirSync(guidesDir).filter((f) => f.endsWith('.md'));
const read = (f) => readFileSync(path.join(guidesDir, f), 'utf8');

test('guides: шесть руководств и оглавление на месте', () => {
  for (const f of ['README.md', 'client.md', 'operator.md', 'server-admin.md', 'unattended.md', 'troubleshooting.md', 'release-rollback.md']) {
    assert.ok(guides.includes(f), `нет docs/guides/${f}`);
  }
});

test('guides: относительные ссылки ведут на существующие файлы', () => {
  for (const f of guides) {
    for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = target.split('#')[0];
      assert.ok(existsSync(path.resolve(guidesDir, file)), `${f}: битая ссылка «${target}»`);
    }
  }
});

test('guides: названия кнопок совпадают со словарём программы', () => {
  // кнопка в тексте «…» обязана существовать в ru-словаре — переименовали в UI, поправьте руководство
  const labels = new Set(Object.values(ru));
  const quoted = {
    'client.md': ['Получить помощь', 'Разрешить', 'Отклонить', 'Скрыть экран', 'Показать снова', 'Сменить экран', 'Отправить файл', 'Синхронизировать буфер обмена', 'Завершить сеанс', 'Копировать ID и пароль', 'Запрос на подключение'],
    'operator.md': ['ID клиента', 'Пароль сеанса', 'Подключиться', 'Взять управление', 'Отдать управление', 'Передать управление', 'Только смотреть', 'Терминал', 'Сообщение', 'Разбудить', 'Отозвать', 'Архив приглашений', 'Аккаунт', 'Команда', 'Адресная книга', 'История', 'Журнал'],
    'unattended.md': ['Добавить машину', 'Создать и получить код', 'Машина (постоянный доступ)', 'Установить службу', 'Сохранить и проверить', 'Машины'],
  };
  for (const [f, list] of Object.entries(quoted)) {
    const text = read(f);
    for (const label of list) {
      assert.ok(labels.has(label), `«${label}» нет в client/locales/ru.mjs`);
      assert.ok(text.includes(`«${label}»`) || text.includes(`**${label}**`), `${f}: не упоминает «${label}»`);
    }
  }
});

test('troubleshooting: журналы всех частей и путь к форме issue', () => {
  const t = read('troubleshooting.md');
  for (const needle of ['enotdesk-boot.log', 'enotdesk-video.log', 'svc-diag.enabled', 'journalctl -u enotdesk-agent', 'enotdesk-agent.log', 'journalctl -u enotdesk ']) {
    assert.ok(t.includes(needle), `troubleshooting: нет «${needle}»`);
  }
  assert.ok(existsSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.yml')), 'форма issue');
  const form = readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8');
  assert.match(form, /docs\/guides\/troubleshooting\.md/);
  assert.match(form, /SECURITY\.md/);
});

test('guides: пути журналов совпадают с кодом (boot-лог, svc-diag, хелпер)', () => {
  const bootLog = readFileSync(path.join(root, 'client/lib/boot-log.mjs'), 'utf8');
  const svcDiag = readFileSync(path.join(root, 'client/lib/svc-diag.mjs'), 'utf8');
  const helper = readFileSync(path.join(root, 'helper/video/src/main.rs'), 'utf8');
  assert.match(bootLog, /'enotdesk-boot\.log'/);
  assert.match(svcDiag, /'svc-diag\.enabled'/);
  assert.match(helper, /enotdesk-video\.log/);
});

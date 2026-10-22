import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Контракт установщика: конфиг coturn должен читаться службой. Debian-юнит coturn
// работает от User=turnserver; при root:root 0600 он молча стартует на дефолтах
// (без realm и static-auth-secret) и не выдаёт ретрансляцию — так прод жил
// с 27.09 по 22.10.2026 («Cannot find config file» в журнале coturn).

const script = readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'install-server.sh'), 'utf8');
const turnBlock = script.slice(script.indexOf('echo "# EnotDesk managed (ENOTDESK_MANAGED)'), script.indexOf('systemctl restart coturn'));

test('install-server.sh: конфиг coturn — группа turnserver и 0640, не голый 0600', () => {
  assert.match(turnBlock, /chgrp turnserver "\$TURN_CONF"/);
  assert.match(turnBlock, /chmod 0640 "\$TURN_CONF"/);
});

test('install-server.sh: до перезапуска coturn проверяет, что служба читает конфиг', () => {
  assert.match(turnBlock, /runuser -u turnserver -- test -r "\$TURN_CONF"/);
  assert.match(turnBlock, /die /);
});

test('install-server.sh: в строках конфига coturn нет комментариев после значения', () => {
  // coturn не понимает «опция  # комментарий»: на лабе так потерялся realm (22.10.2026)
  const lines = [...turnBlock.matchAll(/echo "([a-z-]+[^"]*)"/g)].map((m) => m[1]);
  assert.ok(lines.length >= 8, 'строки конфига найдены');
  for (const l of lines) assert.ok(!l.includes('#'), `строка конфига с комментарием: ${l}`);
});

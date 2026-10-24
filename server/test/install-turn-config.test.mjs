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

test('install-server.sh и docker: диапазон ретрансляции 49160–49999 (замер 22.10: ~5 портов на сеанс)', () => {
  assert.match(turnBlock, /echo "min-port=49160"/);
  assert.match(turnBlock, /echo "max-port=49999"/);
  assert.match(script, /ufw allow 49160:49999\/udp/, 'файрвол открывает тот же диапазон');
  const entry = readFileSync(path.join(import.meta.dirname, '..', '..', 'docker', 'coturn', 'entrypoint.sh'), 'utf8');
  assert.match(entry, /^max-port=49999$/m, 'docker-coturn — тот же диапазон');
});

test('install-server.sh: конфиг coturn создаётся 0600 до записи секрета (ревью 1.13, 24.10)', () => {
  const at = script.indexOf('install -m 0600 /dev/null "$TURN_CONF"');
  assert.ok(at > 0, 'нужен install -m 0600 до записи');
  assert.ok(at < script.indexOf('echo "static-auth-secret=$TURN_SECRET"'), 'права выставляются раньше, чем пишется секрет');
});

test('quick-setup.sh: копия .env и скрипт сборок — во временной папке, не в корне ФС (ревью 1.13, 24.10)', () => {
  const qs = readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'quick-setup.sh'), 'utf8');
  // SETUP_TMP обнуляется только при объявлении: иначе "$SETUP_TMP/env.docker-prev" = /env.docker-prev
  assert.equal([...qs.matchAll(/SETUP_TMP=""/g)].length, 1);
  const prev = qs.indexOf('local prev_envf="$SETUP_TMP/env.docker-prev"');
  const ensure = qs.lastIndexOf('SETUP_TMP="$(mktemp -d /tmp/enotdesk-setup.XXXXXX)"', prev);
  assert.ok(ensure > 0 && ensure < prev, 'перед копией .env временная папка гарантирована (и с --tarball)');
  assert.match(qs, /install -m 0600 "\$envf" "\$prev_envf"/, 'копия с секретами — 0600');
});

# 05 — C1: удалённый терминал (SYSTEM v1)

**Требования:** R09, R09.1
**Blocked by:** —
**Зона:** `client/lib/term.mjs` (новое), `client/main.mjs`/агент-wiring (term-канал + heartbeat termActive), `server/app.mjs` (heartbeat-расширение + audit переходов), `web/operator.*` (терминал-панель), `client/locales/*`, `client/test/term.test.mjs` (новое)
**Волна:** 3
**Status:** ready

## Что должно заработать

Оператор открывает терминал машины (внутри утверждённого сеанса): команды
выполняются на машине от контекста службы (SYSTEM v1 — честно помечено), вывод
возвращается. Лимиты и аудит — согласно спеке.

## Из брифа, дословно

> «C1» — удалённый терминал от службы (SYSTEM), политика+аудит+лимиты

## Разделы спецификации

Истории 11–12, Решения §терминал, Границы (client/lib/term.mjs).

## Критерии приёмки

- [ ] `createTerm({shell, cols, rows}) → {write, onData, resize, kill}`; `spawnShellFor(platform)`: win — powershell (SYSTEM, честная пометка), linux — `sudo -u <console-user> bash`, mac — `launchctl asuser` + zsh (best-effort)
- [ ] DC-канал `term` (allowlist имён дополнен); открывается только внутри approved-сеанса
- [ ] Лимиты: 1 терминал на машину, кольцевой буфер вывода 512 КБ, idle-таймаут 5 мин
- [ ] Аудит: heartbeat передаёт termActive → сервер пишет term.open/term.close при переходах
- [ ] Юнит-тесты шва: фейк-PTY (write/onData/kill), лимиты, таймаут; `npm test` зелёные

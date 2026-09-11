# Границы, решённые в спецификации (развёртывание)

## Общие правила проекта

- Стек: без изменений (Node 24 ESM, Electron 44.3.0, ws 8.21.3, koffi 3.2.1). Скрипты — POSIX bash; node-скрипты ESM `.mjs`.
- Тестовая команда: `npm test` (46 тестов, сервер+desktop). Один файл: `node --test server/test/xxx.test.mjs`.
- Не трогать: server/app.mjs, desktop/, assets/, .autopilot/ (кроме оркестратора). Скрипты не меняют код приложения.
- Секреты: только имена `ENOT_*`; значения — в `.env` пользователя; никогда в репозиторий, промпты, логи, отчёты.
- Если не хватает зависимости — вернуть `BLOCKED`, не устанавливать самому.
- Коммиты — только оркестратор, после ревью.

## Контракты развёртывания

- `scripts/install-server.sh` (на сервере, root):
  - CLI: `--dry-run`, `--update <tarball>`, `--uninstall`, `--purge-data`, `--open-firewall`, `--help`; аргумент по умолчанию: путь к tarball.
  - env: `ENOT_PORT` (8080), `ENOT_BIND` (0.0.0.0), `ENOT_PUBLIC_URL` (по умолчанию `http://<host>:<port>`), `ENOT_DB` (по умолчанию `/var/lib/enotdesk/enotdesk.db`), TURN-переменные — пробрасываются в env-файл при задании.
  - Пути: релизы `/opt/enotdesk/releases/<UTC-штамп>`, symlink `/opt/enotdesk/current`, env `/etc/enotdesk/enotdesk.env` (0600), unit `/etc/systemd/system/enotdesk.service`, пользователь `enotdesk` (system, nologin), владелец `/opt/enotdesk` и `/var/lib/enotdesk`.
  - Node 24: официальный tarball nodejs.org (`NODE_VERSION`, default 24.12.0, x86_64) + SHA256; установка в `/opt/node-24`, симлинки в `/usr/local/bin`; apt/NodeSource не используются (D01).
  - health-poll: `curl -fsS http://127.0.0.1:$ENOT_PORT/api/v1/health`, до 30 c.
- `scripts/deploy-server.sh` (локально):
  - env: `ENOT_DEPLOY_HOST` (обязательно), `ENOT_DEPLOY_USER` (root), `ENOT_DEPLOY_PASSWORD` (опционально; sshpass), `ENOT_DEPLOY_PORT` (22), `ENOT_PORT` (8080), `ENOT_DEPLOY_PROTO` (http).
  - tarball: `server/`, `package.json`, `package-lock.json`, `scripts/install-server.sh`; серверный путь `/tmp/enotdesk-install/`.
  - печатает: статус, health-URL, следующая команда (bootstrap админа).
- `scripts/smoke-remote.mjs` (локально, node):
  - env: `ENOT_BASE_URL`, `ENOT_ADMIN_LOGIN`, `ENOT_ADMIN_PASSWORD`.
  - цикл: login → POST /sessions → claim (тот же admin-токен) → decision allow (hostToken) → WS auth host + operator → relay offer/answer → end. Код возврата ≠ 0 при сбое. Ничего не печатает из секретов.

## Что уже построено (прошлый ран)

- `server/app.mjs` `createServer({dbPath,host,port,...}) -> {start,close}` — единая точка; HTTP /api/v1 и WS /signal по frozen-контракту; bootstrap `npm run bootstrap`.
- WS Origin: при наличии заголовка требуется совпадение host; без Origin — пропускается (desktop-клиент из main-процесса Origin не шлёт).
- `ENOT_PUBLIC_URL` влияет на ссылки в /invite и /downloads.

## Из таска 05 — скрипты (реализовано)

- `scripts/install-server.sh`: все флаги контракта; принимает `ENOT_BIND`, но в env-файл пишет `ENOT_HOST` (так читает server/main.mjs); релизы `/opt/enotdesk/releases/<UTC>-<sha12>`; валидация tarball до распаковки; health-poll; сообщает команду bootstrap.
- `scripts/deploy-server.sh`: tarball из `server/`, `package*.json`, `scripts/install-server.sh` → `/tmp/enotdesk-install/`; `sshpass -e` только при заданном пароле.
- `scripts/smoke-remote.mjs`: env `ENOT_BASE_URL`, `ENOT_ADMIN_LOGIN`, `ENOT_ADMIN_PASSWORD`; полный цикл против развёрнутого сервера; exit≠0 при сбое; прогнан локально против реального сервера — PASS.
- `.env.example`: добавлены `ENOT_DEPLOY_HOST/USER/PORT/PASSWORD`, `ENOT_ADMIN_LOGIN/PASSWORD` (пустые).

## Из таска 08 — D01 (реализовано)

- `install-server.sh`: Node ставится tarball-ом (NODE_VERSION default 24.12.0, SHA256 через SHASUMS256.txt, `/opt/node-24`, симлинки `/usr/local/bin`); apt не используется; preflight — root + x86_64 + curl/tar/xz.
- `deploy-server.sh`: удалённый install под nohup, лог `/tmp/enotdesk-install/install.log`, rc-маркер `install.rc`, poll каждые 5 c до 600 c, ssh-опции ServerAliveInterval=5/CountMax=3; ошибка — tail лога и exit 1.
- `docs/SERVER.md`: ручная установка Node — tarball.

## Из таска 06 — документация (реализовано)

- `docs/SERVER.md` — установка/управление/обновление/TLS/бэкап/bootstrap/диагностика.
- `docs/BUILD.md` — сборки macOS (проверено)/Windows/Linux (не прогонялось), подпись, CI-заметка.
- `README.md` — разделы «Сервер» и «Сборка» со ссылками.

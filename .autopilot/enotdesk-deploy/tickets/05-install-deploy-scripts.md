# 05 — Скрипты установки и деплоя

**Требования:** R20, R20.1–R20.4, R22 (скриптовая часть), R24i
**Blocked by:** нет
**Зона:** `scripts/`, `.env.example`
**Волна:** 1

## Что должно заработать

Владелец с локальной машины одной командой ставит сервер EnotDesk на Ubuntu-хост; повторный запуск обновляет, `--uninstall` удаляет сервис без потери БД, `--purge-data` — с данными. Установка ставит Node 24, релизы в `/opt/enotdesk/releases/<штамп>` + симлинк `current`, systemd-юнит `enotdesk.service` от пользователя `enotdesk`, env-файл `0600`. Отдельный node-скрипт проверяет развёрнутый сервер снаружи через HTTP+WS.

## Разделы спецификации

Истории 1–5, 10; Решения §3; Границы §4.

## Критерии приёмки

- [ ] `scripts/install-server.sh`: флаги `--dry-run`, `--update <tar.gz>`, `--uninstall`, `--purge-data` (вместе с --uninstall), `--open-firewall`, `--help`; preflight-ошибки человеческим текстом (не root, не Debian/Ubuntu, занят порт, битый tarball); идемпотентность (повторный запуск не падает, релиз переиспользуется при том же tarball); секреты не печатаются; health-poll ≤30 c; `bash -n` чистый
- [ ] `scripts/deploy-server.sh`: собирает tarball (`server/`, `package.json`, `package-lock.json`, `scripts/install-server.sh`), доставляет в `/tmp/enotdesk-install/`, выполняет установщик, проверяет health на сервере и снаружи, печатает URL и шаги bootstrap; транспорт scp/ssh, `sshpass` только при `ENOT_DEPLOY_PASSWORD`, иначе ключ; без хоста — понятная ошибка; `bash -n` чистый
- [ ] `scripts/smoke-remote.mjs` (node): env `ENOT_BASE_URL`, `ENOT_ADMIN_LOGIN`, `ENOT_ADMIN_PASSWORD`; сценарий login → sessions create → claim → decision allow → WS auth host+operator → relay offer/answer → end; ненулевой код при любом сбое; секреты не печатаются
- [ ] `.env.example`: добавлены пустые `ENOT_DEPLOY_HOST/USER/PASSWORD`, `ENOT_ADMIN_LOGIN/PASSWORD` с комментариями
- [ ] Проверено фактически: `bash -n` оба; `install-server.sh` без root на macOS → понятная ошибка preflight; `deploy-server.sh` без хоста → понятная ошибка; `smoke-remote.mjs` синтаксически загружается (`node --check`). Полный прогон на Ubuntu — приёмка оркестратора (R22)

## Из брифа, дословно

> «нужен скрипт установки на сервер автоматический»

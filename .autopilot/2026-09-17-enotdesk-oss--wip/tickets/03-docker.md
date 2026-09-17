# 03 — Docker: compose (server + coturn + caddy)

**Требования:** R13i, R16i, R02.1, R02.2, R13i.1
**Blocked by:** —
**Зона:** `docker/`, корневой `Dockerfile`, `compose.yaml`, `.env.example`, раздел README (quick start)
**Волна:** 1
**Status:** ready

## Что должно заработать

Self-hostер с установленным Docker поднимает EnotDesk одной командой:
HTTPS по домену автоматически, TURN работает, данные в volume'ах.

## Из брифа, дословно

> «Open source» · «TURN и TLS разворачиваются из коробки, а не по доке»

## Разделы спецификации

Истории 1–4; Решения §compose, §TURN; Границы (`docker/`).

## Критерии приёмки

- [ ] `Dockerfile` (multi-stage, node:24-alpine) собирает образ сервера; тесты внутри образа не нужны
- [ ] `compose.yaml`: сервисы enotdesk + coturn + caddy; healthcheck enotdesk; volumes для БД и dist; env через `.env` (DOMAIN, TURN_SECRET и т.п. — имена в `.env.example`)
- [ ] coturn: static-auth-secret из env, realm из DOMAIN, relay-порты 49160-49200/udp задокументированы
- [ ] Без DOMAIN: caddy/http-режим с честным предупреждением в логах (история 2)
- [ ] `docker compose config` валиден; локальный прогон `docker compose up` даёт `/api/v1/health` 200 (если Docker недоступен в среде — `BLOCKED` + конфиг проверен `config`)
- [ ] README quick-start (5 минут) ссылается на compose

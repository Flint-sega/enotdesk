# 01 — Hub-каркас: сервер, SSO, деплой-обвязка

**Требования:** R01, R01.1
**Blocked by:** —  **Зона:** `hub/` (новое: main/app/db/auth), compose.yaml, scripts/quick-setup.sh, scripts/install-server.sh (юнит), .env.example, client/locales (заглушки ключей)
**Волна:** 1

## Что должно заработать
Hub стартует как сервис: health (честно отражает доступность EnotDesk), SSO-логин (прокси /auth/login, cookie-sid, ревалидация /auth/me, logout), каркас консоли /hub/ (тёмная тема /operator-стиль, i18n ru/en), Caddy-маршруты (/hub/, /widget.js, /w, /join — заглушки), compose-сервис + вопрос quick-setup + bare-metal юнит enotdesk-hub.

## Критерии приёмки
- [ ] createHub({dbPath,port,enotdeskUrl,...}) — node:http, своя SQLite (schema_version), graceful close
- [ ] SSO: логин только при живом EnotDesk; сессии sid HttpOnly/SameSite/Secure-on-https; ревалидация; роли operator/admin; 401-и честные
- [ ] health: {ok, enotdesk:true|false} — ping /api/v1/health апстрима (кэш 5с, таймаут 2с)
- [ ] Деплой: compose hub (x-hardening, depends_on, env), quick-setup вопрос «Установить EnotDesk Hub?» (docker+baremetal), ENOT_HUB_PORT/ENOTDESK_URL/HUB_URL в .env.example
- [ ] Тесты: SSO на фейк-EnotDesk (инъекция enotFetch), сессии/логаут/роли, health; docker compose config валиден; npm test (335+новые) зелёный, lint чист

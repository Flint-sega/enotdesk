# Interfaces — EnotDesk OSS

## Границы, решённые в спецификации

| Модуль | Владеет | Выставляет | Прячет |
|---|---|---|---|
| `server/machines.mjs` | машины, группы, PIN-хеши, onboarding-коды | `createMachinesStore(db)` → `list/createOnboarding/revoke/delete/setPin/verifyPin/machineByToken/touch` | генерацию кодов, хеширование, SQL |
| `server/app.mjs` (маршруты) | HTTP-поверхность /machines, /agent | ветки `handle()` | валидацию тел, RBAC, rate-limit |
| `client/lib/agent.mjs` | цикл агента: регистрация, reconnect-backoff, heartbeat, принятие claim | `createAgent({api, signal, native, policy})` → `{start, stop, status}` | состояние backoff, повторы |
| `client/agent-service/` | конфиги служб 3 ОС + install/remove скрипты | файлы (sc.exe / systemd / launchd) | различия ОС |
| `client/lib/i18n.mjs` | словари, выбор языка, фолбэк | `t(key, vars)`, `setLocale`, `initLocale` | загрузку словарей |
| `web/input-source.mjs` | DOM-события → события протокола | `wireBrowserInput(video, send, {keys})` | нормализацию координат, раскладку (e.code) |
| `web/operator.html` + модули | UI браузерного оператора | страница за RBAC | переиспользование session-* модулей |
| `docker/` | compose, coturn, caddy конфиги | файлы + `docker compose up` | порты, volume'ы, env |
| `.github/workflows/release.yml` | сборка релиза, checksums, updater-фид | файлы workflow | шаги подписи (закомментированы) |

**Швы для тестов** (только здесь):
1. `createServer()` HTTP/WS — server/test.
2. lib-шимы без Electron — client/test (включая agent-цикл на инертных адаптерах и фейк-сигналинге).
3. Контракт-тест рендерера — расширяется на web/operator.html и словари (ключи ru=en).

## Правила проекта (из AGENTS.md, дословно по существу)

- Server is pure ESM `.mjs`, node:sqlite (experimental warning is normal), no frameworks — only `ws` + `koffi`. Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; renderer talks only via preload bridge `window.enot`.
- Keys/buttons/scroll/SDP sizes are allowlisted and bounded (protocol.mjs); file serving is name-allowlisted, traversal rejected. Unavailable platform features report honest status, never fake success.
- Русские тексты ошибок; токены только хешами в БД; в renderer не утекают (sanitizeForRenderer).
- electron 44.3.0 и koffi 3.2.1 точные пины — не бампать; `asarUnpack` для koffi обязателен.
- Input decision belongs to main via WS-state gate (`gate.isOpen()`), never trust renderer claims.
- Решение о вводе и RBAC проверяются на каждом запросе; last active admin protected.
- Команды: `npm test` (node --test server/test client/test), `npm run lint`, `npm run smoke:local`, `npm start`, `npm run server`.
- Отсутствующая зависимость/доступ — возвращай `BLOCKED`, не ставь пакет самостоятельно.
- ADR на архитектурные решения — нумерация продолжается с 0016 (docs/adr/)

## Из таска 01 — OSS-фундамент

- `LICENSE` = AGPL-3.0; `README.md` (English, точка входа) ↔ `README.ru.md` (русский, полный)
- CI: `.github/workflows/test.yml` — ubuntu = блокирующий lint+test+smoke+audit; win/mac = continue-on-error lint+test
- SECURITY.md: приватный канал уязвимостей — GitHub private advisories

## Из таска 02 — i18n

- `client/lib/i18n.mjs`: `t(key, vars?, loc?)`, `setLocale`, `getLocale`, `initLocale(saved)` (saved → система → en), `pickLocale(acceptLanguage)` → 'ru'|'en'
- словари: `client/locales/{ru,en}.json` (~210 плоских ключей); паритет ключей проверяет контракт-тест
- серверные страницы: `downloadsHtml(items, version, locale)`, `inviteHtml(version, locale)`, `page(res, title, html, locale)`; язык по `Accept-Language`, дефолт ru
- мост: `enot.setLocale(locale)`; `getSettings().locale` (null = по системе)
- разметка: `data-i18n`, `data-i18n-html`, `-placeholder`, `-aria-label`, `-title`
- ВНИМАНИЕ (кросс-зависимость): `server/app.mjs`/`pages.mjs` импортируют `../client/lib/i18n.mjs` — деплой-тарбалл (зона 04) обязан включать `client/lib/i18n.mjs` + `client/locales/`; Dockerfile таска 03 уже копирует

## Из таска 03 — Docker

- compose-сервисы: `enotdesk` / `coturn` / `caddy`; env: `DOMAIN`, `TURN_SECRET` (обязателен), `TURN_USERNAME` (опц.)
- entrypoint вычисляет: `ENOT_PUBLIC_URL=https://$DOMAIN`, `ENOT_TURN_URLS=stun:$DOMAIN:3478,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp` (валидный формат, проверен живым rtc-config; исходное объявление «stun+turn:» было ошибкой контракта, не кода), `ENOT_TURN_USERNAME=2000000000`, `ENOT_TURN_PASSWORD=base64(HMAC-SHA1(TURN_SECRET, username))`
- coturn: use-auth-secret + static-auth-secret, realm=DOMAIN, relay 49160-49200/udp, `network_mode: host` (путь Linux VPS)
- тома: `enotdesk-data` (/data — БД), `enotdesk-dist` (/data/dist); без `TURN_SECRET` compose падает при интерполяции с подсказкой

## Из таска 05 — браузерный оператор

- `web/input-source.mjs`: `wireBrowserInput(video, send, {keys, onUnsupported?, throttleMs?}) → {detach()}`
- `GET /operator`: 401 аноним / 403 auditor / 200 admin|operator; CSP `script-src 'self'; connect-src 'self'; media-src blob:`; роль — cookie `enot_op` (навигация не шлёт Authorization)
- статика только по allowlist `OPERATOR_ASSETS` (`/web/…`, `/client/lib/…`, `/client/renderer/…`, `/client/locales/:name`)
- `pages.mjs`: `operatorPage(res, status, locale, title, version)`; ключи словаря `web.*` (паритет в тесте)
- переиспользованы Electron-free lib (chat/clip/file/protocol/keymap/rtc-stats) + renderer {dom,state}; session-media/services НЕ импортированы (жёсткая привязка к window.enot)

## Из таска 06 — machines

- `createMachinesStore(db, {nowMs?, onlineWindowMs?})` → list/createOnboarding({name,groupName,createdBy},{ttlMs})/register({code,name,os,version})/revoke/delete/setPin(id,pin|null)/verifyPin/machineByToken/touch/get/out
- HTTP: GET/POST /machines, DELETE /machines/:id, POST /machines/:id/{claim,pin,revoke}; POST /agent/register, GET /agent/session, POST /agent/heartbeat
- сеанс машины: agent token → WS host-роль существующего /signal (без правок signaling); audit machine.claim/claim.deny (actorId=machine-id, unattended=true); /history отдаёт machineId
- миграция: `schema_version`, SCHEMA_VERSION=2; online = last_seen в окне 60с (onlineWindowMs)
- дозапрос 06: отказные тексты машинных маршрутов через `t(key, {}, pickLocale(accept-language))`, ключи `machines.*` (ru=en, 17 шт); `error.code` не локализуется

## Из таска 02 (ремонт) — insecure-плашка

- `pages.mjs`: `isInsecurePage(req, publicUrl)` → boolean (loopback — всегда false; схема из ENOT_PUBLIC_URL → x-forwarded-proto → прямой http сокета); `downloadsHtml(items, version, locale, insecure=false)`, `inviteHtml(version, locale, insecure=false)`; ключ `server.insecureBanner` (ru=en)

## Из таска 04 (ремонт) — установщик

- флаги `--no-turn`, `--no-tls`, `--reset-turn`; guard setup_turn: ENOTDESK_MANAGED-конфиг → только обновление env-кредов (без apt); чужой/внешний TURN (ENOT_TURN_URLS в env без managed-конфига) не трогается; ENOT_TURN_SECRET/USERNAME — через окружение, не argv; ufw: 80/tcp, 443/tcp+udp, 3478, relay-диапазон

## Из таска 07 — агент

- `client/lib/agent.mjs`: `createAgent({api, signal, native, policy})` → `{start({code}), stop(), status()}`; status: {running, state: idle|registering|waiting|connecting|online|backoff|revoked|error|stopped, machineId, hasToken, session, attempt, backoffMs, native}
- `createAgentApi({baseUrl, fetchImpl})` → `register({code,name,os,version})/session(token)/heartbeat(token)/decision({sessionId,token,claimId,allow})`
- policy: {name, os, version, heartbeatMs=5000, backoffBaseMs=1000, backoffMaxMs=30000, tokenStore{load,save,clear}, log, onBackoff(ms,attempt)}
- main: `EDESK_AGENT=1` — без окна, отдельный userData-профиль, токен в `userData/agent/agent-token.json` (0600)

## Из таска 08 — службы агента

- `client/agent-service/`: windows.md+bat (sc.exe, AppEnvironment REG_MULTI_SZ), linux.md+unit (NoNewPrivileges/ProtectSystem=strict/ReadWritePaths=/var/lib/enotdesk-agent)+install/remove.sh, macos.md+LaunchDaemon plist+install/remove.sh
- env службы: `EDESK_AGENT=1`, `EDESK_AGENT_NAME`; `EDESK_AGENT_CODE` — только на первую регистрацию, в конфиге службы не хранится
- честные ограничения: логи службы Windows в v1 отсутствуют (нет stdout у службы); macOS TCC для LaunchDaemon без MDM ограничен; session 0 — MANUAL-QA

## Из таска 09 — релизы и updater

- `.github/workflows/release.yml`: тег `v*` → matrix 3 ОС → pack → артефакты + checksums-sha256.txt → GitHub Release; блок секретов подписи закомментирован; версия артефактов синхронизируется с тегом (npm version в раннере)
- `client/lib/updater.mjs`: `UPDATE_REPO{owner,repo}`, `updateFeedUrl(repo?)`, `platformFeedName(platform?)` → latest-mac.yml|latest.yml|latest-linux.yml, `updateDecision({current, feedText})` → {update, version, files}
- IPC `enot:update` {version, auto} → preload `enot.onUpdate(cb)`; updater выключен в dev/SMOKE/агенте; electron-updater 6.8.9 exact
- Windows portable .exe не умеет самообновление — только уведомление (честно в README/релизе).

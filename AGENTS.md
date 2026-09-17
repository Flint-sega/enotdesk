<!-- autopilot:start -->
# EnotDesk

Portable remote support, self-hosted, AGPL-3.0: клиент помощи запускается без установки (Windows/macOS/Linux), передаёт одноразовые ID/пароль оператору через обычный чат, закрытие окна мгновенно завершает доступ. Оригинальное Electron+WebRTC-приложение, не форк RustDesk (ADR 0001).

## Current state
Рабочий MVP OSS-волны: attended-сеансы (ID/пароль → согласие клиента → видео WebRTC + ввод/чат/буфер/файлы по DataChannel), unattended-машины (onboarding-код → агент-служба, claim оператора с обязательной причиной и PIN-политикой, проверяемой сервером), браузерный оператор `/operator` без установки клиента, i18n ru/en на клиенте и серверных страницах. Инфраструктура: docker-стек (сервер+coturn+Caddy, авто-HTTPS по `DOMAIN`), релизы GitHub Releases из тега `v*` (3 ОС + checksums + фид latest*.yml), автообновление клиента (проверка раз в сутки; Windows portable — только уведомление). Сервер: RBAC admin/operator/auditor, приглашения, адресная книга, история+аудит, per-login брутфорс-лимит, потолок живых сеансов (ENOT_MAX_SESSIONS), ретенция БД, бэкап VACUUM INTO, insecure-плашка без TLS. Клиент: таймер/качество/непрочитанный чат, drag&drop файлов, CSV-экспорт, один экземпляр. НЕ проверено на живых машинах (ручная приёмка — docs/MANUAL-QA.md): реальная инъекция ввода, видео/чат/файлы между машинами, службы агента на 3 ОС, браузерный оператор в живом Chrome, Win/Linux-сборки; session 0 Windows (служба не видит консольный рабочий стол) и Wayland-управление — осознанные ограничения v1.

## Commands
- `npm install` — deps; node>=24.12; рантайм-зависимости только `ws`, `koffi`, `electron-updater` (точные пины).
- `npm test` — node:test, 198 тестов, сервер+клиент, Electron не нужен (проверено фактически: 198/198 pass).
- `npm run lint` — ESLint по репозиторию (проверено фактически: чисто).
- `npm run smoke:local` — полный локальный цикл: bootstrap → login → invite/accept → session → claim → consent → WS relay → end (проверено фактически: PASS).
- `npm run server` — сервер на `127.0.0.1:8080`, БД = `ENOT_DB` или `enotdesk.db`; `GET /api/v1/health` → `{ok,version,activeSessions,uptimeSec}` (проверено), страницы `/downloads` (200) и `/operator` (401 анониму) на месте.
- `npm run bootstrap` — интерактивное создание первого админа (перезапись существующего отказана).
- `npm start` — Electron-клиент; смоук-прогон: `EDESK_SMOKE=1 npx electron@44.3.0 client/main.mjs --no-sandbox`; второй экземпляр для двух ролей на одной машине — `EDESK_ALLOW_MULTI=1`.
- `node server/backup.mjs <dbPath> <backupDir> [keep]` — бэкап `VACUUM INTO` с ретенцией свежих дампов (проверено).
- `npm run pack:mac` / `pack:win` / `pack:linux` — electron-builder из `build/electron-builder.yml`, артефакты `dist/EnotDesk-*` (macOS arm64 проверена; Win portable exe / Linux AppImage не прогонялись).
- `cd docker && docker compose up -d` — стек сервер+coturn+caddy (`compose.yaml` в корне, гайд `docker/README.md`; в `.env` обязателен `TURN_SECRET`, без него интерполяция падает; здесь не прогонялся).
- `ENOT_BASE_URL=… ENOT_ADMIN_LOGIN=… ENOT_ADMIN_PASSWORD=… node scripts/smoke-remote.mjs` — внешний цикл против развёрнутого сервера.
- `npm run icons` (`scripts/make-icons.mjs`) — `icon.png/.icns/.ico` из `assets/icon-source.png`; только macOS (sips/iconutil), иначе честно падает; `npx electron@44.3.0 scripts/make-mascot.mjs` — кропы маскотов из эталонов.

## Structure
```
server/            app.mjs (REST /api/v1 + WS /signal + страницы/статика/файлы), machines.mjs, pages.mjs, db.mjs (schema_version=2, ретенция), crypto.mjs, backup.mjs, bootstrap.mjs, main.mjs (CLI+env), test/ (13 файлов)
client/            main.mjs (окно, токены, WS, ворота ввода, агент-режим, updater, single instance), preload.cjs (мост window.enot)
client/lib/        agent, api, chat, clipboard-sync, credentials, csv, file-transfer, i18n, input-pipeline, invites, keymap, media-toggle, native-input, protocol, rtc-stats, server-url, signal, updater, version-check (.mjs, без Electron)
client/locales/    ru.json, en.json (~210 плоских ключей, паритет проверяет тест)
client/renderer/   app.js (точка сборки, роутер сигналов), dom.js, state.js, operator-input.js, session-media.js, session-services.js, settings.js, index.html, styles.css, views/{client-view,operator-view,contacts,team,history}.js
client/agent-service/  службы агента 3 ОС + install/remove: windows.md+windows-{install,remove}.bat (sc.exe), linux.md+enotdesk-agent.service+{install,remove}-linux.sh, macos.md+com.enotdesk.agent.plist+{install,remove}-macos.sh
client/test/       node:test lib-шимов + renderer-contract + web-operator + i18n-паритет (20 файлов)
web/               operator.html, operator.mjs, input-source.mjs — браузерный оператор `/operator`
docker/            README.md, enotdesk/entrypoint.sh (вычисляет TURN-креденшелы из TURN_SECRET), caddy/entrypoint.sh; Dockerfile и compose.yaml — в корне репозитория
scripts/           deploy-server.sh, install-server.sh (--update/--no-turn/--no-tls/--reset-turn/--open-firewall/--dry-run/--uninstall/--purge-data), smoke-local.mjs, smoke-remote.mjs, make-icons.mjs, make-mascot.mjs
docs/              SESSION_PROTOCOL.md, SERVER.md, BUILD.md, AGENT.md, WEB-OPERATOR.md, MANUAL-QA.md, adr/0001-0014
assets/ build/     маскоты/иконки; electron-builder.yml + README
.github/           workflows/test.yml (3 ОС: ubuntu — блокирующий lint+test+smoke+audit, win/mac — advisory), workflows/release.yml (тег v* → 3 сборки + checksums-sha256.txt + GitHub Release + фид latest*.yml), dependabot.yml (npm+actions, weekly)
archive/mockup/    старый корневой макет, не приложение
```

## Key files
- `server/app.mjs` — `createServer({dbPath,host,port,leaseMs,heartbeatMs,graceMs,retentionDays,maxSessions,limits,distDir,publicUrl,turn*}) -> {server,db,start,close}`; все маршруты /api/v1, WS /signal, страницы, allowlist-статика `OPERATOR_ASSETS`, отдача сборок с ETag/Range.
- `server/machines.mjs` — `createMachinesStore(db)`: onboarding-коды (в БД только хеши), регистрация код→токен, revoke/delete, PIN-хеши, `machineByToken`, `touch` (online-окно 60с).
- `server/pages.mjs` — HTML `/downloads` и `/invite`, `/operator` (подстановка в `web/operator.html`), CSP-заголовки, `isInsecurePage` (loopback без плашки).
- `server/backup.mjs` — `backupDb(dbPath, dir, {keep})` через `VACUUM INTO` + CLI-обёртка.
- `client/lib/agent.mjs` — `createAgent({api,signal,native,policy})`: регистрация → токен (tokenStore) → WS host-роль → auto-allow claim → переподключение с экспоненциальным backoff; статусы idle|registering|waiting|connecting|online|backoff|revoked|error.
- `client/lib/i18n.mjs` — `t(key,vars,loc)`, `pickLocale(acceptLanguage)`, `initLocale`; общий модуль рендерера и сервера (без DOM/fs); словари `client/locales/{ru,en}.json`.
- `client/lib/keymap.mjs` — `keyFromCode(e.code)`: физические коды клавиш → ключи протокола (раскладка не важна), неизвестное → null.
- `client/lib/updater.mjs` — `UPDATE_REPO`, `updateFeedUrl`, `platformFeedName` (latest-mac.yml|latest.yml|latest-linux.yml), `updateDecision({current,feedText})`; в main включается только в упакованном приложении (не в dev/SMOKE/агенте).
- `web/input-source.mjs` — `wireBrowserInput(video, send, {keys}) → {detach()}`: pointer/wheel/keyboard DOM-события → allowlist-события протокола; решение о вводе остаётся на хосте.
- `client/lib/protocol.mjs` — `INPUT_KEYS` (единый allowlist клавиш), `validateInputEvent`, `createInputGate`; `input-pipeline.mjs` — parse→validate→gate→dispatch; `native-input.mjs` — ленивые koffi-адаптеры (macOS CoreGraphics / Win SendInput / X11 XTest), отказ → inert-режим с честным статусом.
- `client/main.mjs` — агент-режим `EDESK_AGENT=1` (без окна/IPC, профиль `userData/agent`, токен 0600), single-instance замок, `startUpdater()`.
- `build/electron-builder.yml` — `directories.output: dist`; files = `client/**` без `test/` + рантайм-ассеты + `package.json`; `asarUnpack: koffi`; mac zip / win portable / linux AppImage; `electronLanguages: [ru,en]`.

## Architecture
Attended: клиент `POST /api/v1/sessions` (без auth, rate-limit, ≤3 waiting на IP) → sessionId (9 цифр) + password + hostToken; lease 20с, host продлевает WS-heartbeat'ом каждые 5с; оператор `claim` (Bearer admin|operator) → host получает `claim` → `decision allow` → оба получают `approved`; оба подключают WS `/signal` (один сокет на участника, дубликат отклоняется), сервер релеит только offer/answer/ICE (host — оферер). Unattended: админ создаёт машину (`POST /machines` → одноразовый onboarding-код), агент обменивает код на токен (`POST /agent/register`) и живёт heartbeat'ом; оператор `POST /machines/:id/claim` с причиной (обязательна) и PIN (если задан) — политику проверяет сервер, согласие человека не нужно, агент авто-allow; audit пишет machine.claim/.deny (actorId=id машины, unattended=true); `GET /agent/session` отдаёт агенту его сеанс. Видео — WebRTC (TURN из `/rtc-config` ← `ENOT_TURN_*`), ввод и сервисы — DataChannel-каналы `input`/`chat`/`clip`/`file` (ADR 0014), релей сервера не расширяется. Обрыв WS в approved даёт грейс `graceMs` (ENOT_GRACE_MS, 30с; 0=fail-closed) на переподключение теми же токенами с replay `approved`; до согласия — мгновенный fail-closed (ADR 0013). Решение о вводе принимает main хоста по реальному WS-состоянию (`gate.isOpen()`) → input-pipeline → koffi; заявлениям рендерера и браузера не доверять. Браузерный оператор `/operator`: страница без данных, роль по cookie `enot_op` (навигация не шлёт Authorization), каждый /api и WS всё равно за RBAC; auditor — 403; CSP `script-src 'self'`; статика только по allowlist; ввод через `web/input-source.mjs` тем же протоколом. RBAC admin/operator/auditor проверяется на каждом запросе; last active admin защищён; /audit — admin+auditor; audit+history — append-only таблицы (актор хоста — actorId=null, detail.host=true). Ретенция (раз в час): истёкшие токены >7д, завершённые приглашения >30д, сеансы старше `ENOT_RETENTION_DAYS` (90; 0=вечно); рестарт сервера инвалидирует живые регистрации; бэкап — `VACUUM INTO` без остановки.

## Conventions
Server pure ESM `.mjs`, node:sqlite (experimental warning — норма), без фреймворков: рантайм только `ws`+`koffi`+`electron-updater`; electron 44.3.0, koffi 3.2.1, electron-updater 6.8.9, ws 8.21.3 — точные пины, не бампать. Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; рендерер только через мост `window.enot`. Всё входящее — allowlist и лимиты (INPUT_KEYS, SDP-размеры, OPERATOR_ASSETS, имена сборок `EnotDesk*.exe|zip|AppImage`); недоступная платформа честно сообщает статус (`native-unavailable`, `wayland-unsupported-control`), никогда не фейкует успех. Пользовательские тексты — русские (отказные тексты машинных маршрутов и интерфейс — через словари i18n, ключи ru=en, паритет проверяет контракт-тест; `error.code` не локализуется). Токены/пароли/коды в БД только хешами; токены не утекают в renderer. Лицензия AGPL-3.0 (`LICENSE`); README.md (en, точка входа) ↔ README.ru.md (полный).

## Environment
`ENOT_HOST`, `ENOT_PORT`, `ENOT_DB`, `ENOT_DIST_DIR`, `ENOT_PUBLIC_URL`, `ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD`, `ENOT_GRACE_MS`, `ENOT_RETENTION_DAYS`, `ENOT_MAX_SESSIONS`; compose: `DOMAIN`, `TURN_SECRET` (обязателен; внутрь контейнера — `ENOT_TURN_SECRET`), `TURN_USERNAME`; деплой: `ENOT_DEPLOY_HOST/USER/PORT/PASSWORD/PROTO`, `ENOT_ADMIN_LOGIN/PASSWORD`; клиент: `EDESK_SMOKE`, `EDESK_SMOKE_PATH`, `EDESK_ALLOW_MULTI` (тестовый обход single-instance), `EDESK_AGENT=1` (headless-агент), `EDESK_AGENT_NAME`, `EDESK_AGENT_CODE` (только первая регистрация, в конфиге службы не хранить) — значения никогда не коммитятся (шаблон `.env.example`).

## Tests
`npm test` = `node --test server/test/*.test.mjs client/test/*.test.mjs` — 198 тестов (серверные HTTP/WS + lib-шимы + renderer-contract с анти-мёртвыми-кнопками + i18n-паритет + machines/agent/updater/web-operator/retention/backup), фактически зелёные. Один файл: `node --test server/test/lifecycle.test.mjs` (аналогично client/test/agent.test.mjs). `smoke:local` — контрольный цикл на временной БД в эфемерном порту; `smoke-remote.mjs` — внешний цикл против живого сервера. НЕ покрыто автотестами (ручная приёмка docs/MANUAL-QA.md): реальная инъекция ввода, WebRTC видео/чат/файлы между машинами, службы агента на живых ОС, браузерный оператор в живом Chrome, Win/X11 адаптеры, session 0 — докладывать честно, не выдумывать.

## Pitfalls
koffi 3.x: `lib.func(...)` с полными C-сигнатурами; адаптеры грузятся лениво, любая ошибка загрузки → inert, никогда не throw; `asarUnpack: node_modules/koffi/**` в electron-builder.yml обязателен. i18n: ключи ru=en обязаны совпадать (контракт-тест); `server/app.mjs` и `pages.mjs` импортируют `../client/lib/i18n.mjs` — деплой-тарбалл (deploy-server.sh: server+assets+`client/lib/i18n.mjs`+`client/locales`) и Dockerfile явно копируют словарь и локали, не потерять при переносе. Single instance: второй экземпляр молча уходит, `EDESK_ALLOW_MULTI=1` — тестовый обход; агент живёт в отдельном userData-профиле со своим замком и работает рядом с обычным клиентом. compose без `TURN_SECRET` падает на интерполяции (`${TURN_SECRET:?}`); `TURN_USERNAME` ≤ 2147483647 (coturn читает как 32-бит). Windows portable .exe не умеет самообновление — только уведомление; Win-служба в session 0 не видит консольный рабочий стол (осознанное ограничение v1). `npm run icons` — только macOS; `make-mascot.mjs` требует эталоны `.autopilot/enotdesk-redesign/reference/{app,site}.png` и Electron. Input decision — только в main по `gate.isOpen()`, не верить рендереру. `archive/mockup/` — макет, не приложение. NodeSource/apt на серверах ненадёжен — Node ставится tarball-ом nodejs.org с SHA256 (install-server.sh).

## Autopilot
Runs tracked in `.autopilot/enotdesk/` and `.autopilot/enotdesk-redesign/` (текущий редизайн), live state in `.autopilot/state.js`. User requirements may not be silently deferred. Code changes delegated to executors. No deployment/publication or secret collection. Tests and actual startup required; native platform availability must be reported honestly.
<!-- autopilot:end -->

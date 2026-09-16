<!-- autopilot:start -->
# EnotDesk

Portable remote support for Windows, macOS and Linux. Client runs only for an attended support session, communicates temporary ID/password through the user's existing chat, and closing terminates remote access. Dark technological branding, strong professional raccoon wearing glasses. Team roles, shared address book, invitations and audit are first-release requirements.

## Current state
Working MVP после двух волн правок по код-ревью: Node server (control plane + WS signaling) и Electron-клиент с реальным нативным вводом на macOS; Win/X11 адаптеры, видео между машинами и Win/Linux-сборки по-прежнему не проверены на живых машинах. Функции: клавиатура по физическим кодам (любая раскладка), скролл в строках, грейс-период переподключения 30с (ADR 0013), в сессии — чат, буфер обмена и передача файлов поверх DataChannel (ADR 0014), видео-UX (fullscreen, fit, 2,5 Мбит/с, смена экрана replaceTrack, пауза трансляции у клиента). Сервер: per-login брутфорс-лимит, смена пароля, потолок живых сеансов (ENOT_MAX_SESSIONS), ETag/304 у сборок, ретенция БД, бэкап (server/backup.mjs, --backup), защитные заголовки, HEAD, /audit — admin+auditor, потолок waiting-сессий на IP. Клиент: один экземпляр (EDESK_ALLOW_MULTI=1 — тестовый обход), баннер новой версии, таймер/качество/непрочитанный чат, drag&drop файлов, CSV-экспорт. Код: ESLint (npm run lint), CI (lint+test+smoke+audit, dependabot), renderer разбит на модули. Репозиторий: `client/`, `server/`, `build/`, `assets/`, `scripts/`, `docs/`, `archive/mockup/` — старый макет, не приложение.

## Commands
- `npm install` — deps (node>=24.12; koffi, ws exact-pinned; electron, electron-builder, eslint dev).
- `npm test` — node:test, 134 tests, server+client, no Electron needed (проверено фактически: 134/134 pass).
- `npm run lint` — ESLint, чисто (проверено фактически).
- `npm run server` — server on `127.0.0.1:8080`; `GET /api/v1/health` → `{ok:true, version, activeSessions, uptimeSec}`.
- `npm run bootstrap` — interactive CLI creating first admin (refuses to overwrite existing); DB = `ENOT_DB` or `enotdesk.db`.
- `npm start` — Electron client (`EDESK_SMOKE=1 npx electron@44.3.0 client/main.mjs --no-sandbox` for smoke run; второй экземпляр для двух ролей на одной машине — `EDESK_ALLOW_MULTI=1`).
- `npm run smoke:local` — full local cycle: bootstrap → login → invite/accept → session → claim → consent → WS relay offer/answer → end (проверено фактически: PASS).
- `npm run pack:mac` / `pack:win` / `pack:linux` — electron-builder с `build/electron-builder.yml`, артефакты в `dist/` (macOS arm64 проверена, zip на месте; Win/Linux конфиг готов, не прогонялись).
- `npx electron@44.3.0 scripts/make-mascot.mjs` — кропы `mascot-app.png`, `mascot-site.png`, `icon-source.png` из эталонов `.autopilot/enotdesk-redesign/reference/{app,site}.png` (Electron nativeImage, без зависимостей; координаты подобраны вручную).
- `npm run icons` (`scripts/make-icons.mjs`) — `icon.png`/`icon.icns`/`icon.ico` из `assets/icon-source.png`; только macOS (sips/iconutil), на других ОС честно падает.

## Structure
```
server/          control plane: app.mjs (HTTP /api/v1 + WS /signal + файлы), pages.mjs (страницы /downloads, /invite), db.mjs (node:sqlite, ретенция), crypto.mjs (scrypt, tokens), backup.mjs (VACUUM INTO), bootstrap.mjs, test/
client/          Electron: main.mjs (window, tokens, WS, input wiring, single instance), preload.cjs (window.enot bridge)
client/lib/      Electron-free shims: api.mjs, signal.mjs, protocol.mjs, input-pipeline.mjs, native-input.mjs, keymap.mjs (e.code→ключ), chat.mjs, clipboard-sync.mjs, file-transfer.mjs, version-check.mjs, media-toggle.mjs, rtc-stats.mjs, csv.mjs, credentials.mjs, invites.mjs, server-url.mjs
client/renderer/ UI: app.js (точка сборки, роутер сигналов), dom.js, state.js, operator-input.js, session-media.js, session-services.js, settings.js, views/{client-view,operator-view,contacts,team,history}.js
client/test/     node:test для lib-шимов + renderer-contract (все id + анти-мёртвые-кнопки)
assets/          enot-mascot.svg, enot-icon.svg, mascot-app.png, mascot-site.png, icon-source.png, icon.png (+.icns/.ico), README.md
build/           electron-builder.yml + README.md
scripts/         deploy-server.sh, install-server.sh (--backup), smoke-local.mjs, smoke-remote.mjs, make-icons.mjs, make-mascot.mjs
docs/            SESSION_PROTOCOL.md, SERVER.md, BUILD.md, screenshot-main.png, adr/ (0001-0014)
.github/         workflows/test.yml — CI: lint + npm test + smoke:local + npm audit; dependabot.yml
archive/mockup/  старый корневой макет (не приложение) + README
```

## Key files
- `server/app.mjs` — `createServer({dbPath,host,port,leaseMs,heartbeatMs,limits,distDir}) -> {start,close}`; sole service entry, prod and tests use it; страницы `/downloads` и `/invite`, бренд-статика `/brand/:name`, файлы сборок `/downloads-files/:name` (Content-Length, Range → 206/416).
- `server/main.mjs` — CLI wrapper: `bootstrap` arg or server start from `ENOT_*` env (включая `ENOT_DIST_DIR`).
- `client/main.mjs` — main process: owns authToken/hostToken, WS client, input gate, `desktopCapturer`; renderer sees only `window.enot`; версия в `getSettings()`: `app.isPackaged ? app.getVersion() : pkg.version` (D02).
- `client/lib/input-pipeline.mjs` — `createInputPipeline({gate,nativeInput}).handle(evOrRawString,bounds)`: parse → validate → gate → dispatch; single wiring used by main and tests.
- `client/lib/native-input.mjs` — lazy koffi adapters: macOS CoreGraphics / Win SendInput / X11 XTest; missing koffi/OS API → inert adapter with honest status; Wayland → `wayland-unsupported-control`.
- `client/lib/protocol.mjs` — `INPUT_KEYS` Set is the single allowlist of keys (renderer gets it via `permissions().inputKeys`); also `validateInputEvent`, `validateOutgoingSignal`, `createInputGate`.
- `build/electron-builder.yml` — `directories.output: dist`; `files` = `client/**` (без `test/`) + рантайм-ассеты (`enot-*.svg`, `mascot-app.png`) + `package.json`; `asarUnpack: koffi`; `compression: maximum`; `electronLanguages: [ru,en]`; иконки `assets/icon.*`.
- `assets/mascot-app.png` (690×780) — hero рендерера `../../assets/mascot-app.png`; `assets/mascot-site.png` (736×372) — сервер `/brand/mascot-site.png` (allowlist); в растры запечены бабл и подпись — не дублировать в HTML (D01); `assets/icon-source.png` — источник иконки (`npm run icons`).

## Architecture
Client `POST /sessions` (unauthenticated, rate-limited, ≤3 waiting per IP) → gets `sessionId` (9 digits) + `password` + `hostToken`; lease starts immediately, host refreshes via WS `heartbeat` every 5s, timeout 20s. Operator `claim` (bearer admin/operator) → host gets `claim` → host `decision allow` → both get `approved`; both connect WS `/signal`, one socket per participant, duplicate rejected. Server relays only offer/answer/ICE (host is offerer) between approved participants; video over WebRTC, input over DataChannel → input-pipeline → koffi native dispatch. В approved обрыв WS не рвёт сеанс сразу: `graceMs` (ENOT_GRACE_MS, 30с; 0=fail-closed) на переподключение теми же токенами, до согласия — мгновенный fail-closed (ADR 0013). Session services — отдельные DC-каналы `chat`/`clip`/`file` (лимиты и «Принять» у клиента для файлов; ADR 0014), релей сервера не расширяется. RBAC: admin/operator/auditor, checked per-request; auditor read-only; last active admin protected; /audit — admin+auditor. Audit + history are append-only server tables (актор хоста — actorId=null, detail.host=true). Ретенция: истёкшие токены >7д, завершённые приглашения >30д, завершённые сеансы >`ENOT_RETENTION_DAYS` (90; 0=вечно). Версия в футере — только фактическая (`getSettings().version`), без выдуманных чисел.

## Развёртывание
- `scripts/deploy-server.sh` (локально): tarball `server/`+`package*.json`+`install-server.sh` → scp в `/tmp/enotdesk-install/` → установщик на сервере под nohup (лог `install.log`, rc-маркер, poll до 10 мин) → health изнутри и снаружи; env `ENOT_DEPLOY_HOST` (обязателен), `ENOT_DEPLOY_USER` (root), `ENOT_DEPLOY_PASSWORD` (пусто = SSH-ключ; задан = нужен sshpass), `ENOT_DEPLOY_PORT` (22), `ENOT_PORT` (8080), `ENOT_DEPLOY_PROTO` (http) — см. `.env.example`.
- `scripts/install-server.sh` (на сервере, root, Debian/Ubuntu): флаги `--dry-run`, `--update <tar>`, `--uninstall`, `--purge-data`, `--open-firewall`, `--help`; релизы `/opt/enotdesk/releases/<UTC>-<sha12>`, symlink `/opt/enotdesk/current`, env `/etc/enotdesk/enotdesk.env` (0600), БД `/var/lib/enotdesk/enotdesk.db`, unit `/etc/systemd/system/enotdesk.service`, пользователь `enotdesk` (system, nologin); Node 24 — официальный tarball nodejs.org (`NODE_VERSION` 24.12.0, SHA256, `/opt/node-24`), apt/NodeSource не используются (D01).
- `ENOT_DIST_DIR` — каталог сборок для `/downloads`: установщик пишет его в env-файл (дефолт `/var/lib/enotdesk/dist`), существующее значение сохраняется при `--update`.
- Внешняя проверка: `ENOT_BASE_URL=... ENOT_ADMIN_LOGIN=... ENOT_ADMIN_PASSWORD=... node scripts/smoke-remote.mjs` — полный цикл против живого сервера.
- `docs/SERVER.md` — установка/управление/обновление/бэкап/TLS/bootstrap/диагностика; `docs/BUILD.md` — сборки клиента и фактические замеры веса/старта (macOS проверена, Win/Linux не прогонялись).

## Conventions
Server is pure ESM `.mjs`, node:sqlite (experimental warning is normal), no frameworks — only `ws` + `koffi`. Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; renderer talks only via preload bridge `window.enot`. Keys/buttons/scroll/SDP sizes are allowlisted and bounded (protocol.mjs); file serving from `ENOT_DIST_DIR` is name-allowlisted, traversal rejected. Unavailable platform features report honest status (`native-unavailable`, `wayland-unsupported-control`), never fake success. Russian user-facing messages; frozen API contracts live in `.autopilot/enotdesk-redesign/interfaces.md`.

## Environment
`ENOT_HOST`, `ENOT_PORT`, `ENOT_DB`, `ENOT_DIST_DIR`, `ENOT_PUBLIC_URL`, `ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD`, `ENOT_GRACE_MS`, `ENOT_RETENTION_DAYS`, `ENOT_MAX_SESSIONS` (see `.env.example`) — never commit values; деплой также читает `ENOT_DEPLOY_HOST/USER/PORT/PASSWORD/PROTO` и `ENOT_ADMIN_LOGIN/PASSWORD`; desktop also reads `EDESK_SMOKE=1` и тестовый `EDESK_ALLOW_MULTI=1` (второй экземпляр для двух ролей на одной машине).

## Tests
`node --test server/test/*.test.mjs client/test/*.test.mjs` — 134 теста (server HTTP/WS + client lib-шимы + renderer-contract с анти-мёртвыми-кнопками + ретенция/бэкап), фактически зелёные; single file: `node --test server/test/lifecycle.test.mjs`. `npm run lint` — ESLint, чисто. `smoke:local` covers the whole control-plane + signaling cycle on a temp DB in ephemeral port. `node scripts/smoke-remote.mjs` — внешний цикл (HTTP+WS) против развёрнутого сервера, деактивирует временного оператора. NOT covered (ручная приёмка на двух живых машинах): реальная инъекция ввода (скролл/клавиатура incl. чёрный кадр паузы), WebRTC video/chat/files между машинами, индикатор качества, Win/X11 адаптеры (инертные), single-instance поведение, Electron UI beyond screenshot smoke — report honestly, don't fake.

## Pitfalls
koffi 3.x: `lib.func(...)` with full C signature strings; adapters load lazily, any load failure must fall back to inert, never throw. `npm run icons` uses sips/iconutil — macOS only, exits on other OS; `make-mascot.mjs` требует эталоны `.autopilot/enotdesk-redesign/reference/{app,site}.png` и Electron. `.autopilot/` is committed (except graphify-out/, which is gitignored). `archive/mockup/` (index.html/app.js/styles.css) — archived mockup, do not mistake for the app. electron 44.3.0 and koffi 3.2.1 are exact-pinned — do not bump casually; `asarUnpack` for koffi is required in builds. Input decision belongs to main via WS-state gate (`gate.isOpen()`), never trust renderer claims. NodeSource/apt на некоторых серверах зависает — Node ставится tarball-ом nodejs.org с SHA256. `deploy-server.sh` создаёт и удаляет `deploy.env` (0600) сам, значения `ENOT_*` не попадают в argv ssh/bash. ufw открывается только с `--open-firewall` и только если он активен, иначе установщик честно сообщает.

## Autopilot
Runs tracked in `.autopilot/enotdesk/` and `.autopilot/enotdesk-redesign/` (текущий редизайн), live state in `.autopilot/state.js`. User requirements may not be silently deferred. Code changes delegated to executors. No deployment/publication or secret collection. Tests and actual startup required; native platform availability must be reported honestly.
<!-- autopilot:end -->

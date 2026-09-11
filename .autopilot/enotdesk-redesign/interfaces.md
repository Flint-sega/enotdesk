# Границы и контракты (редизайн)

## Общие правила проекта

- Стек без изменений: Node 24 ESM, Electron 44.3.0 (dev), ws 8.21.3, koffi 3.2.1, electron-builder 26.15.3 — точные пины; новых зависимостей не добавлять.
- Тесты: `npm test` (server+client вместе), один файл — `node --test <путь>`.
- Не трогать: `.autopilot/`, `server/` (кроме страниц, таск 04), `assets/enot-*.svg`.
- Секретов нет; значения — только в `.env`.
- Коммит — оркестратор, после ревью.
- Если не хватает зависимости — `BLOCKED`, не устанавливать.

## Целевая структура (R07)

```
archive/mockup/   index.html, styles.css, app.js (старый корневой макет) + README
assets/           enot-mascot.svg, enot-icon.svg, mascot-app.png, mascot-site.png,
                  icon-source.png, icon.png, icon.icns, icon.ico, README.md
build/            electron-builder.yml, README.md
client/           main.mjs, preload.cjs, lib/, renderer/, test/
server/           без изменения путей
scripts/          deploy-server.sh, install-server.sh, smoke-local.mjs,
                  smoke-remote.mjs, make-icons.mjs, make-mascot.mjs
docs/             SERVER.md, BUILD.md, adr/, screenshot-main.png
BRAND.md, README.md, AGENTS.md, CLAUDE.md, package.json — в корне
dist/             выход сборки (корень, как есть)
```

## Контракты ассетов (таск 02 → 03/04)

- `assets/mascot-app.png` — маскот из `reference/app.png` (hero приложения).
- `assets/mascot-site.png` — маскот из `reference/site.png` (hero сайта).
- `assets/icon-source.png` — квадратный кроп головы/плеч маскота (источник иконки).
- `assets/icon.png` (1024), `assets/icon.icns`, `assets/icon.ico` — из icon-source.
- Renderer: `../../assets/mascot-app.png` (как сейчас для svg).
- Server: `/brand/mascot-site.png` — расширить allowlist `/brand/:name` маскотами.

## Контракты приложения (таск 03)

- `window.enot.getSettings() -> { serverUrl, firstRun, allowInsecureHttp, version }`, `version = app.getVersion()`.
- Все существующие id и классы renderer сохраняются (список в `client/renderer/app.js`).
- Ленивая загрузка koffi: `permissions()` не должен форсировать загрузку нативного ввода; загрузка при первом использовании в host-сеансе; статус остаётся честным.

## Контракты сервера (таск 04)

- `GET /` → 302 `/downloads`; `/downloads` и `/invite` — новые страницы; `/brand/:name` allowlist + маскоты.
- `GET /api/v1/downloads-files/:name`: поток, `Content-Length`, поддержка `Range` → 206 (иначе 200); allowlist имён без изменений.
- Версия в футере — `cfg.version` (фактическая).

## Контракты сборки (таск 05)

- `build/electron-builder.yml` — `directories.output: dist`, `files` = client+ассеты+package.json, `asarUnpack` koffi, `compression: maximum`, `electronLanguages: [ru, en]`, иконки из assets.
- `pack:*` вызывают `electron-builder --config build/electron-builder.yml --<os>`.
- Замеры: размер zip до/после, время старта до окна (лог в EDESK_SMOKE, синхронный timestamp).

## Реализовано в ране

### Из таска 03 — приложение (готово, ждёт ремонта версии)
- `getSettings() -> {serverUrl, firstRun, allowInsecureHttp, version}`; footer по `s.version`.
- `client/lib/native-input.mjs`: ленивый адаптер (`loadPlatformAdapter`), загрузка на первом host-сеансе; `permissions()` не грузит; тесты `renderer-contract.test.mjs` (ids/CSP/version), `native-input.test.mjs` +2.
- CSP без inline; все id/классы сохранены; «Оператор» — кнопка-иконка.

### Из таска 04 — сайт (готово)
- `server/app.mjs`: единый `BASE_STYLE`, страницы `/downloads`, `/invite` по эталону; `BRAND_FILES` + `mascot-site.png`, `mascot-app.png`.
- `GET /api/v1/downloads-files/:name`: `Content-Length`, `Accept-Ranges: bytes`, `parseRange`/`streamOut` → 206/416, без Range 200.
- `server/test/downloads.test.mjs`: 7 тестов HTTP-шва (hero/чипы/шаги/футер, бренд-статика, Range, traversal).

### Из таска 01 — структура (готово)
- `desktop/` → `client/`; `archive/mockup/` (index.html, styles.css, app.js + README); `build/electron-builder.yml` + README; package.json: main/start/test/pack:* обновлены, поле build удалено.
- `npm test` = 76 (server+client); смоук и pack:mac фактически прошли; в README/BUILD остались устаревшие «46 тестов» — таск 05 обновит.

### Из таска 02 — ассеты (готово)
- `assets/mascot-app.png` 690×780 (из app.png), `assets/mascot-site.png` 736×372 (из site.png), `assets/icon-source.png` 340×340, `assets/icon.png` 1024, `icon.icns`, `icon.ico` — из icon-source.
- `scripts/make-mascot.mjs` (кропы, воспроизводимо), `scripts/make-icons.mjs` (из icon-source.png).
- В растры запечены бабл/подпись (D01): HTML-дубликаты не делать.
- BRAND.md: палитра #070D17/#0F1A2C/#1C2C44/#35E0C4/#EAF2FF/#8FA3BF + hero-типографика.

## Что уже построено (прошлые раны)

- Сервер: `/api/v1` + `/signal`, роли/инвайты/аудит/книга, `ENOT_DIST_DIR`, `/downloads`, `/invite`, `/brand/:name` (svg/png), `/downloads-files/:name` (без Range пока).
- Клиент: мост `window.enot`, сигналинг, WebRTC, input-pipeline, настройки, весь UI (тёмная тема), парсер вставки ID/пароля.
- Скрипты: install/deploy/smoke-remote/smoke-local/make-icons.

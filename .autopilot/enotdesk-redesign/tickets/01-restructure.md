# 01 — Переезд проекта по папкам

**Требования:** R07, R04
**Blocked by:** нет
**Зона:** `package.json`, `build/`, `client/`, `archive/`, `README.md`, `AGENTS.md`, `docs/`, `CLAUDE.md`
**Волна:** 1

## Что должно заработать

Проект разложен по папкам: клиент — `client/`, сервер — `server/`, сборка — `build/`, документы — `docs/`, ассеты — `assets/`, скрипты — `scripts/`, старый макет — `archive/mockup/`. Все команды и тесты работают как раньше.

## Критерии приёмки

- [ ] `git mv desktop client`; `client/renderer/index.html` грузится, относительные `../../assets/` не меняются (глубина та же)
- [ ] Корневой макет (`index.html`, `styles.css`, `app.js`) → `archive/mockup/` + `archive/mockup/README.md` («архивный макет, не приложение; приложение — `npm start`»)
- [ ] `build/electron-builder.yml`: конфиг из поля `build` package.json (`directories.output: dist`, `files: ["client/**/*","assets/**/*"]`, `asarUnpack` koffi, иконки, artifactName, mac/win/linux) + `build/README.md`; поле `build` из package.json удалено
- [ ] package.json: `main: client/main.mjs`, `start: electron client/main.mjs`, `test: node --test "server/test/*.test.mjs" "client/test/*.test.mjs"`, `pack:* : electron-builder --config build/electron-builder.yml --<os>`
- [ ] Ссылки `desktop/` обновлены в README.md, AGENTS.md (+CLAUDE.md при наличии), docs/BUILD.md, docs/SERVER.md; grep без `.autopilot`/истории: ни одного `desktop/`
- [ ] `npm test` зелёный; `EDESK_SMOKE=1 npx electron@44.3.0 client/main.mjs --no-sandbox` — окно и смоук OK; `npm run pack:mac` собирает `dist/EnotDesk-mac-arm64.zip`

## Из брифа, дословно

> «весь проект распределяем по папкам всё должно быть упорядочено, и серверная часть отдельно сборка отдельно клиент отдельно документы и т.д»

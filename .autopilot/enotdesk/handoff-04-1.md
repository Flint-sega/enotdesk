# Handoff T04 — финальная интеграция EnotDesk

## СДЕЛАНО
- `koffi@3.2.1` (dependency) и `electron@44.3.0` / `electron-builder@26.15.3` (devDependencies) точными пинами в корневом package.json, `npm install` выполнен, lockfile обновлён. `require('koffi')` на этой macOS работает.
- Ремонт инертности (обязательство из interfaces.md): `desktop/main.mjs` теперь передаёт koffi в `createNativeInput` (createRequire, мягкий fallback в инерт). Исправлен API koffi в `desktop/lib/native-input.mjs`: koffi 3.x не имеет `koffi.func(proto,{library})` — все три адаптера переведены на `lib.func(...)` (macOS/Win/X11). Проверено на macOS: `nativeInput.status()` = `{"available":true,"platform":"macos-coregraphics"}` (только загрузка, без инъекции).
- Скрипты: `start` (Electron desktop), `server`, `bootstrap`, `test` (сервер+desktop одним прогоном), `smoke:local`, `icons`, `pack:mac|win|linux`. Конфиг electron-builder в package.json (build): mac zip, win portable, linux AppImage, EnotDesk productName, appId com.enotdesk.app, koffi в asarUnpack, identity:null (без подписи).
- Скриншот главного окна: `docs/screenshot-main.png` (2240×1456 PNG, снят Electron capturePage в EDESK_SMOKE-режиме). Смоук: окно создано, title EnotDesk, native input non-inert, gate закрыт до approved и открыт после, screen capture status честный `denied` (разрешение ОС не выдавалось).
- Полный локальный цикл проверен фактически: `npm run smoke:local` = bootstrap админа → health → логин админа → invite/accept → логин оператора → сессия (9-значный ID) → host WS ready(waiting) → claim c именем оператора → op ready(pending-consent) → decision по hostToken → approved обеим сторонам → WS relay offer/answer → end с уведомлением. PASS.
- CLI-bootstrap проверен неинтерактивно через пайп stdin (поддерживается самим bootstrap: не-TTY режим): «Готово: первый администратор создан».
- Иконки упаковки сгенерированы `npm run icons` (scripts/make-icons.mjs): assets/icon.icns (iconutil), assets/icon.ico (PNG-in-ICO 256).
- pack:mac собран фактически: `dist/EnotDesk-mac-arm64.zip` (128 МБ). Внутри portable EnotDesk.app: MacOS/EnotDesk, Resources/icon.icns, Info.plist CFBundleName=EnotDesk + icon.icns, koffi в app.asar.unpacked.
- Архивный макет: index.html получил видимую плашку «Архивный макет, не приложение. Настоящее приложение: npm start» (стиль в styles.css); фальшивая генерация ID/пароля в app.js отключена — честный текст вместо демонстрационных credentials.
- README.md переписан честно: сценарий клиента/оператора, быстрый старт, таблица платформ с колонкой «Проверено» (macOS — да; Windows/Linux — конфигурация настроена, не прогонялась), разрешения macOS (Screen Recording/Accessibility, неподписанный артефакт), Wayland-ограничение, koffi, ENOT_* переменные, TURN, «хостинг — позже по решению владельца», лицензия-заготовка. Никаких выдуманных доменов/URL. BRAND.md дополнен разделом «Ассеты» (ссылки на assets/).
- ADR docs/adr/0001-original-electron-webrtc.md: Electron/WebRTC вместо форка RustDesk (process-lifetime identity, командный сервер первого выпуска, AGPLv3-обязательства), SQLite (один процесс, CAS-транзакции, персистентность аудита при рестарте), риски (TURN, размер артефакта, Wayland, неподписанность).
- Ремонт тестов сервера: `server/test/limits.test.mjs` удалял реальный `dist/` (уничтожал собранный артефакт pack:mac) и падал при его наличии. Добавлена изоляция isolateDist: спрятать реальный dist → прогнать → вернуть.
- graphify update . выполнен (320 nodes, 537 edges; ограничение: граф покрывает только исходники, упаковочные артефакты не анализируются).

## ФАЙЛЫ
- package.json, package-lock.json (пины, скрипты, build-конфиг)
- desktop/main.mjs (koffi-проводка, capturePage-скриншот в смоуке), desktop/lib/native-input.mjs (koffi 3.x API: lib.func)
- scripts/smoke-local.mjs (новый), scripts/make-icons.mjs (новый)
- server/test/limits.test.mjs (изоляция dist)
- assets/icon.icns, assets/icon.ico (сгенерированы)
- index.html, styles.css, app.js (архивная плашка, отключены фейк-credentials)
- README.md, BRAND.md, docs/adr/0001-original-electron-webrtc.md, docs/screenshot-main.png
- dist/EnotDesk-mac-arm64.zip (+blockmap, mac-arm64/) — артефакт

## РЕШЕНИЯ
- koffi 3.x: адаптеры переписаны под `lib.func` вместо даунгрейда пакета — API стабильный, пин точный.
- appId `com.enotdesk.app` — технический идентификатор сборки, не заявка на домен (в README домены не упоминаются).
- macOS zip-only (по спеке §8 «.app ZIP»), dmg не делал; win/linux конфигурации валидны, но не собраны (нет машин) — помечено честно в README.
- icon.ico сделан как PNG-in-ICO 256×256 (stdlib+system tools, без новых зависимостей).
- Смоук смоук-последовательность переставлена в производственный порядок (хост подключается до claim) — прежний порядок тестировал вне-контрактный кейс «хост после approval»; в контракте claim шлётся на auth хоста в pending-consent (server/app.mjs:683-686).
- AGENTS.md Current state не обновлял: явный запрет «AGENTS.md не трогать» в постановке противоречит просьбе «обновишь» — запрещено, противоречие передаётся оркестратору.

## ТУПИКИ
- koffi.func отсутствует в 3.x — решено (см. РЕШЕНИЯ).
- Race в смоуке (WS-сообщение приходит раньше resolve fetch) — решено прикреплением слушателей до HTTP-триггера.
- Тест limits удалял dist — решено изоляцией.

## ДАЛЬШЕ
- Человек: проверка реальной инъекции ввода на macOS (Accessibility), реальный захват экрана (Screen Recording), сквозной RTC-видеопоток между двумя машинами.
- Владелец: машины Windows/Linux для фактической сборки/прогона pack:win/pack:linux; решение о подписи/notarization macOS; генерация .ico из полного набора размеров при желании (сейчас 256 PNG-in-ICO); выбор финальной лицензии; хостинг/TURN — позже.
- Оркестратор: обновить Current state в AGENTS.md (макет архивный, приложение = npm start).

## Проверено фактически / не проверено
Проверено: npm install + koffi require; 46/46 тестов (сервер+desktop) зелёные вместе; server стартует (health {ok:true,version:0.1.0}); Electron стартует (окно, title, скриншот); native input adapter non-inert (загрузка); полный серверный цикл smoke:local PASS; CLI-bootstrap через пайп; pack:mac артефакт существует, .app структура/plist/иконка корректны; тесты проходят при существующем артефакте.
Не проверено: реальная инъекция ввода в ОС (по постановке — человеку); реальный захват экрана с разрешением ОС; сквозной видео-поток WebRTC между двумя машинами (relay-сигналинг проверен, медиа — нет); pack:win и pack:linux сборки и запуск на реальных Windows/Linux; подпись/notarization; работа через TURN; поведение в NAT вне loopback.

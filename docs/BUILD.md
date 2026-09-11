# EnotDesk: сборка клиента

Portable-клиент EnotDesk собирается `electron-builder` из корня репозитория. Артефакты складываются в `dist/` и отдаются сервером на странице `/downloads` (только реально собранные файлы).

## Общие требования

- Node.js ≥ 24.12 и npm (проверка: `node -v`).
- `npm ci` из корня репозитория — ставит `electron` 44.3.0 и `electron-builder` 26.15.3 по lockfile.
- Сборка идёт на целевой ОС: macOS-артефакты — на macOS, Windows — на Windows, Linux — на Linux.
- При первой сборке electron-builder скачивает Electron и свои инструменты — нужен интернет.
- Необязательно, но полезно перед сборкой: `npm test` (46 тестов сервера и desktop-швов).
- Иконки уже лежат в `assets/` (`icon.icns`/`icon.ico`/`icon.png`); перегенерировать можно `npm run icons` — скрипт использует macOS-утилиты `sips`/`iconutil` и работает только на macOS.

## Сборка по ОС

| ОС | Команды | Артефакт | Статус |
|---|---|---|---|
| macOS (arm64) | `npm ci && npm run pack:mac` | `dist/EnotDesk-mac-arm64.zip` (внутри portable `EnotDesk.app`) | **Проверено на macOS arm64**: сборка, запуск, смоук-скриншот |
| macOS (Intel) | `npm ci && npm run pack:mac` | `dist/EnotDesk-mac-x64.zip` | Не прогонялось (та же конфигурация) |
| Windows (x64) | `npm ci`, затем `npm run pack:win` | `dist/EnotDesk-win-x64.exe` (portable) | **Не прогонялось — нужна Windows-машина** |
| Linux (x64) | `npm ci && npm run pack:linux` | `dist/EnotDesk-linux-x64.AppImage` | **Не прогонялось — нужна Linux-машина или CI** |

В PowerShell/cmd команды выполняются по одной (разделитель `;` там тоже работает, но `npm ci` должен завершиться успешно до `pack:win`):

```powershell
npm ci
npm run pack:win
```

Linux: инструменты сборки AppImage electron-builder скачивает сам (отдельно ставить их не нужно). Для *запуска* AppImage нужен FUSE: на Ubuntu 24.04 — `sudo apt install libfuse2t64`, на 22.04 — `libfuse2`. Без FUSE можно распаковать и запустить:

```bash
chmod +x dist/EnotDesk-linux-x64.AppImage
./dist/EnotDesk-linux-x64.AppImage --appimage-extract-and-run
```

## macOS: разрешения при первом запуске

- **Запись экрана (Screen Recording)** — без разрешения оператор не увидит экран; приложение честно сообщит об отказе. Выдаётся в «Системные настройки → Конфиденциальность и безопасность → Запись экрана».
- **Универсальный доступ (Accessibility)** — нужен для передачи мыши/клавиатуры; без него приложение показывает статус, но не вводит.

Сборка не подписана, поэтому при первом запуске macOS может заблокировать приложение: откройте его правой кнопкой → «Открыть» (или разрешите в «Конфиденциальность и безопасность»).

## Подпись и нотаризация

- **macOS:** подпись Developer ID + нотаризация в Apple снимают предупреждение Gatekeeper. Требуют платного аккаунта Apple Developer и сертификатов. Сейчас в конфигурации `identity: null` — сборки не подписаны.
- **Windows:** подпись Authenticode снимает предупреждение SmartScreen «Неизвестный издатель». Требует платного сертификата.

Без подписи приложение работает, но пользователь видит предупреждение ОС при первом запуске. Включать подпись — решение владельца.

## CI (заметка на будущее)

Сборку можно автоматизировать в CI на «родных» раннерах (macOS — `macos-latest`, Windows — `windows-latest`, Linux — `ubuntu-latest`): checkout → Node 24 → `npm ci` → `npm test` → `npm run pack:<os>` → сохранить артефакт из `dist/`. CI сейчас не настроен; публикация и релизы тоже. Пока сборки не подписаны, никакие секреты не нужны — и их не следует добавлять в репозиторий.

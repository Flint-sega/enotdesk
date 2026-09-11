# build/

Конфигурация сборки клиента.

- `electron-builder.yml` — единственное место параметров упаковки: `directories.output: dist` (корень проекта), `files` = `client/**/*` + `assets/**/*`, `asarUnpack` для koffi, иконки из `assets/`, цели: mac zip (`identity: null` — без подписи), win portable, linux AppImage.

Запуск из корня проекта:

```
npm run pack:mac    # electron-builder --config build/electron-builder.yml --mac
npm run pack:win    # ... --win
npm run pack:linux  # ... --linux
```

Результат — в корневом `dist/` (например `dist/EnotDesk-mac-arm64.zip`). Поле `build` из `package.json` удалено: все параметры живут здесь.

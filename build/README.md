# build/

Конфигурация сборки клиента.

- `electron-builder.yml` — единственное место параметров упаковки: `directories.output: dist` (корень проекта).
- `files` — только рантайм: `client/**` (без `client/test/**`), `assets/mascot-app.webp`, `assets/mascot-mini.webp`, `assets/icon.png` (иконка Linux-ярлыка) и `package.json`, плюс срез koffi. Продовые зависимости (`koffi`, `ws`, `electron-updater`) electron-builder докладывает сам; почтовые зависимости хаба исключены. Остальные картинки `assets/` (иконки упаковщика, `mascot-site.*`, `mascot-hero.webp`, svg-логотипы, шрифты) в asar не попадают — их раздаёт сервер по `/brand/…`.
- `compression: maximum` и `electronLanguages: [ru, en-US]` — языковые ресурсы Electron обрезаны до двух (вместо ~55 `*.lproj`); только полные теги — голое `en` не совпадает ни с одним pak-файлом, и рендерер Windows без языкового пака падает.
- `asarUnpack` — только `node_modules/koffi/**` (нативная библиотека грузится с диска).
- Иконки — из `assets/`, цели: mac zip (`identity: null` — без подписи), win portable, linux AppImage.

Запуск из корня проекта:

```
npm run pack:mac    # electron-builder --config build/electron-builder.yml --mac
npm run pack:win    # ... --win
npm run pack:linux  # ... --linux
```

Результат — в корневом `dist/` (например `dist/EnotDesk-mac-arm64.zip`). Поле `build` из `package.json` удалено: все параметры живут здесь. Фактические размеры и замеры старта — в [`docs/BUILD.md`](../docs/BUILD.md).

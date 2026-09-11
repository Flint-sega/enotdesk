# build/

Конфигурация сборки клиента.

- `electron-builder.yml` — единственное место параметров упаковки: `directories.output: dist` (корень проекта).
- `files` — только рантайм: `client/**` (без `client/test/**`), `assets/enot-icon.svg`, `assets/enot-mascot.svg`, `assets/mascot-app.png` и `package.json`. Продовые зависимости (`koffi`, `ws`) electron-builder докладывает сам. `icon.icns/ico/png`, `icon-source.png`, `mascot-site.png`, README и тесты в asar не попадают: иконки нужны только упаковщику, `mascot-site.png` — серверным страницам.
- `compression: maximum` и `electronLanguages: [ru, en]` — языковые ресурсы Electron обрезаны до двух (вместо ~55 `*.lproj`).
- `asarUnpack` — только `node_modules/koffi/**` (нативная библиотека грузится с диска).
- Иконки — из `assets/`, цели: mac zip (`identity: null` — без подписи), win portable, linux AppImage.

Запуск из корня проекта:

```
npm run pack:mac    # electron-builder --config build/electron-builder.yml --mac
npm run pack:win    # ... --win
npm run pack:linux  # ... --linux
```

Результат — в корневом `dist/` (например `dist/EnotDesk-mac-arm64.zip`). Поле `build` из `package.json` удалено: все параметры живут здесь. Фактические размеры и замеры старта — в [`docs/BUILD.md`](../docs/BUILD.md).

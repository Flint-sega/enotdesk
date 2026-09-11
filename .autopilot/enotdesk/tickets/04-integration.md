# 04 — Portable, запуск и связная проверка
Требования: R01–R19i. Blocked by: 02,03. Волна: 3. Зона: package.json/lock, desktop/, server/, docs/, scripts/, README.md, BRAND.md, root mockup files.

Из брифа: «3» (Windows + macOS + Linux); «я даю ему ссылку на программу»; «она не устанавливается просто запускается у клиента».

Связать готовые компоненты, проверить реальные API/UI/media seams и собрать доступный portable macOS. electron-builder targets Windows portable, macOS zip .app, Linux AppImage; no autostart/services. Actual artifacts only in downloads. Исправить прежнюю неверную документацию RustDesk и демонстрационные credentials: mockup явно архивный, приложение запускается npm start. README честно различает проверенную macOS и непроверенные Windows/Linux, объясняет permissions, server/bootstrap/TURN и hosting later. ADR почему original Electron/WebRTC, lifetime и SQLite.

Приёмка: полный suite зелёный; visible desktop start + screenshot; local service startup and team operations from actual UI; attempt real capture only respecting OS grants, no silent injection into unrelated apps; package artifact verified exists and title/icon match; downloads points actual artifact; cross-platform native checks missing remain blockers rather than done. Run graphify update . after changes if available, report tool limitation. Tests logs concise returned; no secrets. No deployment/publication/signing credentials. No commit, return verdict/CONTRACT and actual startup instructions.

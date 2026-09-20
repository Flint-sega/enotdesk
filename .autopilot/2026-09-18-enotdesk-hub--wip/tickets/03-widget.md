# 03 — Чат-виджет для сайтов

**Требования:** R03, R03.1, R03.2, R11 (offline/rating отражение), R10
**Blocked by:** 02  **Зона:** `hub/widget/` (widget.js лоадер + /w iframe + WS), hub/app.mjs (CORS), hub/web (статусы агентов наружу), client/locales, hub/test
**Волна:** 2

## Что должно заработать
Одна строка `<script src="…/widget.js" data-server="…"></script>` на чужом сайте → пузырь → чат: WS-гость (visitor_id-cookie, reconnect), pre-chat (имя/email опц. + GDPR-строка с ссылкой на политику, consent-гейт если включено), offline-форма → тикет, история визитов, рейтинг после resolve; статусы агентов виджет честно показывает.

## Критерии приёмки
- [ ] widget.js лоадер (без зависимостей, ~100 строк) + iframe /w (пузырь/чат, mobile fullscreen)
- [ ] WS /ws/widget: гость→агент/агент→гость real-time; agent-status push; typing-индикатор опционален
- [ ] CORS-allowlist origins (настройка админа, эхо Origin) на HTTP-эндпоинтах виджета
- [ ] offline→тикет (email-канал), consent-гейт, история по visitor_id
- [ ] Тесты: WS-цикл гостя (фейк-страница), offline→тикет, CORS-эхо (allowed/denied), контракты страниц

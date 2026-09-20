// Рендер-гейт href карточки «Подключиться» (T05): карточку пишет сам hub,
// но консоль и виджет — два независимых рендера, а href попадает в DOM как
// есть. Разрешены только enotdesk: (запуск клиента) и https: (страница хаба);
// javascript:/data:/http: и мусор → null — кнопку с таким href не рендерим
// (фолбэк: сырой JSON в консоли, текстовый пузырь в виджете).
// Модуль чистый (без DOM/node:) — общий для web/app.mjs и widget/w.mjs.
export function safeCardHref(value, protocol) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    return new URL(value).protocol === protocol ? value : null;
  } catch {
    return null;
  }
}

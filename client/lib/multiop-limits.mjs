// Пределы мультиоператора (волна C, W-C5). Чистый модуль без DOM/node-импортов:
// импортируется и рендерером (session-media), и страницей скрытого моста
// (agent-bridge/bridge.mjs — CSP script-src 'self' file: разрешает модуль),
// и тестами. Хост строит персональный pc каждому оператору — без потолка
// память/CPU росли бы с числом присоединившихся без ограничений.

export const MULTIOP_VIDEO_CAP = 3; // максимум ОДНОВРЕМЕННЫХ видеослотов (энкодеров) на хосте

// Есть ли свободный видеослот: count — занятые слоты (живые операторы с видео).
// Присоединение свыше — pc строится без видео (чат/файлы/терминал остаются),
// оператор получает честный session-info; на сам join сервера лимита нет.
export function videoAllowed(count, cap = MULTIOP_VIDEO_CAP) {
  const n = Number(count);
  const c = Number(cap);
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(c) || c < 0) return false;
  return n < c;
}

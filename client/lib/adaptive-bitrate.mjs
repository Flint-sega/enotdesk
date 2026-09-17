// Политика адаптивного битрейта видео (A3): чистая функция без DOM и WebRTC.
// Ступени вниз при плохой сети (потери ≥5% или rtt > 400 мс), подъём при
// хорошей (потери <2% и rtt < 150 мс) — не раньше 15 с после последнего
// изменения, чтобы качество не дёргалось туда-сюда. Ступени и пороги спрятаны
// здесь; наружу — только решение.

// Лестница качества, бит/с: верх — читаемый экран, низ — survives плохая сеть.
const BITRATE_STEPS = [2_500_000, 1_200_000, 600_000];
const LOSS_DOWN_PCT = 5;
const RTT_DOWN_MS = 400;
const LOSS_UP_PCT = 2;
const RTT_UP_MS = 150;
const UP_HOLD_MS = 15_000;

// Стартовый потолок исходящего видео — верхняя ступень лестницы.
export const TOP_BITRATE = BITRATE_STEPS[0];

// nextTarget({lossPct, rttMs}, current, lastChangeAt, now) → {target, changed}.
// stats — сводка summarizeStats; мусор (null, NaN, без чисел) → без изменений.
// current вне лестницы допустим: вниз — ближайшая ступень строго ниже, вверх — строго выше.
export function nextTarget(stats, current, lastChangeAt, now) {
  const lossPct = stats?.lossPct;
  const rttMs = stats?.rttMs;
  const hasLoss = Number.isFinite(lossPct);
  const hasRtt = Number.isFinite(rttMs);
  if (!hasLoss && !hasRtt) return { target: current, changed: false };

  const degraded = (hasLoss && lossPct >= LOSS_DOWN_PCT) || (hasRtt && rttMs > RTT_DOWN_MS);
  if (degraded) {
    const below = BITRATE_STEPS.filter((step) => step < current);
    if (below.length === 0) return { target: current, changed: false };
    return { target: Math.max(...below), changed: true };
  }

  // Вверх — только по обоим сигналам хорошей сети и не раньше 15 с после
  // последнего изменения; нет данных о прошлом изменении — выжидать нечего.
  const healthy = hasLoss && lossPct < LOSS_UP_PCT && hasRtt && rttMs < RTT_UP_MS;
  const since = Number.isFinite(lastChangeAt) ? now - lastChangeAt : Infinity;
  if (healthy && since >= UP_HOLD_MS) {
    const above = BITRATE_STEPS.filter((step) => step > current);
    if (above.length > 0) return { target: Math.min(...above), changed: true };
  }
  return { target: current, changed: false };
}

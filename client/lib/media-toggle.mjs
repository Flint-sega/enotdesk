// Пауза трансляции: track.enabled=false шлёт чёрные кадры без ренегоциации.
// Чистая логика над стримом — тесты идут с моком, реальный MediaStream не нужен.

export function setVideoEnabled(stream, enabled) {
  let changed = 0;
  for (const track of stream?.getVideoTracks?.() ?? []) {
    if (track.enabled !== enabled) {
      track.enabled = enabled;
      changed += 1;
    }
  }
  return changed;
}

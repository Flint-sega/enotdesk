// Качество соединения из RTCPeerConnection.getStats(): rtt и доля потерь видео.
// report — RTCStatsReport (Map-подобный) или обычный объект; мусор → null.

export function summarizeStats(report) {
  let rttMs = null;
  let packetsLost = 0;
  let packetsReceived = 0;
  const each = (fn) => {
    if (typeof report?.forEach === 'function') report.forEach(fn);
    else for (const stat of Object.values(report ?? {})) fn(stat);
  };
  each((stat) => {
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && typeof stat.currentRoundTripTime === 'number') {
      rttMs = Math.round(stat.currentRoundTripTime * 1000);
    }
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
      packetsLost += stat.packetsLost ?? 0;
      packetsReceived += stat.packetsReceived ?? 0;
    }
    // Отправитель не получает видео: потери своего потока он видит только в
    // remote-inbound-rtp — отчёте приёмника (использует адаптивный битрейт).
    if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
      packetsLost += stat.packetsLost ?? 0;
      packetsReceived += stat.packetsReceived ?? 0;
    }
  });
  const total = packetsLost + packetsReceived;
  if (rttMs === null && total === 0) return null;
  return { rttMs, lossPct: total > 0 ? Math.round((packetsLost / total) * 100) : 0 };
}

// Человекочитаемая строка статуса: «Подключено · 45 мс · 2% потерь».
export function formatQuality(base, summary) {
  if (!summary) return base;
  const parts = [base];
  if (summary.rttMs !== null) parts.push(`${summary.rttMs} мс`);
  parts.push(`${summary.lossPct}% потерь`);
  return parts.join(' · ');
}

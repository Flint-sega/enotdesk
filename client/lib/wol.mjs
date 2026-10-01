// Wake-on-LAN (R10): построение magic packet и рассылка UDP-broadcast'ом.
// Чистый модуль без DOM/Electron: живёт в главном процессе клиента/агента,
// в тестах dgram инъекцией — сеть не нужна. MAC-валидация честная: мусор —
// throw, никаких «попытаемся и посмотрим».

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Стандарт WOL: порт 9 (discard), magic packet = 6×0xFF + 16×MAC.
export const WOL_PORT = 9;
const SEND_REPEATS = 3;
const SEND_INTERVAL_MS = 30;

// MAC «AA:BB:CC:DD:EE:FF» → Uint8Array из 6 байт; не-MAC — честный throw.
export function macToBytes(mac) {
  const str = typeof mac === 'string' ? mac.trim() : '';
  if (!MAC_RE.test(str)) {
    throw new Error(`invalid mac: ${typeof mac === 'string' ? mac.slice(0, 60) : typeof mac}`);
  }
  return Uint8Array.from(str.split(':').map((part) => parseInt(part, 16)));
}

// 6 байт 0xFF + 16 повторов MAC — ровно формат AMD Magic Packet (102 байта).
export function magicPacket(mac) {
  const bytes = macToBytes(mac);
  const payload = new Uint8Array(6 + 16 * bytes.length).fill(0xff);
  for (let i = 0; i < 16; i += 1) payload.set(bytes, 6 + i * bytes.length);
  return payload;
}

// Broadcast-адреса для рассылки: общий 255.255.255.255 первым, затем directed
// broadcast каждой известной подсети (192.168.1.10 → 192.168.1.255).
// Мусорные адреса молча пропускаются — список строится из того, что удалось
// понять; дубликаты подсетей схлопываются.
export function broadcastsFor(localIps) {
  const list = ['255.255.255.255'];
  for (const ip of Array.isArray(localIps) ? localIps : []) {
    if (typeof ip !== 'string' || !IPV4_RE.test(ip)) continue;
    const bcast = `${ip.split('.').slice(0, 3).join('.')}.255`;
    if (!list.includes(bcast)) list.push(bcast);
  }
  return list;
}

export function createWakeSender({ dgramFactory } = {}) {
  // Инъекция: фабрика возвращает dgram-подобный объект (createSocket) — тесты
  // без сети. Без инъекции — ленивый import node:dgram (загружается только
  // там, где Wake реально отправляют).
  const loadDgram = dgramFactory
    ? async () => dgramFactory
    : async () => (await import('node:dgram')).default;

  // sendMagicPacket(mac, {broadcasts}) — рассылает magic packet на каждый
  // broadcast-адрес (порт 9): по repeats=3 отправки с интервалом 30 мс,
  // по сокету на адрес. Promise разрешается, когда все запланированные
  // отправки завершены; сбой отдельного адреса собирается в failed, а не
  // роняет рассылку по остальным — у вызывающего остаётся честная картина.
  async function sendMagicPacket(mac, {
    broadcasts = ['255.255.255.255'],
    port = WOL_PORT,
    repeats = SEND_REPEATS,
    intervalMs = SEND_INTERVAL_MS,
  } = {}) {
    const payload = Buffer.from(magicPacket(mac)); // мусорный MAC — честный throw
    const targets = (Array.isArray(broadcasts) ? broadcasts : []).filter((a) => typeof a === 'string' && a);
    const dgram = await loadDgram();
    const failed = [];
    let packets = 0;
    await Promise.all(targets.map((addr) => new Promise((resolve) => {
      let sock;
      try {
        sock = dgram.createSocket('udp4');
      } catch {
        failed.push(addr);
        resolve();
        return;
      }
      let live = true;
      const finish = () => {
        if (!live) return;
        live = false;
        try { sock.close(); } catch { /* уже закрыт */ }
        resolve();
      };
      sock.on?.('error', () => {
        if (live) { live = false; failed.push(addr); resolve(); }
      });
      const sendAt = (attempt) => {
        if (!live) return;
        sock.send(payload, port, addr, (e) => {
          if (e) {
            if (live) { live = false; failed.push(addr); resolve(); }
            return;
          }
          packets += 1;
          if (attempt + 1 < repeats) setTimeout(() => sendAt(attempt + 1), intervalMs);
          else finish();
        });
      };
      try {
        // bind перед отправкой: SO_BROADCAST требуется после привязки сокета
        sock.bind(() => {
          try { sock.setBroadcast(true); } catch { /* платформа не даёт — не критично */ }
          sendAt(0);
        });
      } catch {
        if (live) { live = false; failed.push(addr); resolve(); }
      }
    })));
    return { broadcasts: targets.length, packets, failed };
  }

  return { sendMagicPacket };
}

// Флаги функций Chromium для всех окон приложения — чистые функции без Electron.
//
// WebRtcHideLocalIpsWithMdns (лаба 23.10, ВМ стенда с Windows 11): Chromium прячет
// локальные адреса WebRTC за именами *.local и для этого слушает UDP 5353 на всех
// интерфейсах. На Windows это открывает окно брандмауэра «Разрешить доступ к сетям?»
// при первом сеансе каждого нового пути программы (портатив — на каждую версию);
// окно забирает фокус, и нажатия оператора уходят в него. Без mDNS остаётся только
// сокет ICE на адресе интерфейса — окна нет, видео идёт. Наши пиры — оператор и
// машина своего сервера, допущенные согласием или PIN; прятать от них адрес в LAN
// незачем (RustDesk тоже передаёт локальный адрес для прямого соединения в LAN).

export const WEBRTC_MDNS_FEATURE = 'WebRtcHideLocalIpsWithMdns';

// Добавляет функцию к значению --disable-features, не теряя чужих (пользовательский
// флаг с командной строки) и без повторов.
export function withDisabledFeature(current, feature) {
  const list = String(current ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.includes(feature)) list.push(feature);
  return list.join(',');
}

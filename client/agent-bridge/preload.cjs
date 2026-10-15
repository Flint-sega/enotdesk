// Узкий preload страницы-моста терминала (R09): только фиксированные каналы
// из client/agent-bridge/relay.mjs (BRIDGE_IPC). Общий preload клиента
// (window.enot) сюда не попадает — окно агента не имеет отношения к рендереру.
// Мультиоператор (волна C): у моста N pc — сигнатуры несут op (claimId).
// Это внутренний контракт preload↔bridge/relay (имена каналов не меняются,
// меняются в паре с relay.mjs/bridge.mjs одним релизом).
const { contextBridge, ipcRenderer } = require('electron');

const wrap = (cb) => (_event, payload) => cb(payload);
const subscribe = (channel, cb) => {
  const h = wrap(cb);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('agentRtc', {
  // main → мост (op = claimId оператора; отсутствие — 'primary', легаси)
  onOffer: (cb) => subscribe('enot:rtc-offer', cb), // {op, sdp} | sdp
  onIce: (cb) => subscribe('enot:rtc-ice', cb), // {op, candidate} | candidate
  onIceConfig: (cb) => subscribe('enot:rtc-ice-config', cb), // общий TURN-конфиг
  onToDc: (cb) => subscribe('enot:term-dc-to', cb), // {op, label, data} | {op, close:true}
  onVideoFrame: (cb) => subscribe('enot:video-frame', cb), // общий jpeg-кадр
  // мост → main
  sendAnswer: (sdp, op) => ipcRenderer.send('enot:rtc-answer', op ? { op, sdp } : sdp),
  sendIce: (candidate, op) => ipcRenderer.send('enot:rtc-ice', op ? { op, candidate } : candidate),
  dcOpened: (label, op) => ipcRenderer.send('enot:term-dc-open', op ? { op, label } : label),
  // data — строка ИЛИ Uint8Array (бинарные чанки файлов, W-U6): structured clone
  // ipc-посылки переносит typed array без потерь.
  dcFrom: (label, data, op) => ipcRenderer.send('enot:term-dc-from', { op: op || 'primary', label, data }),
  dcClosed: (label, op) => ipcRenderer.send('enot:term-dc-closed', op ? { op, label } : label),
  pause: (op) => ipcRenderer.send('enot:term-dc-pause', op || 'primary'),
  resume: (op) => ipcRenderer.send('enot:term-dc-resume', op || 'primary'),
  fail: (message) => ipcRenderer.send('enot:bridge-fail', message),
});

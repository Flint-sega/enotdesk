// Узкий preload страницы-моста терминала (R09): только фиксированные каналы
// из client/agent-bridge/relay.mjs (BRIDGE_IPC). Общий preload клиента
// (window.enot) сюда не попадает — окно агента не имеет отношения к рендереру.
const { contextBridge, ipcRenderer } = require('electron');

const wrap = (cb) => (_event, payload) => cb(payload);
const subscribe = (channel, cb) => {
  const h = wrap(cb);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('agentRtc', {
  // main → мост
  onOffer: (cb) => subscribe('enot:rtc-offer', cb),
  onIce: (cb) => subscribe('enot:rtc-ice', cb),
  onIceConfig: (cb) => subscribe('enot:rtc-ice-config', cb),
  onToDc: (cb) => subscribe('enot:term-dc-to', cb),
  onVideoFrame: (cb) => subscribe('enot:video-frame', cb),
  // мост → main
  sendAnswer: (sdp) => ipcRenderer.send('enot:rtc-answer', sdp),
  sendIce: (candidate) => ipcRenderer.send('enot:rtc-ice', candidate),
  dcOpened: (label) => ipcRenderer.send('enot:term-dc-open', label),
  // data — строка ИЛИ Uint8Array (бинарные чанки файлов, W-U6): structured clone
  // ipc-посылки переносит typed array без потерь.
  dcFrom: (label, data) => ipcRenderer.send('enot:term-dc-from', { label, data }),
  dcClosed: (label) => ipcRenderer.send('enot:term-dc-closed', label),
  pause: () => ipcRenderer.send('enot:term-dc-pause'),
  resume: () => ipcRenderer.send('enot:term-dc-resume'),
  fail: (message) => ipcRenderer.send('enot:bridge-fail', message),
});

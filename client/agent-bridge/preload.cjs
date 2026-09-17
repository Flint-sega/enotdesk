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
  onToDc: (cb) => subscribe('enot:term-dc-to', cb),
  // мост → main
  sendAnswer: (sdp) => ipcRenderer.send('enot:rtc-answer', sdp),
  sendIce: (candidate) => ipcRenderer.send('enot:rtc-ice', candidate),
  dcOpened: (label) => ipcRenderer.send('enot:term-dc-open', label),
  dcFrom: (data) => ipcRenderer.send('enot:term-dc-from', data),
  dcClosed: () => ipcRenderer.send('enot:term-dc-closed'),
  pause: () => ipcRenderer.send('enot:term-dc-pause'),
  resume: () => ipcRenderer.send('enot:term-dc-resume'),
  fail: (message) => ipcRenderer.send('enot:bridge-fail', message),
});

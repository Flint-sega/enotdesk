// Preload: единственный мост рендерера — window.enot с явным списком методов.
// Никаких произвольных IPC: каждое имя канала фиксировано, main проверяет отправителя.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('enot', {
  getSettings: () => ipcRenderer.invoke('enot:getSettings'),
  setLocale: (locale) => ipcRenderer.invoke('enot:setLocale', locale),
  setServerUrl: (url, opts) => ipcRenderer.invoke('enot:setServerUrl', url, opts),
  request: (operation, payload) => ipcRenderer.invoke('enot:request', operation, payload),
  openSignal: (params) => ipcRenderer.invoke('enot:openSignal', params),
  sendSignal: (message) => ipcRenderer.invoke('enot:sendSignal', message),
  closeSignal: () => ipcRenderer.invoke('enot:closeSignal'),
  sources: () => ipcRenderer.invoke('enot:sources'),
  selectSource: (id) => ipcRenderer.invoke('enot:selectSource', id),
  permissions: () => ipcRenderer.invoke('enot:permissions'),
  input: (event) => ipcRenderer.invoke('enot:input', event),
  copy: (text) => ipcRenderer.invoke('enot:copy', text),
  openExternal: (url) => ipcRenderer.invoke('enot:openExternal', url),
  quit: () => ipcRenderer.invoke('enot:quit'),
  onSignal: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('enot:signal', listener);
    return () => ipcRenderer.removeListener('enot:signal', listener);
  },
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('enot:update', listener);
    return () => ipcRenderer.removeListener('enot:update', listener);
  },
});

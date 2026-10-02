// Узкий preload чат-виджета: только каналы виджета, никакого window.enot.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('chatWidget', {
  onMessage: on('enot:chat-widget-msg'),   // {who, text}
  onState: on('enot:chat-widget-state'),   // {visible, collapsed, unread}
  send: (text) => ipcRenderer.send('enot:chat-widget-out', String(text ?? '')),
  toggle: () => ipcRenderer.send('enot:chat-widget-toggle'),
  close: () => ipcRenderer.send('enot:chat-widget-close'),
});

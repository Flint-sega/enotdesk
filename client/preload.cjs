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
  captureStatus: (state, reason) => ipcRenderer.invoke('enot:captureStatus', { state, reason }),
  closeSignal: () => ipcRenderer.invoke('enot:closeSignal'),
  sources: () => ipcRenderer.invoke('enot:sources'),
  selectSource: (id) => ipcRenderer.invoke('enot:selectSource', id),
  selectPrimaryScreen: () => ipcRenderer.invoke('enot:selectPrimaryScreen'),
  appVersion: () => ipcRenderer.invoke('enot:appVersion'),
  relayUpload: (name, buffer) => ipcRenderer.invoke('enot:relayUpload', { name, buffer }),
  sendFileLink: (link) => ipcRenderer.invoke('enot:sendFileLink', link),
  permissions: () => ipcRenderer.invoke('enot:permissions'),
  // Программа оператора (ADR 0033, этап 2): отдельное окно со страницей сервера
  // <сервер>/operator; ответ {ok, reason?, version?}, статус окна — onOperatorWindow.
  openOperatorWindow: () => ipcRenderer.invoke('enot:openOperatorWindow'),
  onOperatorWindow: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('enot:operator-window', listener);
    return () => ipcRenderer.removeListener('enot:operator-window', listener);
  },
  // Чат-виджет (спека владельца 02.10): рендерер отдаёт сообщения оператора в
  // main, обратно получает ответы из виджета и события жизненного цикла.
  chatWidgetMsg: (text) => ipcRenderer.send('enot:chat-widget-msg', String(text ?? '')),
  chatWidgetEnd: () => ipcRenderer.send('enot:chat-widget-end'),
  onChatWidgetOut: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('enot:chat-widget-out', listener);
    return () => ipcRenderer.removeListener('enot:chat-widget-out', listener);
  },
  // Арбитраж ввода (W-C4): события ввода несут opKey (claimId оператора host-роли);
  // claim/release — служебные кнопки оператора; attach/drop — жизненный цикл
  // операторов host-стороны; input-active — события смены активного вводчика.
  input: (event, opKey) => ipcRenderer.invoke('enot:input', event, opKey),
  inputClaim: (opKey) => ipcRenderer.invoke('enot:input-claim', opKey),
  inputRelease: (opKey) => ipcRenderer.invoke('enot:input-release', opKey),
  inputPass: (opKey, to) => ipcRenderer.invoke('enot:input-pass', opKey, to),
  inputViewOnly: (opKey, on) => ipcRenderer.invoke('enot:input-view-only', opKey, on),
  inputAttach: (claimId) => ipcRenderer.invoke('enot:input-attach', claimId),
  inputDrop: (claimId) => ipcRenderer.invoke('enot:input-drop', claimId),
  onInputActive: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('enot:input-active', listener);
    return () => ipcRenderer.removeListener('enot:input-active', listener);
  },
  copy: (text) => ipcRenderer.invoke('enot:copy', text),
  // Установка машины (службы агента) из клиента (ADR 0029): main скачивает
  // setup и запускает install-скрипт с UAC; ответ {ok, reason?, log?}
  installAgentService: (code) => ipcRenderer.invoke('enot:installAgentService', { code }),
  // One-click (R04): репорт {sessionId,password} на hub — сеть только в main
  // (CSP рендерера connect-src 'self' file:); ответ {ok,status}
  joinReport: (server, token, creds) => ipcRenderer.invoke('enot:joinReport', server, token, creds),
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
  // One-click (R04): main разобрал enotdesk://join и просит автостарт сеанса
  onJoinStart: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('enot:onJoinStart', listener);
    return () => ipcRenderer.removeListener('enot:onJoinStart', listener);
  },
  // Deep-link enotdesk://invite#token=…: main открыл /invite в окне оператора,
  // главное окно переключается на вкладку «Оператор» (без токена)
  onInvitePrefill: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, token) => callback(token);
    ipcRenderer.on('enot:invite-prefill', listener);
    return () => ipcRenderer.removeListener('enot:invite-prefill', listener);
  },
});

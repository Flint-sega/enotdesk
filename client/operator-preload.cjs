// Preload окна оператора (ADR 0033, этап 2): окно показывает страницу С СЕРВЕРА
// (<сервер>/operator), поэтому мост минимальный — только «запомнить меня».
// Никакой сети, ввода, сигналинга: страница работает как в обычном браузере.
// main проверяет отправителя: окно оператора, главный фрейм, origin сервера.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('enotOperator', {
  // доступно ли шифрование ОС (DPAPI/Keychain/keyring); нет — чекбокс не показывать
  credentialsAvailable: () => ipcRenderer.invoke('enot-op:credentials-available'),
  // сохранённые {login, password} для этого сервера или null; один раз за загрузку страницы
  credentialsLoad: () => ipcRenderer.invoke('enot-op:credentials-load'),
  credentialsSave: (creds) => ipcRenderer.invoke('enot-op:credentials-save', creds),
  credentialsClear: () => ipcRenderer.invoke('enot-op:credentials-clear'),
});

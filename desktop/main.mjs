// EnotDesk main-процесс: окно/процесс, конфигурация, токены, WS-сигналинг,
// ворота нативного ввода по реальному WS-состоянию, выбор источника захвата.
// Рендереру доступен только context-isolated мост window.enot (preload.cjs).

import { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell, clipboard, systemPreferences } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createApi, sanitizeForRenderer } from './lib/api.mjs';
import { createSignalClient } from './lib/signal.mjs';
import { createInputGate } from './lib/protocol.mjs';
import { createNativeInput } from './lib/native-input.mjs';
import { createInputPipeline } from './lib/input-pipeline.mjs';
import { INPUT_KEYS } from './lib/protocol.mjs';

const SMOKE = process.env.EDESK_SMOKE === '1';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080';

let win = null;
let settingsPath = null;
let settings = { serverUrl: DEFAULT_SERVER_URL };

// Токены живут только здесь (main). Рендереру не возвращаются.
let api = createApi({ baseUrl: settings.serverUrl });

// Сигналинг и ворота ввода
let signal = null;
let heartbeatTimer = null;
const gate = createInputGate();
let signalRole = null;
// koffi подключается лениво по наличию пакета: нет пакета — честный инертный режим
let koffi = null;
try { koffi = createRequire(import.meta.url)('koffi'); } catch { koffi = null; }
const nativeInput = createNativeInput({ koffi });
// Единая проводка ввода: те же ворота и диспетчер, что проверяет тест шва
const inputPipeline = createInputPipeline({ gate, nativeInput });
let selectedSource = null; // {id, name, bounds:{width,height}} физические пиксели

function loadSettings() {
  try {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof raw.serverUrl === 'string' && raw.serverUrl) settings.serverUrl = raw.serverUrl;
  } catch {
    // первый запуск — файл настроек ещё не существует
  }
  api = createApi({ baseUrl: settings.serverUrl });
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Не удалось сохранить настройки: ${e.message}` };
  }
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function stopSignal() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (signal) { signal.close(); signal = null; }
  gate.close();
  if (gate.needInputReset()) nativeInput.end();
  signalRole = null;
}

function startSignal(params) {
  const { role, sessionId, claimId } = params;
  stopSignal();
  signalRole = role;
  signal = createSignalClient({ url: new URL('/signal', settings.serverUrl).toString().replace(/^http/, 'ws') });
  signal.onMessage((msg) => {
    gate.onSignal(msg);
    if (gate.needInputReset()) nativeInput.end();
    if (msg.type === 'ended' || msg.type === 'socket-closed') {
      // Разрыв сигналинга завершает сеанс локально, fail closed (R15.2/R16)
      sendToRenderer('enot:signal', { type: 'ended', reason: msg.type === 'ended' ? msg.reason : 'signal-lost' });
      stopSignal();
      api.clearSessionTokens();
      return;
    }
    sendToRenderer('enot:signal', msg);
  });
  const auth = role === 'host'
    ? { role, sessionId, hostToken: api.hostToken }
    : { role, sessionId, claimId, token: api.authToken };
  return signal.open(auth).then((ready) => {
    gate.onSignal(ready);
    if (role === 'host') {
      heartbeatTimer = setInterval(() => signal?.heartbeat(), 5000);
    }
    return ready;
  });
}

// Захват: main валидирует выбранный источник и хранит границы дисплея (R01.2/R19i)
async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  return sources.map((s) => ({ id: s.id, name: s.name }));
}

async function selectSource(id) {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => s.id === id);
  if (!src) return { ok: false, error: 'Выбранный источник больше не доступен, выберите заново' };
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => String(d.id) === String(src.display_id)) ?? displays[0];
  const bounds = display
    ? { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    : { width: 0, height: 0 };
  selectedSource = { id: src.id, name: src.name, bounds };
  return { ok: true, name: src.name };
}

function permissionsReport() {
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
  const report = {
    platform: process.platform,
    wayland,
    nativeInput: nativeInput.status(),
    inputKeys: [...INPUT_KEYS], // единый источник истины: рендерер не дублирует allowlist
    screenCapture: 'unknown',
  };
  if (process.platform === 'darwin') {
    try {
      report.screenCapture = systemPreferences.getMediaAccessStatus('screen');
    } catch {
      report.screenCapture = 'unknown';
    }
  }
  if (wayland) {
    report.controlNote = 'Wayland: передача управления вводом не поддерживается. Запустите сеанс X11, чтобы оператор мог управлять мышью и клавиатурой.';
  }
  return report;
}

function registerIpc() {
  const fromOurRenderer = (e) => win !== null && !win.isDestroyed() && e.sender === win.webContents;
  const guard = (e) => {
    if (!fromOurRenderer(e)) throw new Error('Доступ запрещён: недоверенный отправитель');
  };

  ipcMain.handle('enot:getSettings', (e) => { guard(e); return { serverUrl: settings.serverUrl, firstRun: !fs.existsSync(settingsPath) }; });

  ipcMain.handle('enot:setServerUrl', (e, url) => {
    guard(e);
    if (typeof url !== 'string') throw new Error('Некорректный адрес сервера');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Некорректный адрес сервера'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('Для внешних адресов требуется HTTPS; HTTP разрешён только для 127.0.0.1/localhost');
    }
    settings.serverUrl = url.replace(/\/$/, '');
    const saved = saveSettings();
    api = createApi({ baseUrl: settings.serverUrl });
    return { ...saved, serverUrl: settings.serverUrl };
  });

  ipcMain.handle('enot:request', async (e, operation, payload) => {
    guard(e);
    if (typeof operation !== 'string') throw new Error('Некорректная операция');
    if (payload !== undefined && (payload === null || typeof payload !== 'object')) throw new Error('Некорректные данные запроса');
    const result = await api.request(operation, payload ?? {});
    // Ошибки HTTP приходят рендереру как {status, body:{error}} — честно, без выдуманных данных
    return result;
  });

  ipcMain.handle('enot:openSignal', (e, params) => {
    guard(e);
    if (!params || typeof params !== 'object' || (params.role !== 'host' && params.role !== 'operator')) {
      throw new Error('Некорректные параметры сигналинга');
    }
    return startSignal(params);
  });

  ipcMain.handle('enot:sendSignal', (e, message) => {
    guard(e);
    if (!signal) throw new Error('Сигнальное соединение закрыто');
    signal.sendSignal(message); // валидация ограниченного протокола внутри
    return { ok: true };
  });

  ipcMain.handle('enot:closeSignal', (e) => { guard(e); stopSignal(); return { ok: true }; });

  ipcMain.handle('enot:sources', async (e) => { guard(e); return { items: await listSources() }; });

  ipcMain.handle('enot:selectSource', async (e, id) => {
    guard(e);
    if (typeof id !== 'string') throw new Error('Некорректный источник');
    return selectSource(id);
  });

  ipcMain.handle('enot:permissions', (e) => { guard(e); return permissionsReport(); });

  ipcMain.handle('enot:input', (e, ev) => {
    guard(e);
    // Ворота и диспетчер — main, по реальному WS-состоянию (см. input-pipeline.mjs)
    if (!selectedSource) return { ok: false, reason: 'no-source' };
    return inputPipeline.handle(ev, selectedSource.bounds);
  });

  ipcMain.handle('enot:copy', (e, text) => {
    guard(e);
    if (typeof text !== 'string') return { ok: false, error: 'Некорректный текст' };
    try { clipboard.writeText(text); return { ok: true }; } catch (err) {
      return { ok: false, error: `Буфер обмена недоступен: ${err.message}` };
    }
  });

  ipcMain.handle('enot:quit', (e) => { guard(e); app.quit(); return { ok: true }; });

  // Внешние ссылки — только одобренные https-адреса, через системный браузер
  ipcMain.handle('enot:openExternal', (e, url) => {
    guard(e);
    if (typeof url !== 'string') throw new Error('Некорректная ссылка');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Некорректная ссылка'); }
    if (parsed.protocol !== 'https:') throw new Error('Разрешены только https-ссылки');
    shell.openExternal(parsed.toString());
    return { ok: true };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    title: 'EnotDesk',
    backgroundColor: '#0B1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Захват через задокументированный путь: setDisplayMediaRequestHandler
  session.defaultSession.setDisplayMediaRequestHandler((_opts, callback) => {
    if (!selectedSource) {
      callback({}); // рендерер получит отказ и покажет честную ошибку
      return;
    }
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const src = sources.find((s) => s.id === selectedSource.id);
      if (src) callback({ video: src });
      else { selectedSource = null; callback({}); }
    });
  }, { useSystemPicker: false });

  win.on('closed', () => { win = null; });
  win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
}

// Закрытие окна = реальный выход, без фонового процесса (R16.1)
function cleanupAndQuit() {
  // Best-effort revoke: не ждём сервер дольше ~1с, локальное завершение от него не зависит
  if (api.hostSessionId && api.hostToken) {
    const revoke = api.request('session.end', { sessionId: api.hostSessionId, asHost: true }).catch(() => {});
    void Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  stopSignal();
  nativeInput.end();
  api.clearSessionTokens();
  api.clearAuth();
}
app.on('before-quit', cleanupAndQuit);
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  if (SMOKE) {
    // Скриншот главного экрана: не first-run, иначе модалка настроек закрывает окно
    try {
      const p = path.join(app.getPath('userData'), 'settings.json');
      if (!fs.existsSync(p)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ serverUrl: DEFAULT_SERVER_URL }));
      }
    } catch { /* smoke: честный скриншот first-run, если записать не вышло */ }
  }
  loadSettings();
  registerIpc();
  createWindow();
  if (SMOKE) {
    setTimeout(async () => {
      const lines = [];
      lines.push(`SMOKE window: ${win ? 'created' : 'MISSING'}`);
      lines.push(`SMOKE title: ${win ? win.getTitle() : 'n/a'}`);
      lines.push(`SMOKE native input status: ${JSON.stringify(nativeInput.status())}`);
      const perms = permissionsReport();
      lines.push(`SMOKE permissions: ${JSON.stringify(perms)}`);
      const gateCheck = createInputGate();
      gateCheck.onSignal({ type: 'ready', role: 'host', sessionId: 1, state: 'waiting' });
      lines.push(`SMOKE gate closed before approved: ${!gateCheck.isOpen()}`);
      gateCheck.onSignal({ type: 'approved', claimId: 'c' });
      lines.push(`SMOKE gate open after approved: ${gateCheck.isOpen()}`);
      console.log(lines.join('\n'));
      // Скриншот главного окна для отчёта (capturePage, без системных разрешений)
      try {
        const shotPath = process.env.EDESK_SMOKE_PATH || path.join(import.meta.dirname, '..', 'docs', 'screenshot-main.png');
        const img = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(shotPath), { recursive: true });
        fs.writeFileSync(shotPath, img.toPNG());
        console.log(`SMOKE screenshot: ${shotPath}`);
      } catch (e) {
        console.log(`SMOKE screenshot failed: ${e.message}`);
      }
      console.log('SMOKE OK');
      // закрытие окна должно завершить процесс (window-all-closed → quit), а не app.quit напрямую
      win.close();
    }, 2500);
  }
});

// EnotDesk main-процесс: окно/процесс, конфигурация, токены, WS-сигналинг,
// ворота нативного ввода по реальному WS-состоянию, выбор источника захвата.
// Рендереру доступен только context-isolated мост window.enot (preload.cjs).

import { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell, clipboard, systemPreferences, Menu } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createApi } from './lib/api.mjs';
import { createSignalClient } from './lib/signal.mjs';
import { createInputGate } from './lib/protocol.mjs';
import { createNativeInput, loadPlatformAdapter } from './lib/native-input.mjs';
import { createInputPipeline } from './lib/input-pipeline.mjs';
import { INPUT_KEYS } from './lib/protocol.mjs';
import { normalizeServerUrl } from './lib/server-url.mjs';
import { resolveServerUrl, DEFAULT_SERVER_URL } from './lib/first-run.mjs';
import { createAgent, createAgentApi, createIceServersFetcher } from './lib/agent.mjs';
import { createBridgeRelay, BRIDGE_IPC } from './agent-bridge/relay.mjs';
import { createTermHost } from './lib/term.mjs';
import { showToast } from './lib/notify.mjs';
import { UPDATE_REPO, updateFeedUrl, platformFeedName, updateDecision } from './lib/updater.mjs';
import { isNewerVersion } from './lib/version-check.mjs';
import { t, setLocale } from './lib/i18n.mjs';

const SMOKE = process.env.EDESK_SMOKE === '1';
// Режим агента-службы (EDESK_AGENT=1): без окна, логи честные в stdout.
// Отдельный userData-профиль даёт агенту свой single-instance-замок, поэтому
// служба и обычный клиент работают на одной машине одновременно.
const AGENT = process.env.EDESK_AGENT === '1';
if (AGENT) app.setPath('userData', path.join(app.getPath('userData'), 'agent'));
// EDESK_SMOKE_FIRSTRUN=1 (вместе с EDESK_SMOKE=1): изолированный профиль без
// settings.json — честный прогон и скриншот первого запуска, данные не трогаем.
if (SMOKE && process.env.EDESK_SMOKE_FIRSTRUN === '1') {
  app.setPath('userData', path.join(app.getPath('userData'), 'smoke-firstrun'));
}

// Версия продукта: в упаковке — app.getVersion(); в dev Electron отдаёт свою версию,
// поэтому один раз при старте читаем фактическую из корневого package.json.
const pkg = (() => {
  try {
    return createRequire(import.meta.url)('../package.json');
  } catch (e) {
    // не выдумываем версию: футер просто не покажется, но сбой виден в логе
    console.error('Не удалось прочитать версию из корневого package.json (футер останется без версии):', e.message);
    return {};
  }
})();

// Вшитый при сборке адрес сервера (R03): electron-builder extraMetadata кладёт
// ключ в package.json внутри app.asar (build/electron-builder.yml), dev-прогон
// может задать его переменной окружения. Пустая строка = «не задано».
const BAKED_SERVER_URL = pkg.ENOT_BAKED_SERVER_URL || process.env.ENOT_BAKED_SERVER_URL || null;

let win = null;
let settingsPath = null;
let settings = { serverUrl: DEFAULT_SERVER_URL, allowInsecureHttp: false, locale: null };

// Один экземпляр на машину: второй запуск просто уходит, а этот получает
// second-instance и показывает окно. Заодно закрывает обход «одно окно —
// одна роль» двойным запуском портативки. EDESK_ALLOW_MULTI=1 — явный
// тестовый обход для проверки двух ролей на одном компьютере.
const allowMulti = process.env.EDESK_ALLOW_MULTI === '1';
const gotLock = allowMulti || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Токены живут только здесь (main). Рендереру не возвращаются.
let api = createApi({ baseUrl: settings.serverUrl });

// Сигналинг и ворота ввода
let signal = null;
let heartbeatTimer = null;
const gate = createInputGate();
let signalRole = null;
// koffi грузится лениво: permissions()/status() его не трогают, только старт host-сеанса
// или первый реальный ввод; нет пакета — честный инертный режим.
const nativeInput = createNativeInput({
  getAdapter: () => {
    let koffi;
    try { koffi = createRequire(import.meta.url)('koffi'); } catch { koffi = null; }
    return loadPlatformAdapter(koffi);
  },
});
// Единая проводка ввода: те же ворота и диспетчер, что проверяет тест шва
const inputPipeline = createInputPipeline({ gate, nativeInput });
let selectedSource = null; // {id, name, bounds:{width,height}} физические пиксели

function loadSettings() {
  let savedUrl = null;
  try {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (typeof raw.serverUrl === 'string' && raw.serverUrl) savedUrl = raw.serverUrl;
    settings.allowInsecureHttp = raw.allowInsecureHttp === true;
    settings.locale = raw.locale === 'ru' || raw.locale === 'en' ? raw.locale : null; // null = по системе
  } catch {
    // первый запуск — файл настроек ещё не существует
  }
  // Порядок резолва (spec §первый запуск): сохранённый → enotdesk-server.txt
  // рядом с exe → вшитый при сборке → дефолт.
  settings.serverUrl = resolveServerUrl({
    saved: savedUrl,
    execPath: process.execPath,
    baked: BAKED_SERVER_URL,
  }).url;
  setLocale(settings.locale); // строки main-процесса — тоже из словаря (null оставляет ru по умолчанию)
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

// Автообновление (история 34): только упакованное приложение — dev, EDESK_SMOKE
// и агент-служба не проверяют ничего. Проверка раз в сутки; фид — generic-провайдер
// electron-updater на GitHub Releases (latest*.yml к релизу прикладывает release.yml).
// electron-updater — мягкая зависимость: если пакета нет, честно логируем и остаёмся
// на уведомлениях по фиду (fetch + чистый парсер updater.mjs), установку не подменяем.
// Windows-сборка v1 — portable .exe: автоустановку такой формат не поддерживает,
// поэтому только уведомление со ссылкой на страницу релизов (update.manualBanner).
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

function startUpdater() {
  if (SMOKE || AGENT || !app.isPackaged) return;
  const feedUrl = updateFeedUrl(UPDATE_REPO);
  const notify = (payload) => sendToRenderer('enot:update', payload);
  let autoUpdater = null;
  try { autoUpdater = createRequire(import.meta.url)('electron-updater').autoUpdater; } catch { autoUpdater = null; }
  if (!autoUpdater) {
    console.log(`[enotdesk] автообновление выключено: пакет electron-updater не установлен (уведомления о версиях по фиду ${feedUrl} продолжаются)`);
    const check = async () => {
      try {
        const res = await fetch(feedUrl + platformFeedName(process.platform));
        const d = updateDecision({ current: app.getVersion(), feedText: res.ok ? await res.text() : null });
        if (d.update) notify({ version: d.version, auto: false });
      } catch { /* баннер не критичен, следующий цикл через сутки */ }
    };
    void check();
    setInterval(check, UPDATE_CHECK_MS);
    return;
  }
  autoUpdater.autoDownload = process.platform !== 'win32';
  autoUpdater.autoInstallOnAppQuit = true; // не рвём активный сеанс: установка при закрытии
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  } catch (e) {
    console.error(`[enotdesk] не удалось задать фид обновлений: ${e.message}`);
    return;
  }
  autoUpdater.on('update-available', (info) => {
    const version = String(info?.version ?? '');
    if (isNewerVersion(app.getVersion(), version)) notify({ version, auto: autoUpdater.autoDownload });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[enotdesk] обновление ${info?.version ?? ''} скачано — применится при закрытии приложения`);
    notify({ version: String(info?.version ?? ''), auto: true });
  });
  autoUpdater.on('error', (e) => console.log(`[enotdesk] проверка обновлений не удалась: ${e?.message ?? e}`));
  autoUpdater.checkForUpdates().catch((e) => console.log(`[enotdesk] проверка обновлений не удалась: ${e?.message ?? e}`));
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => { /* ошибки приходят в 'error' */ }); }, UPDATE_CHECK_MS);
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
  if (signal && signalRole && signalRole !== role) {
    throw new Error('В этом окне уже идёт сеанс помощи. Одно окно EnotDesk работает только в одной роли — завершите текущий сеанс или используйте второе устройство.');
  }
  stopSignal();
  signalRole = role;
  if (role === 'host') nativeInput.load(); // подготовка нативного ввода к реальному сеансу
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
  if (!displays.length) return { ok: false, error: 'Дисплеи не найдены — координаты ввода определить невозможно' };
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

  ipcMain.handle('enot:getSettings', (e) => { guard(e); return { serverUrl: settings.serverUrl, allowInsecureHttp: settings.allowInsecureHttp, locale: settings.locale, firstRun: !fs.existsSync(settingsPath), version: app.isPackaged ? app.getVersion() : pkg.version }; });

  // Выбор языка интерфейса (R08.2): только известные локали, null снимает выбор.
  ipcMain.handle('enot:setLocale', (e, locale) => {
    guard(e);
    if (locale !== 'ru' && locale !== 'en' && locale !== null) throw new Error(t('error.badLocale'));
    settings.locale = locale;
    setLocale(locale); // словарные строки main держатся в одном языке с интерфейсом
    const saved = saveSettings();
    return { ...saved, locale: settings.locale };
  });

  ipcMain.handle('enot:setServerUrl', (e, url, opts = {}) => {
    guard(e);
    const allowInsecureHttp = opts?.allowInsecureHttp === true;
    const result = normalizeServerUrl(url, { allowInsecureHttp });
    if (!result.ok) {
      if (result.reason === 'https-required') {
        throw new Error('Для внешних адресов нужен HTTPS. Для тестового сервера включите галочку "Разрешить HTTP без шифрования".');
      }
      throw new Error('Некорректный адрес сервера');
    }
    settings.serverUrl = result.url;
    settings.allowInsecureHttp = allowInsecureHttp;
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
  if (SMOKE) win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`SMOKE console[${level}] ${source}:${line} ${message}`);
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Контекстное меню текстовых полей: копировать/вставить/выделить — без IPC
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { label: 'Копировать', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Вставить', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Выделить всё', role: 'selectAll' },
    ]).popup({ window: win });
  });

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

// Скрытый renderer-мост RTC терминала (R09): по approved (rtc()) создаётся
// невидимое BrowserWindow со страницей client/agent-bridge/, где есть нативный
// RTCPeerConnection. Offer/answer/ICE и данные DataChannel релеются по
// фиксированным IPC-каналам (BRIDGE_IPC) через createBridgeRelay. Мост живёт
// только внутри сеанса: pcLike.close() на ended/stop; краш страницы не роняет
// агента — терминал честно закрывается (relay.destroy → onclose канала).
function createAgentRtc({ fetchIceServers } = {}) {
  return () => {
    let win = null;
    let relay = null;
    const ipcHandlers = [];
    const cleanup = () => {
      for (const [channel, handler] of ipcHandlers.splice(0)) ipcMain.removeListener(channel, handler);
      if (win) {
        const w = win;
        win = null;
        try { w.destroy(); } catch { /* уже мёртв */ }
      }
    };
    try {
      win = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(import.meta.dirname, 'agent-bridge', 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
    } catch (e) {
      console.error(`[enotdesk-agent] мост RTC недоступен: ${e.message}`);
      return null;
    }
    win.on('closed', () => { win = null; });
    relay = createBridgeRelay({
      send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
      onClosed: cleanup,
      // TURN для pc терминала (R09): релей запросит конфиг один раз до первого
      // offer; сбой/пусто — релей сам честно деградирует в iceServers:[] (по LAN).
      fetchIceServers,
      log: console,
    });
    // отправитель — только наше окно: чужие ipc-посылки не проходят
    for (const channel of Object.values(BRIDGE_IPC)) {
      const handler = (e, payload) => {
        if (win && !win.isDestroyed() && e.sender === win.webContents) relay.handleMessage(channel, payload);
      };
      ipcMain.on(channel, handler);
      ipcHandlers.push([channel, handler]);
    }
    win.webContents.on('did-finish-load', () => relay.markReady()); // мост готов получать offer
    win.webContents.on('render-process-gone', () => {
      console.warn('[enotdesk-agent] мост RTC упал — терминал честно закрывается');
      relay.destroy();
    });
    win.loadFile(path.join(import.meta.dirname, 'agent-bridge', 'page.html')).catch((e) => {
      console.error(`[enotdesk-agent] страница моста не загрузилась: ${e.message}`);
      relay.destroy();
    });
    return relay.pcLike;
  };
}

// Инвентарь машины (R06): честный сбор — что собрать не удалось, поле просто
// отсутствует, фейков нет. statfs даёт свободное место на томе профиля
// (Node/Electron умеют его на всех трёх ОС; при отказе — поле без диска).
async function collectInventory() {
  const inventory = {
    os: process.platform,
    appVersion: app.isPackaged ? app.getVersion() : pkg.version,
    uptimeSec: Math.floor(process.uptime()),
  };
  try {
    const st = await fs.promises.statfs(app.getPath('userData'));
    inventory.diskFreeGb = Math.round(((st.bavail * st.bsize) / 1e9) * 100) / 100;
  } catch { /* statfs недоступен на этом томе/платформе — поле честно отсутствует */ }
  return inventory;
}

// Агент-служба (EDESK_AGENT=1): тот же цикл, что у клиента-помощника, но без
// окна и рендерера. Токен машины — файл в отдельном agent-профиле (0600),
// в рендерер не попадает никогда — рендерера нет. Логи честные, в stdout.
function startAgentMode() {
  const tokenPath = path.join(app.getPath('userData'), 'agent-token.json');
  const tokenStore = {
    load() {
      try {
        const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        return typeof raw?.token === 'string' && raw.token ? raw.token : null;
      } catch { return null; } // первый старт — токена ещё нет
    },
    save(token) {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, JSON.stringify({ token }, null, 2), { mode: 0o600 });
    },
    clear() {
      try { fs.rmSync(tokenPath, { force: true }); } catch { /* не было — не страшно */ }
    },
  };
  const agentApi = createAgentApi({ baseUrl: settings.serverUrl });
  const agent = createAgent({
    api: agentApi,
    signal: () => createSignalClient({ url: new URL('/signal', settings.serverUrl).toString().replace(/^http/, 'ws') }),
    native: nativeInput,
    // Терминал (R09): оболочка поднимается от контекста службы; консольный
    // пользователь неизвестен v1 — spawnShellFor честно пометит 'service'.
    termHost: createTermHost({ platform: process.platform }),
    // pc терминала живёт в скрытом renderer-мосте: в main-процессе Electron
    // нет RTCPeerConnection. Не собрали мост — createAgent честно предупредит.
    rtc: createAgentRtc({
      // TURN терминала (R09): /rtc-config с машинным токеном. Токен читаем из
      // store в момент открытия терминала — к этому моменту машина
      // зарегистрирована; отзыв/не-200/зависание хук честно отчитает.
      fetchIceServers: createIceServersFetcher({ api: agentApi, tokenLoad: () => tokenStore.load() }),
    }),
    // Сообщение на экран машины (R08): платформа известна здесь, текст приходит
    // из heartbeat-ответа сервера. Показ не блокирует цикл (см. deliverToast).
    notify: (text) => showToast(process.platform, text),
    policy: {
      name: process.env.EDESK_AGENT_NAME || os.hostname(),
      os: process.platform,
      version: app.isPackaged ? app.getVersion() : pkg.version,
      heartbeatMs: 5000,
      backoffBaseMs: 1000,
      backoffMaxMs: 30000,
      tokenStore,
      getInventory: collectInventory, // инвентарь машин (R06) с каждым heartbeat
      log: console,
    },
  });
  app.on('before-quit', () => agent.stop());
  const code = process.env.EDESK_AGENT_CODE;
  const started = agent.start(code ? { code } : {});
  if (started.ok) {
    console.log(`[enotdesk-agent] запущен: сервер ${settings.serverUrl}, машина «${process.env.EDESK_AGENT_NAME || os.hostname()}»${code ? ' (регистрация по onboarding-коду)' : ''}`);
  } else {
    console.error(`[enotdesk-agent] не запущен: ${started.error}`);
  }
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
  if (!gotLock) return; // второй экземпляр уже уходит через app.quit()
  if (SMOKE) {
    // Скриншот главного экрана: не first-run, иначе модалки закрывают окно.
    // EDESK_SMOKE_FIRSTRUN=1 — наоборот, изолированный профиль первого запуска
    // (см. setPath выше): settings.json не создаём, чтобы firstRun был честным.
    if (process.env.EDESK_SMOKE_FIRSTRUN !== '1') {
      try {
        const p = path.join(app.getPath('userData'), 'settings.json');
        if (!fs.existsSync(p)) {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify({ serverUrl: DEFAULT_SERVER_URL }));
        }
      } catch { /* smoke: честный скриншот first-run, если записать не вышло */ }
    }
  }
  loadSettings();
  if (AGENT) {
    // Агент-служба: окно, IPC и рендерер не создаются — только цикл и логи
    startAgentMode();
    return;
  }
  registerIpc();
  createWindow();
  startUpdater();
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
      // Чип статуса сервера (B3): фактическое состояние после health-проверки рендерера
      try {
        lines.push(`SMOKE server chip: ${await win.webContents.executeJavaScript('(document.getElementById("server-chip")||{}).className + " | " + (document.getElementById("server-chip")||{}).textContent')}`);
        lines.push(`SMOKE footer: ${await win.webContents.executeJavaScript('document.getElementById("app-footer").className')}`);
      } catch (e) {
        lines.push(`SMOKE server chip: n/a (${e.message})`);
      }
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

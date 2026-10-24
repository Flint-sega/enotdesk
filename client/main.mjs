// EnotDesk main-процесс: окно/процесс, конфигурация, токены, WS-сигналинг,
// ворота нативного ввода по реальному WS-состоянию, выбор источника захвата.
// Рендереру доступен только context-isolated мост window.enot (preload.cjs).

import { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, clipboard, systemPreferences, Menu, dialog, Notification, powerSaveBlocker, safeStorage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createApi } from './lib/api.mjs';
import { createSignalClient } from './lib/signal.mjs';
import { createInputGate } from './lib/protocol.mjs';
import { createNativeInput, loadPlatformAdapter } from './lib/native-input.mjs';
import { createInputPipeline } from './lib/input-pipeline.mjs';
import { createInputArbiter } from './lib/input-arbiter.mjs';
import { INPUT_KEYS } from './lib/protocol.mjs';
import { normalizeServerUrl } from './lib/server-url.mjs';
import { resolveServerUrl, DEFAULT_SERVER_URL } from './lib/first-run.mjs';
import { safeCode, resolveInstallSource, buildInstallScript, installWorkRoot, RESULT_OK as INSTALL_RESULT_OK } from './lib/agent-install.mjs';
import { parseJoinLink, reportJoin, joinServerDecision } from './lib/join.mjs';
import { parseInviteLink } from './lib/invite-link.mjs';
import { createAgent, createAgentApi, createIceServersFetcher } from './lib/agent.mjs';
import { createAgentInputSink } from './lib/agent-input.mjs';
import { createBridgeRelay, BRIDGE_IPC } from './agent-bridge/relay.mjs';
import { createTermHost } from './lib/term.mjs';
import { showToast } from './lib/notify.mjs';
import { createMachineServices } from './lib/machine-services.mjs';
import { createOpCredentialsStore } from './lib/op-credentials.mjs';
import { operatorWindowUrls, isAllowedNavigation, probeOperatorServer, isTrustedOperatorFrame, rememberAllowed } from './lib/operator-window.mjs';
import {
  onIncoming as chatWidgetOnIncoming,
  onCollapse as chatWidgetOnCollapse,
  onExpand as chatWidgetOnExpand,
  shouldNotify as chatWidgetShouldNotify,
} from './lib/chat-widget.mjs';
import { createSessionSpawner } from './lib/session-spawn.mjs';
import { createVideoHost } from './lib/video-host.mjs';
import { inputEventToCommands } from './lib/input-translate.mjs';
import { resolveConsoleUser, noNewPrivs } from './lib/console-user.mjs';
import { UPDATE_REPO, updateFeedUrl, notifyFeedName, updateDecision, updateInstallDecision } from './lib/updater.mjs';
import { isNewerVersion } from './lib/version-check.mjs';
import { t, setLocale } from './lib/i18n.mjs';
import { createSvcDiag, envDiagSlice, maskJoinTokens } from './lib/svc-diag.mjs';
import { createKeepAwake } from './lib/keep-awake.mjs';
import { createBootLog } from './lib/boot-log.mjs';
import { linuxOzonePlatform } from './lib/ozone.mjs';
import { WEBRTC_MDNS_FEATURE, withDisabledFeature } from './lib/chromium-features.mjs';
import { gdmVideoStatus } from './lib/gdm-status.mjs';
import { applyDesktopEntry } from './lib/desktop-entry.mjs';

// Вехи старта (мс от начала процесса, performance.now): смоук печатает их строкой
// SMOKE timing — замер «до/после» оптимизаций запуска без внешних инструментов.
const bootMarks = { imports: Math.round(performance.now()) };

// Диагностика Windows-службы (W-U2): первый маркер каждого запуска процесса —
// ДО ветки службы. Если svc-ветка НЕ вошла, а эта строка в логе есть —
// Environment REG_MULTI_SZ не доставлен процессу (гипотеза №1) либо диспетчер
// отверг таблицу (№2б); различаем по следующим строкам.
const svcDiag = createSvcDiag();
// argv может нести join-ссылку с одноразовым токеном — в лог он не идёт
// (контракт svc-diag: секреты не пишутся, ревью v0.4.4)
svcDiag.write('main', `pid=${process.pid} exec="${process.execPath}" argv=${maskJoinTokens(JSON.stringify(process.argv))} env[${envDiagSlice()}]`);

// Локаль (лаба 05.10 + ревизия 06.10): принудительный --lang=en-US здесь
// ЗАПРЕЩЁН. app.getLocale() до ready возвращает пустую строку у ВСЕХ (проба на
// пинненном Electron 44.3.0), фолбэк «пустой locale → en-US» срабатывал на
// каждом запуске и убивал ru.pak. Настоящий корень краша был в составе pak'ов
// ([ru, en] без en-US.pak — см. build/electron-builder.yml): с полным набором
// pak'ов Chromium сам выбирает локаль системы и фолбэчит в en-US.

// Решения, принятые до создания boot-лога (setPath userData ниже): попадут
// в boot-лог сразу после его создания — svc-diag вне Windows глухой, а эти
// решения обязаны оставлять след на Linux (философия «окно не молчит»).
const earlyNotes = [];
// Wayland-сессии (лаба 05.10): Electron 44 переменную ELECTRON_OZONE_PLATFORM_HINT
// игнорирует и без флага падает при старте на Wayland. Явно ведём клиент через
// Xwayland (на X11-сессиях флаг no-op). Пользовательский --ozone-platform не перекрываем.
// Агент без графического сеанса — headless (см. client/lib/ozone.mjs).
try {
  if (process.platform === 'linux' && !app.commandLine.hasSwitch('ozone-platform')) {
    const ozone = linuxOzonePlatform({ agent: process.env.EDESK_AGENT === '1', env: process.env });
    app.commandLine.appendSwitch('ozone-platform', ozone);
    // без дисплея GPU-процесс не инициализируется и сыплет ошибками EGL/ANGLE —
    // окон у агента нет, ускорение ему не нужно
    if (ozone === 'headless') app.commandLine.appendSwitch('disable-gpu');
    earlyNotes.push(ozone === 'headless'
      ? 'linux: --ozone-platform=headless (агент без DISPLAY: видео и ввод недоступны)'
      : 'linux: --ozone-platform=x11 (без флага Electron 44 падает на Wayland-сессиях)');
  }
} catch { /* commandLine недоступен до ready — живём как есть */ }

// Окно брандмауэра Windows при сеансе (лаба 23.10): слушатель mDNS (UDP 5353) у
// WebRTC выключаем — см. client/lib/chromium-features.mjs. Пользовательские
// --disable-features с командной строки сохраняются.
try {
  const current = app.commandLine.getSwitchValue('disable-features');
  app.commandLine.appendSwitch('disable-features', withDisabledFeature(current, WEBRTC_MDNS_FEATURE));
  earlyNotes.push(`webrtc: --disable-features=${WEBRTC_MDNS_FEATURE} (без слушателя mDNS и окна брандмауэра)`);
} catch { /* commandLine недоступен — живём как есть */ }

// Родительский режим Windows-службы (EDESK_AGENT_SVC=1, дефект №4): процесс
// запущен SCM'ом как службу — Electron не инициализируем, работаем тонкой
// SCM-обёрткой (win-service.mjs), которая держит живым дочерний агент (тот же
// exe с EDESK_AGENT=1). Без StartServiceCtrlDispatcher SCM убивает процесс
// по 1053 (живой сеанс 28.09, W-U2). Ветка стоит ДО любого обращения к app.
if (process.env.EDESK_AGENT_SVC === '1' && process.platform === 'win32') {
  svcDiag.write('svc', 'svc-ветка вошла (EDESK_AGENT_SVC=1 доставлен)');
  try {
    const { runAsScmParent } = await import('./lib/win-service.mjs');
    await runAsScmParent({
      childArgv: process.argv.slice(1),
      childEnv: { EDESK_AGENT_SVC: '' }, // ребёнок — обычный агент, не родитель
      log: console,
      diag: svcDiag,
    });
  } catch (e) {
    console.error(`[enotdesk-svc] родительский цикл упал: ${e.message}`);
    svcDiag.write('svc', `родительский цикл упал: ${e.message}`);
    process.exit(1);
  }
  svcDiag.write('svc', 'диспетчер вернулся — служба остановлена, exit 0');
  process.exit(0); // диспетчер вернулся — служба остановлена
}
// Дошли сюда на запуске SCM'ом — значит EDESK_AGENT_SVC не доставлен: процесс
// пошёл как обычный GUI-клиент, SCM не дождётся отчёта (7009/1053).
// Ребёнок службы (EDESK_AGENT=1, SESSIONNAME=Services унаследованы) сюда тоже
// доходит штатно — это НЕ сигнал о недоставке (ревью v0.4.4).
if (process.platform === 'win32' && process.env.EDESK_AGENT !== '1' && process.argv.some((a) => /EnotDesk\.exe/i.test(a)) && process.env.SESSIONNAME === 'Services') {
  svcDiag.write('main', `ВНИМАНИЕ: svc-ветка НЕ вошла, запущены как служба. env[${envDiagSlice()}]`);
}

const SMOKE = process.env.EDESK_SMOKE === '1';
// Режим агента-службы (EDESK_AGENT=1): без окна, логи честные в stdout.
// Отдельный userData-профиль даёт агенту свой single-instance-замок, поэтому
// служба и обычный клиент работают на одной машине одновременно.
const AGENT = process.env.EDESK_AGENT === '1';
if (AGENT) app.setPath('userData', path.join(app.getPath('userData'), 'agent'));
// Установленная (NSIS в Program Files) Windows-сборка против портативной:
// electron-builder portable выставляет PORTABLE_EXECUTABLE_FILE, установочная —
// нет. Решает политику автообновления (ADR 0029: установленная обновляется
// сама после подтверждения, портативная — только уведомление).
const WIN_INSTALLED = process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;
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

// Boot-лог окна (v0.6.4, приём RustDesk): always-on файловый журнал жизни
// окна/приложения — «окно не молчит» не должно требовать маркера или живого
// stdout. svc-diag остаётся расширенной Windows-диагностикой по маркеру.
// Создаётся после финального setPath userData: агент/смоук живут в своих профилях.
const bootLog = createBootLog({ userDataDir: app.getPath('userData') });
bootLog.write('main', `pid=${process.pid} platform=${process.platform} version=${app.isPackaged ? app.getVersion() : (pkg.version ?? '?')} argv=${maskJoinTokens(JSON.stringify(process.argv))}`);
for (const note of earlyNotes.splice(0)) bootLog.write('main', note);

// Вшитый при сборке адрес сервера (R03): electron-builder extraMetadata кладёт
// ключ в package.json внутри app.asar (build/electron-builder.yml), dev-прогон
// может задать его переменной окружения. Пустая строка = «не задано».
const BAKED_SERVER_URL = pkg.ENOT_BAKED_SERVER_URL || process.env.ENOT_BAKED_SERVER_URL || null;

// ТЕСТОВЫЕ флаги (только сборки для живой приёмки, в prod-релизах отсутствуют):
// ENOT_AUTO_SESSION=1 — клиент сам создаёт сеанс при старте (ID/пароль стабильны,
// пока процесс жив; новый — при перезапуске); ENOT_AUTO_CONSENT=1 — claim
// оператора подтверждается автоматически (без диалога согласия). Включаются
// вшиванием в package.json при сборке (-c.extraMetadata.ENOT_AUTO_*).
// ВАЖНО: extraMetadata может записать значение ЧИСЛОМ (1, не '1') — сравнение
// только строкой молча ломало флаги (сборка-тест 28.09, авто-согласие не
// срабатывало); приводим к строке.
const TEST_AUTO_SESSION = String(pkg.ENOT_AUTO_SESSION) === '1';
const TEST_AUTO_CONSENT = String(pkg.ENOT_AUTO_CONSENT) === '1';
// Видео машинного сеанса без хелпера — захват getDisplayMedia в скрытом мосту:
// Linux (ADR 0031) и macOS (ADR 0038). EDESK_AGENT_VIDEO=off — выключатель.
const BRIDGE_CAPTURE = (process.platform === 'linux' || process.platform === 'darwin') && process.env.EDESK_AGENT_VIDEO !== 'off';

let win = null;
let settingsPath = null;
let settings = { serverUrl: DEFAULT_SERVER_URL, allowInsecureHttp: false, locale: null, hostId: null };

// Закреплённый ID ПК (просьба владельца, приёмка 02.10): 9 цифр, генерируется
// один раз и живёт в settings.json — переустановка/снос профиля меняет его,
// перезапуски нет. Пароль помощи — наоборот, новый на каждый запуск приложения
// (в памяти процесса). Оператор подключается по hostId; сервер находит живой
// сеанс ПК по нему (миграция v8).
function generateHostId() {
  return String(100000000 + crypto.randomInt(900000000));
}
function launchPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
let helpPassword = launchPassword();

// Один экземпляр на машину: второй запуск просто уходит, а этот получает
// second-instance и показывает окно. Заодно закрывает обход «одно окно —
// одна роль» двойным запуском портативки. EDESK_ALLOW_MULTI=1 — явный
// тестовый обход для проверки двух ролей на одном компьютере.
const allowMulti = process.env.EDESK_ALLOW_MULTI === '1';
const gotLock = allowMulti || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// One-click (R04): протокол enotdesk://join регистрирует только упакованное
// приложение. dev/SMOKE не должны мусорить в системе и перехватывать ссылки
// у установленной сборки; агент-службе (без окна и клиентских сеансов) он не нужен.
const PROTOCOL_REGISTERED = !SMOKE && !AGENT && app.isPackaged;
if (PROTOCOL_REGISTERED) app.setAsDefaultProtocolClient('enotdesk');

// Join-ссылка может прийти до готовности окна: argv на win/linux (запуск по
// ссылке) и 'open-url' на macOS до ready. Парсим отложенно — после loadSettings,
// рендереру отправляем после загрузки окна (flushPendingJoin на did-finish-load).
let pendingRawJoin = null;
let pendingJoin = null;
let pendingInviteToken = null; // строка-токен из parseInviteLink — ждёт загрузки окна
let winLoaded = false;

function applyInviteLink(raw) {
  const parsed = parseInviteLink(raw);
  if (!parsed) return false;
  pendingInviteToken = parsed.token;
  if (win && !win.isDestroyed()) {
    // Тот же гвард, что у join (приёмка 02.10): живой сеанс не прерываем и
    // свёрнутое клиентом окно не выдёргиваем; префилл уйдёт на did-finish-load.
    if (!gate.isOpen()) {
      if (win.isMinimized()) win.restore();
      win.show();
    }
    flushPendingInvite();
  }
  return true;
}

function applyJoinLink(raw) {
  if (AGENT) {
    console.log('[enotdesk] join-ссылка игнорируется: режим службы агента');
    return false;
  }
  const parsed = parseJoinLink(raw);
  if (!parsed) return false; // не join-ссылка (может быть invite) — молча, решает вызывающий
  // Чужой сервер — только после явного «да» человека в системном диалоге main-процесса
  // (рендерер и страница его не подделают); http не через loopback — только через
  // настройки (ревью безопасности 1.13, 24.10). Тот же сервер — без вопросов.
  const decision = joinServerDecision({ linkServer: parsed.server, currentServer: settings.serverUrl });
  if (decision !== 'same') {
    void confirmJoinServer(parsed, decision).then((yes) => { if (yes) startJoin(parsed); });
    return true;
  }
  startJoin(parsed);
  return true;
}

async function confirmJoinServer(parsed, decision) {
  const host = (() => { try { return new URL(parsed.server).host; } catch { return parsed.server; } })();
  const parent = win && !win.isDestroyed() ? win : undefined;
  try {
    if (decision === 'reject') {
      await dialog.showMessageBox(parent, { type: 'warning', message: t('join.serverHttpRejected', { host }), buttons: ['OK'], noLink: true });
      return false;
    }
    const r = await dialog.showMessageBox(parent, {
      type: 'question',
      message: t('join.serverConfirm', { host }),
      detail: t('join.serverConfirmDetail', { host }),
      buttons: [t('join.serverConfirmYes'), t('join.serverConfirmNo')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return r.response === 0;
  } catch {
    return false; // диалог недоступен — сервер не меняем
  }
}

function startJoin(parsed) {
  // Сервер из ссылки заменяет текущий адрес: сохраняем и пересоздаём api, затем
  // автостарт сеанса рендерером (тот же путь, что кнопка «Получить помощь»).
  // Галочку «Разрешить HTTP» ссылка не трогает: допуск для не-loopback http живёт
  // только в памяти процесса (пока жив join-сеанс), settings.json не ослабляем —
  // при следующем старте адрес пройдёт ту же валидацию, что любой сохранённый.
  // Живой сеанс нельзя осиротить: hostToken/hostSessionId живут в замыкании
  // старого api — после подмены revoke-пути видели бы новый api без токенов и
  // сеанс умирал бы host-lost вместо честного 'ended' (ревью GLM-5.3).
  if (api.hostSessionId && api.hostToken) {
    const old = api;
    old.request('session.end', { sessionId: old.hostSessionId, asHost: true }).catch(() => {});
  }
  settings.serverUrl = parsed.server;
  const saved = saveSettings();
  if (!saved.ok) console.error(`[enotdesk] join: не удалось сохранить адрес сервера: ${saved.error}`);
  api = makeApi();
  pendingJoin = { server: settings.serverUrl, token: parsed.token };
  if (win && !win.isDestroyed()) {
    // Гвард (приёмка 02.10): во время одобренного сеанса окно — рабочий инструмент
    // клиента; повторный клик join-ссылки не должен выдёргивать свёрнутое окно.
    if (!gate.isOpen()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  }
  flushPendingJoin();
}

function flushPendingInvite() {
  if (!pendingInviteToken) return;
  // Гард ДО потребления (ревью GLM-5.3: токен съедался, пока win ещё null при
  // старте, и did-finish-load получал уже пусто): не готово окно — ждём.
  if (!win || win.isDestroyed() || !winLoaded) return;
  const token = pendingInviteToken;
  pendingInviteToken = null;
  // ADR 0033: форма принятия приглашения — серверная страница /invite в окне
  // оператора; рендерер по событию только переключается на вкладку «Оператор»
  // (токен приглашения в главный рендерер не уходит).
  win.webContents.send('enot:invite-prefill');
  void openOperatorWindow({ inviteToken: token });
}

function flushPendingJoin() {
  flushPendingInvite(); // invite-ссылка едет в тот же did-finish-load
  if (!pendingJoin || !win || win.isDestroyed() || !winLoaded) return;
  sendToRenderer('enot:onJoinStart', pendingJoin);
  pendingJoin = null;
}

function processPendingJoinLink() {
  if (!pendingRawJoin || !app.isReady()) return;
  const raw = pendingRawJoin;
  pendingRawJoin = null;
  // macOS open-url приносит и join, и invite (enotdesk://invite#…): раньше
  // invite отбрасывался parseJoinLink'ом (ревью GLM-5.3)
  if (!applyJoinLink(raw)) applyInviteLink(raw);
}

app.on('second-instance', (_event, argv) => {
  if (win && !win.isDestroyed()) {
    // Та же гвард: сеанс идёт — не вырываем свёрнутое клиентом окно наверх
    if (!gate.isOpen()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  }
  // Повторный запуск с join/invite-ссылкой (win/linux) доставляется первому инстансу
  const link = (argv ?? []).find((a) => typeof a === 'string' && (parseJoinLink(a) || parseInviteLink(a)));
  if (link && !applyJoinLink(link) && !applyInviteLink(link)) {
    console.log('[enotdesk] получена некорректная ссылка — проигнорирована');
  }
});

// macOS: ссылка приходит через open-url — и до ready (сохраняем до loadSettings),
// и в живом приложении (обрабатываем сразу)
app.on('open-url', (event, url) => {
  event.preventDefault();
  pendingRawJoin = url;
  processPendingJoinLink();
});

// win/linux: ссылка в argv первого запуска (применяется после ready)
const STARTUP_JOIN_LINK = process.argv.slice(1).find((a) => typeof a === 'string' && parseJoinLink(a)) ?? null;
const STARTUP_INVITE_LINK = process.argv.slice(1).find((a) => typeof a === 'string' && parseInviteLink(a)) ?? null;

// Токены живут только здесь (main). Рендереру не возвращаются.
const hostCredentials = () => ({ hostId: settings.hostId, password: helpPassword });
const makeApi = () => createApi({ baseUrl: settings.serverUrl, hostCredentials });
let api = makeApi();
const keepAwake = createKeepAwake();

// Сигналинг и ворота ввода
let signal = null;
let heartbeatTimer = null;
let reconnectTimer = null;      // грейс-переподключение сигналинга (scheduleSignalReconnect)
let reconnectStartedAt = 0;     // начало текущего грейс-окна
let reconnectGraceMs = null;    // graceMs от сервера (ready-сообщение); null = ещё не известно
let powerBlockerId = null;      // предотвращение засыпания на время активного host-сеанса
const gate = createInputGate();
let signalRole = null;
// Таймаут бездействия (v0.4.0): нет инъекции ввода N минут в утверждённом
// сеансе хоста → предупреждение и завершение. ENOT_IDLE_MINUTES, 0 — выкл.
const IDLE_MINUTES = Math.max(0, Number(process.env.ENOT_IDLE_MINUTES ?? 30));
let lastInputAt = 0;
let idleWarned = false; // уже показывали предупреждение о скором завершении
// Арбитраж ввода мультиоператора (W-C4): активный вводчик один, решение — только
// в main (конвенция продукта). Рендерер получает события смены и сам рассылает
// grants по input-каналам операторов (каналы живут в рендерере host-стороны).
const inputArbiter = createInputArbiter({
  onChange: (activeOp, operators, participants) => sendToRenderer('enot:input-active', { claimId: activeOp, operators, participants }),
});
let droppedInputCount = 0; // события не-активных операторов (svc-diag, без тел событий)
let droppedInputLoggedAt = 0;
// Последняя ошибка загрузки koffi — попадает в честный статус ввода клиента
let lastKoffiError = null;
// koffi грузится лениво: permissions()/status() его не трогают, только старт host-сеанса
// или первый реальный ввод; нет пакета — честный инертный режим.
const nativeInput = createNativeInput({
  getAdapter: () => {
    let koffi;
    try { koffi = createRequire(import.meta.url)('koffi'); } catch (e) {
      // честная причина в статусе клиента: SAC/антивирус блокирует koffi.node,
      // portable-распаковка, ABI-несовпадение — видно без доступа к машине
      lastKoffiError = 'koffi-require-failed: ' + (e?.message ?? e);
      return { available: false, platform: process.platform, reason: lastKoffiError };
    }
    const ad = loadPlatformAdapter(koffi);
    if (!ad.available && lastKoffiError) return { ...ad, reason: lastKoffiError };
    return ad;
  },
});
// Единая проводка ввода: те же ворота и диспетчер, что проверяет тест шва
const inputPipeline = createInputPipeline({ gate, nativeInput });
let selectedSource = null; // {id, name, bounds:{width,height}, hwnd|null} физические пиксели
let windowRectAt = 0;      // момент последнего обновления rect окна-источника

function loadSettings() {
  let savedUrl = null;
  try {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    // Срезаем BOM, если файл писался Windows PowerShell 5.1 (Set-Content -Encoding
    // UTF8 ставит BOM, JSON.parse на нём падает — ревью 28.09).
    const text = fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (typeof raw.serverUrl === 'string' && raw.serverUrl) savedUrl = raw.serverUrl;
    settings.allowInsecureHttp = raw.allowInsecureHttp === true;
    settings.locale = raw.locale === 'ru' || raw.locale === 'en' ? raw.locale : null; // null = по системе
    // Закреплённый ID ПК: читаем сохранённый (иначе генерировался бы заново
    // при каждом запуске — ровно то, чего владелец не хочет)
    if (/^\d{9}$/.test(raw.hostId ?? '')) settings.hostId = raw.hostId;
  } catch {
    // первый запуск — файл настроек ещё не существует
    bootLog.write('config', `settings.json не читается (${settingsPath}) — продолжаем с дефолтами`);
  }
  // Порядок резолва (spec §первый запуск): сохранённый → enotdesk-server.txt
  // рядом с exe → вшитый при сборке → дефолт. saved и provisioned-источники
  // проходят normalizeServerUrl при каждом старте (SEC-006/SEC-007): невалидный
  // адрес честно отбрасывается до дефолта; галочка allowInsecureHttp из настроек
  // распространяется только на saved.
  const resolvedServer = resolveServerUrl({
    saved: savedUrl,
    savedAllowInsecureHttp: settings.allowInsecureHttp,
    execPath: process.execPath,
    baked: BAKED_SERVER_URL,
  });
  settings.serverUrl = resolvedServer.url;
  bootLog.write('config', `serverUrl=${resolvedServer.url} (источник: ${resolvedServer.source})`);
  setLocale(settings.locale); // строки main-процесса — тоже из словаря (null оставляет ru по умолчанию)
  // Закреплённый ID ПК: один раз генерируется и сразу сохраняется — далее
  // меняется только сносом профиля/переустановкой (просьба владельца, 02.10).
  if (!/^\d{9}$/.test(settings.hostId ?? '')) {
    settings.hostId = generateHostId();
    saveSettings();
  }
  api = makeApi();
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
// Windows: установленная сборка (NSIS) обновляется как mac/linux; портативный .exe —
// только уведомление со ссылкой на страницу релизов (update.manualBanner), ADR 0029.
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
// Активный updater (нужен в will-quit) и подтверждённое к установке обновление.
let activeUpdater = null;
let updateOnQuitVersion = null;

function startUpdater() {
  if (SMOKE || AGENT || !app.isPackaged) return;
  const feedUrl = updateFeedUrl(UPDATE_REPO);
  const notify = (payload) => sendToRenderer('enot:update', payload);
  // mac без подписи (флаг сборки ENOT_MAC_SELF_UPDATE не вшит) — только
  // уведомление: Squirrel.Mac неподписанное приложение не ставит (updater.mjs).
  const macSelfUpdate = pkg.ENOT_MAC_SELF_UPDATE === true || pkg.ENOT_MAC_SELF_UPDATE === 'true';
  const installPolicy = updateInstallDecision({ platform: process.platform, winInstalled: WIN_INSTALLED, macSelfUpdate });
  let autoUpdater = null;
  if (process.platform !== 'darwin' || macSelfUpdate) {
    try { autoUpdater = createRequire(import.meta.url)('electron-updater').autoUpdater; } catch { autoUpdater = null; }
  }
  if (!autoUpdater) {
    bootLog.write('update', `только уведомления о версиях: фид ${feedUrl}${notifyFeedName(process.platform, { macSelfUpdate })}`);
    const check = async () => {
      try {
        const res = await fetch(feedUrl + notifyFeedName(process.platform, { macSelfUpdate }));
        const d = updateDecision({ current: app.getVersion(), feedText: res.ok ? await res.text() : null });
        if (d.update) notify({ version: d.version, auto: false });
      } catch { /* баннер не критичен, следующий цикл через сутки */ }
    };
    void check();
    setInterval(check, UPDATE_CHECK_MS);
    return;
  }
  // SEC-010: mac/linux и установленная Windows-сборка качают заранее, но
  // «применить при выходе» — только после явного подтверждения человеком
  // (диалог на update-downloaded ниже). Дефолт — не ставить. Портативный
  // .exe Windows самоустановку не поддерживает (запущенный самораспаковщик
  // не заменить) — только уведомление.
  autoUpdater.autoDownload = installPolicy.autoDownload;
  autoUpdater.autoInstallOnAppQuit = false;
  // Решения updater'а (в т.ч. отказ ставить при выходе, ошибки запуска
  // установщика через elevate.exe) видны только в его логгере — у GUI-приложения
  // stdout нет (находка 10.10: подтверждённое обновление молча не ставилось,
  // и причин в следах не оставалось). Пишем в boot-лог, тег update.
  autoUpdater.logger = {
    info: (m) => bootLog.write('update', String(m)),
    warn: (m) => bootLog.write('update', String(m)),
    error: (m) => bootLog.write('update', String(m)),
    debug: () => {},
  };
  activeUpdater = autoUpdater;
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
  autoUpdater.on('update-downloaded', async (info) => {
    const version = String(info?.version ?? '');
    console.log(`[enotdesk] обновление ${version} скачано`);
    bootLog.write('update', `обновление ${version} скачано`);
    // electron-updater ставит свой quit-хук сразу ПОСЛЕ возврата из этого
    // обработчика (BaseUpdater.executeDownload: emit 'update-downloaded' →
    // addQuitHandler) и регистрирует его только если флаг autoInstallOnAppQuit
    // равен true в ЭТОТ момент. На win/linux держим false нарочно: его путь
    // «тихая установка при любом выходе с кодом 0» не отличает согласие от
    // закрытого окна — окно, закрытое при открытом диалоге, это НЕ согласие
    // (ревью 10.10; ранее U-4, приёмка 09.10: флаг только после диалога делал
    // хук и подтверждение мёртвыми). Установка в продукте одна — will-quit
    // ниже по updateOnQuitVersion, который ставится лишь явным
    // «Обновить сейчас».
    // macOS — иначе: MacUpdater не имеет quit-хука и использует тот же флаг
    // как триггер Squirrel-фетча в момент emit (MacUpdater.js: «if
    // (this.autoInstallOnAppQuit) nativeUpdater.checkForUpdates()»); false
    // убивает весь mac-путь (ревью 10.10, P2-1). Цена: Squirrel.Mac, получив
    // фетч, применит обновление при следующем перезапуске независимо от
    // диалога — жёсткое согласие на darwin технически недостижимо, диалог
    // управляет нашей немедленной установкой (quitAndInstall). Осознанное
    // отступление, mac-фаза отложена (ВМ104).
    autoUpdater.autoInstallOnAppQuit = process.platform === 'darwin';
    let confirmed = false;
    if (installPolicy.askConfirm) {
      try {
        const r = await dialog.showMessageBox({
          type: 'info',
          message: t('update.installAsk', { version }),
          buttons: [t('update.installConfirm'), t('update.installLater')],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        confirmed = r.response === 0;
      } catch { /* диалог недоступен — остаёмся на уведомлении */ }
    }
    if (!confirmed) {
      autoUpdater.autoInstallOnAppQuit = false;
      bootLog.write('update', `обновление ${version}: подтверждения нет — только уведомление`);
      notify({ version, auto: false });
      return;
    }
    // Согласие получено: установку при закрытии приложения выполняет will-quit
    // по updateOnQuitVersion. Флаг true возвращаем на случай, если будущая
    // версия electron-updater зарегистрирует хук в другой момент — тогда она
    // увидит явное согласие, а не тишину.
    updateOnQuitVersion = version;
    autoUpdater.autoInstallOnAppQuit = true;
    if (gate.isOpen()) {
      // Идёт сеанс — не рвём его кнопкой обновления: применится при следующем
      // закрытии приложения (will-quit: updateOnQuitVersion → quitAndInstall).
      bootLog.write('update', `обновление ${version}: сеанс активен — применится при закрытии`);
      notify({ version, auto: true });
      return;
    }
    // «Обновить сейчас»: честный выход (before-quit снимет сеанс), в will-quit —
    // тихая установка с перезапуском приложения (см. will-quit ниже).
    bootLog.write('update', `обновление ${version}: выход для установки`);
    app.quit();
  });
  autoUpdater.on('error', (e) => {
    const msg = String(e?.message ?? e);
    console.log(`[enotdesk] проверка обновлений не удалась: ${msg}`);
    // У GUI stdout нет: ошибки updater'а (отказ elevate/UAC при тихой установке,
    // сеть, проверка подписи) иначе невидимы вовсе (находка 10.10)
    bootLog.write('update', `ошибка updater'а: ${msg}`);
  });
  // Первый чек — через 10 с: сетевой fetch и планировщик диффа уходят с
  // критического пути старта окна (волна 0.6.19; суточный интервал и семантика
  // SEC-010 не меняются; выход раньше таймера — чека просто не было).
  const firstUpdateCheck = setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.log(`[enotdesk] проверка обновлений не удалась: ${e?.message ?? e}`));
  }, 10_000);
  if (firstUpdateCheck.unref) firstUpdateCheck.unref();
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => { /* ошибки приходят в 'error' */ }); }, UPDATE_CHECK_MS);
}

function stopSignal() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectStartedAt = 0;
  reconnectGraceMs = null;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (powerBlockerId !== null) { try { powerSaveBlocker.stop(powerBlockerId); } catch { /* уже снят */ } powerBlockerId = null; }
  if (signal) { signal.close(); signal = null; }
  gate.close();
  if (gate.needInputReset()) nativeInput.end();
  signalRole = null;
  selectedSource = null; // разрешение 'media' привязано к источнику: сеанс кончился — гейт закрыт
  nativeInput.resetAdapter(); // koffi мог быть заблокирован SAC в прошлом сеансе — пробуем снова
  inputArbiter.reset(); // операторы сеанса ушли вместе с ним (W-C4)
}

// Грейс-переподключение сигналинга (ADR 0013, живой сеанс 28.09 / W-A9): физический
// обрыв сети не даёт ни серверу close-события, ни клиенту — сокет «тихо мёртв».
// Вместо мгновенного локального конца утверждённого сеанса участник рвётся теми же
// токенами в течение грейс-окна; сервер отвечает replay'ем approved. Окно берётся
// из graceMs в ready-сообщении сервера (ENOT_GRACE_MS, по умолчанию 30 с); 0 =
// fail-closed на сервере — клиент не переподключается вовсе. При неудаче —
// честный локальный конец.
function scheduleSignalReconnect(auth, role) {
  // Окно ретраев длиннее серверного грейса (живой ретест 28.09, Wi-Fi-цикл):
  // сервер обнаруживает «тихую смерть» хоста ~20-30 с (лизинг + ping) и держит
  // грейс ещё graceMs — итого до ~graceMs*2. Клиент с окном ровно graceMs сдавался,
  // пока сервер ещё принимал бы возврат. Настоящий конец — не по таймеру, а по
  // факту: close 4003 от сервера означает «сеанса нет» → честный конец сразу.
  // graceMs=0 (ENOT_GRACE_MS=0) — серверный fail-closed: не ретраимся вовсе.
  const windowMs = reconnectGraceMs == null
    ? 30_000
    : (reconnectGraceMs > 0 ? reconnectGraceMs * 2 + 10_000 : 0);
  if (!windowMs || windowMs <= 0) {
    // сервер настроен fail-closed (ENOT_GRACE_MS=0) — грейса нет и не будет
    sendToRenderer('enot:signal', { type: 'ended', reason: 'signal-lost' });
    stopSignal();
    api.clearSessionTokens();
    return;
  }
  if (!reconnectStartedAt) reconnectStartedAt = Date.now();
  if (Date.now() - reconnectStartedAt > windowMs) {
    reconnectStartedAt = 0;
    sendToRenderer('enot:signal', { type: 'ended', reason: 'signal-lost' });
    stopSignal();
    api.clearSessionTokens();
    return;
  }
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** Math.floor((Date.now() - reconnectStartedAt) / 2000), 5000);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!signalRole) return; // stopSignal отменил переподключение
    try {
      signal = createSignalClient({ url: new URL('/signal', settings.serverUrl).toString().replace(/^http/, 'ws') });
      wireSignal(signal, auth, role);
      const ready = await signal.open(auth);
      gate.onSignal(ready);
      reconnectGraceMs = typeof ready.graceMs === 'number' ? ready.graceMs : reconnectGraceMs;
      reconnectStartedAt = 0;
      if (role === 'host') {
        heartbeatTimer = setInterval(() => signal?.heartbeat(), 5000);
        if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } catch (e) {
      if (e?.closeCode === 4003) {
        // сервер честно ответил «сеанса нет» — ретраиться бессмысленно
        reconnectStartedAt = 0;
        sendToRenderer('enot:signal', { type: 'ended', reason: 'signal-lost' });
        stopSignal();
        api.clearSessionTokens();
        return;
      }
      scheduleSignalReconnect(auth, role);
    }
  }, delay);
}

function wireSignal(client, auth, role) {
  client.onMessage((msg) => {
    gate.onSignal(msg);
    if (gate.needInputReset()) nativeInput.end();
    if (msg.type === 'claim' && msg.claimId) {
      // Тестовая сборка (ENOT_AUTO_CONSENT): claim подтверждается автоматически —
      // живая приёмка без человека у клиента. Прод-сборки флаг не содержат.
      if (TEST_AUTO_CONSENT) {
        api.request('session.decision', { sessionId: auth.sessionId, claimId: msg.claimId, allow: true })
          .catch(() => { /* ретрай придёт реплеем approved при переподключении */ });
      }
    }
    if (msg.type === 'ended' || msg.type === 'socket-closed') {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      // Сокетный обрыв при живом утверждённом сеансе — грейс-переподключение.
      // Обе роли: у оператора гейт по построению закрыт (protocol.mjs открывает
      // его только host'у), поэтому критерий — сама роль, а не gate.isOpen()
      // (ревью 28.09: иначе оператор не переподключался никогда).
      // 'ended' (решение сервера) и обрывы до согласия — как раньше, fail closed.
      if (msg.type === 'socket-closed' && (role === 'host' ? gate.isOpen() : gate.approvedOnce())) {
        // Ввод глохнет вместе с транспортом — ворота закрыты до реплея approved.
        gate.close();
        if (gate.needInputReset()) nativeInput.end();
        // rtc-reset — ТОЛЬКО host-роли: его pc пересобирается с новым offer'ом
        // (реплей approved). У оператора pc независим от сигналинга (P2P/TURN) —
        // закрыть его нечем восстановить: хост не пере-офферит из-за возврата
        // оператора, сеанс умер бы целиком (ревью v0.4.3, high).
        if (role === 'host') sendToRenderer('enot:signal', { type: 'rtc-reset' });
        scheduleSignalReconnect(auth, role);
        return;
      }
      // Разрыв сигналинга завершает сеанс локально, fail closed (R15.2/R16)
      sendToRenderer('enot:signal', { type: 'ended', reason: msg.type === 'ended' ? msg.reason : 'signal-lost' });
      stopSignal();
      api.clearSessionTokens();
      return;
    }
    sendToRenderer('enot:signal', msg);
  });
}

function startSignal(params) {
  const { role, sessionId } = params;
  if (signal && signalRole && signalRole !== role) {
    throw new Error('В этом окне уже идёт сеанс помощи. Одно окно EnotDesk работает только в одной роли — завершите текущий сеанс или используйте второе устройство.');
  }
  stopSignal();
  signalRole = role;
  lastInputAt = Date.now();
  if (role === 'host') nativeInput.load(); // подготовка нативного ввода к реальному сеансу
  signal = createSignalClient({ url: new URL('/signal', settings.serverUrl).toString().replace(/^http/, 'ws') });
  const auth = { role, sessionId, hostToken: api.hostToken };
  wireSignal(signal, auth, role);
  return signal.open(auth).then((ready) => {
    gate.onSignal(ready);
    reconnectGraceMs = typeof ready.graceMs === 'number' ? ready.graceMs : null;
    if (role === 'host') {
      heartbeatTimer = setInterval(() => signal?.heartbeat(), 5000);
      // Активный сеанс помощи: не даём ОС/Электрону усыплять приложение и душить
      // таймеры/рендер (класс зависаний из находки №9 — окно перестаёт отвечать
      // и рисовать, heartbeat'ы встают).
      if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return ready;
  }).catch((e) => {
    // неудачное открытие WS не должно зажимать роль: иначе окно навсегда
    // отвечает «уже идёт сеанс» при смене роли (ревью GLM-5.3 v0.3.0)
    stopSignal();
    throw e;
  });
}

// Захват: main валидирует выбранный источник и хранит границы дисплея (R01.2/R19i)
async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  return sources.map((s) => ({ id: s.id, name: s.name }));
}

// Масштаб координат ИНЪЕКЦИИ: SendInput (Windows) и XTest (X11) работают в
// физических пикселях, CGEvent (macOS) — в глобальных ЛОГИЧЕСКИХ поинтах:
// на Retina умножение на scaleFactor уводило инъекцию с 2× смещением
// (ревью v0.4.4, подтверждено замером CGDisplayBounds)
const coordScale = (display) => (process.platform === 'darwin' ? 1 : display.scaleFactor);

async function selectSource(id) {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => s.id === id);
  if (!src) return { ok: false, error: 'Выбранный источник больше не доступен, выберите заново' };
  const displays = screen.getAllDisplays();
  if (!displays.length) return { ok: false, error: 'Дисплеи не найдены — координаты ввода определить невозможно' };
  const display = displays.find((d) => String(d.id) === String(src.display_id)) ?? displays[0];
  // origin: смещение дисплея на виртуальном столе (не-основной монитор) — без него
  // инъекция уезжает в основной монитор (ревью GLM-5.3 v0.3.0)
  const k = coordScale(display);
  let bounds = {
    width: Math.round(display.size.width * k),
    height: Math.round(display.size.height * k),
    originX: Math.round(display.bounds.x * k),
    originY: Math.round(display.bounds.y * k),
  };
  // Окно-источник (дефект №5, живой сеанс 28.09): оператор видит окно, а координаты
  // ввода маппились на весь дисплей — клики уезжали мимо. Берём прямоугольник окна
  // по HWND из id ('window:HWND:…'); не удалось — честный откат на границы дисплея.
  if (String(src.id).startsWith('window:')) {
    const hwnd = Number(String(src.id).split(':')[1]);
    if (Number.isFinite(hwnd) && hwnd > 0) {
      const wr = nativeInput.windowRect(hwnd);
      if (wr) bounds = { width: wr.w, height: wr.h, originX: wr.x, originY: wr.y };
      selectedSource = { id: src.id, displayId: String(src.display_id ?? ''), name: src.name, bounds, hwnd };
      return { ok: true, name: src.name };
    }
  }
  selectedSource = { id: src.id, displayId: String(src.display_id ?? ''), name: src.name, bounds, hwnd: null };
  return { ok: true, name: src.name };
}

// One-click UX: согласие клиента = сразу весь основной экран, без выбора источника.
async function selectPrimaryScreen() {
  const displays = screen.getAllDisplays();
  if (!displays.length) return { ok: false, error: 'Дисплеи не найдены — координаты ввода определить невозможно' };
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => String(s.display_id) === String(primary.id))
    ?? sources.find((s) => String(s.display_id) === String(displays[0].id))
    ?? sources[0];
  if (!src) return { ok: false, error: 'Экраны для захвата не найдены' };
  const display = displays.find((d) => String(d.id) === String(src.display_id)) ?? primary;
  const k = coordScale(display);
  const bounds = {
    width: Math.round(display.size.width * k),
    height: Math.round(display.size.height * k),
    originX: Math.round(display.bounds.x * k),
    originY: Math.round(display.bounds.y * k),
  };
  selectedSource = { id: src.id, displayId: String(src.display_id ?? ''), name: src.name, bounds };
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

// ---------------------------------------------------------------------------
// Чат-виджет клиента (спека владельца 02.10): маленькое окно в углу; появляется
// при сообщении оператора, пользователь может свернуть; свёрнутому — уведомление
// ОС (троттл). Транспорт чата живёт в главном рендерере (DC), виджет — only UI:
// сообщения заходят сюда и разворачиваются в рендерер/виджет.
// ---------------------------------------------------------------------------
let chatWidgetWin = null;
let chatWidgetState = { visible: false, collapsed: false, unread: 0 };
let chatWidgetLastNotify = 0;
// loadFile асинхронен: сообщения оператора, пришедшие до did-finish-load,
// очередь дольёт после загрузки — иначе первое сообщение терялось безвозвратно
// (тот же класс гонки, что flushPendingJoin у главного окна; ревью GLM-5.3).
let chatWidgetLoaded = false;
const chatWidgetQueue = [];

function positionChatWidget(w) {
  try {
    const parent = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().workArea;
    w.setPosition(parent.x + parent.width - w.getBounds().width - 12, parent.y + parent.height - w.getBounds().height - 12);
  } catch { /* экран мог пропасть — позиция останется дефолтной */ }
}

function createChatWidget() {
  if (chatWidgetWin && !chatWidgetWin.isDestroyed()) return chatWidgetWin;
  chatWidgetWin = new BrowserWindow({
    width: 320, height: 420, minWidth: 260, minHeight: 120,
    parent: win && !win.isDestroyed() ? win : undefined,
    show: false, frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    title: 'EnotDesk — чат',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'renderer', 'chat-widget-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, spellcheck: false,
    },
  });
  positionChatWidget(chatWidgetWin);
  chatWidgetWin.on('closed', () => { chatWidgetWin = null; chatWidgetLoaded = false; });
  chatWidgetWin.webContents.once('did-finish-load', () => {
    chatWidgetLoaded = true;
    const queued = chatWidgetQueue.splice(0);
    for (const m of queued) chatWidgetWin?.webContents.send('enot:chat-widget-msg', m);
    chatWidgetPushState();
  });
  chatWidgetWin.loadFile(path.join(import.meta.dirname, 'renderer', 'chat-widget.html'));
  return chatWidgetWin;
}

function destroyChatWidget() {
  if (chatWidgetWin && !chatWidgetWin.isDestroyed()) chatWidgetWin.destroy();
  chatWidgetWin = null;
  chatWidgetLoaded = false;
  chatWidgetQueue.length = 0;
  chatWidgetState = { visible: false, collapsed: false, unread: 0 };
}

function chatWidgetPushState() {
  if (chatWidgetWin && !chatWidgetWin.isDestroyed() && chatWidgetLoaded) {
    chatWidgetWin.webContents.send('enot:chat-widget-state', chatWidgetState);
  }
}

function pushChatWidgetMsg(payload) {
  if (chatWidgetWin && !chatWidgetWin.isDestroyed() && chatWidgetLoaded) {
    chatWidgetWin.webContents.send('enot:chat-widget-msg', payload);
  } else {
    chatWidgetQueue.push(payload);
  }
}

function chatWidgetIncoming(text) {
  if (!api.hostSessionId) return; // виджет сессионный: вне сеанса транспорта нет
  chatWidgetState = chatWidgetOnIncoming(chatWidgetState);
  const w = createChatWidget();
  if (!w.isVisible()) w.showInactive();
  positionChatWidget(w);
  pushChatWidgetMsg({ who: 'operator', text: String(text).slice(0, 2000) });
  chatWidgetPushState();
  // Троттл из lib (юнит-тесты гоняют именно её): уведомляем только в свёрнутом виде.
  const now = Date.now();
  if (chatWidgetShouldNotify({ collapsed: chatWidgetState.collapsed, lastNotifiedAt: chatWidgetLastNotify, nowMs: now })) {
    chatWidgetLastNotify = now;
    try { new Notification({ title: 'EnotDesk', body: t('notify.chat', {}) }).show(); } catch { /* нет уведомлений — не критично */ }
  }
}

// ---------- окно оператора (ADR 0033, этап 2) ----------
// Desktop-оператор = браузерная программа /operator С СЕРВЕРА в отдельном окне.
// Закалка: sandbox + contextIsolation, своя сессия в памяти (partition без
// persist: cookie и storage не переживают выход — модель SEC-008 браузерного
// оператора), навигация только внутри origin сервера, новые окна запрещены,
// из разрешений — только запись буфера и полноэкранный режим. Мост preload —
// только «запомнить меня» (operator-preload.cjs).
let operatorWin = null;
let operatorOrigin = null;     // origin сервера, чью страницу показывает окно
let operatorCredsLoaded = false; // креды отдаются странице один раз за загрузку
const OPERATOR_PARTITION = 'enot-operator';
let operatorSessionReady = false;

function operatorStatus(payload) { sendToRenderer('enot:operator-window', payload); }

function prepareOperatorSession() {
  const ses = session.fromPartition(OPERATOR_PARTITION);
  if (operatorSessionReady) return ses;
  operatorSessionReady = true;
  const allowed = (permission) => permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  // захват экрана оператору не нужен — отказ без вопросов
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  // CSV-экспорт и принятые файлы: системный диалог «Сохранить как», как в главном окне
  ses.on('will-download', (_event, item) => {
    const parent = operatorWin && !operatorWin.isDestroyed() ? operatorWin : null;
    if (!parent) { item.cancel(); return; }
    dialog.showSaveDialog(parent, { title: item.getFilename(), defaultPath: item.getFilename() })
      .then(({ canceled, filePath }) => {
        if (!canceled && filePath) item.setSavePath(filePath);
        else item.cancel();
      });
  });
  return ses;
}

function closeOperatorWindow() {
  if (operatorWin && !operatorWin.isDestroyed()) operatorWin.destroy();
  operatorWin = null;
  operatorOrigin = null;
}

// Открыть (или поднять) окно оператора. inviteToken — deep-link
// enotdesk://invite#token=…: окно открывает серверную форму принятия.
async function openOperatorWindow({ inviteToken } = {}) {
  const urls = operatorWindowUrls(settings.serverUrl);
  if (!urls) {
    const res = { ok: false, reason: 'server-unreachable' };
    operatorStatus({ state: 'error', ...res });
    return res;
  }
  if (operatorWin && !operatorWin.isDestroyed() && operatorOrigin === urls.origin) {
    if (inviteToken) operatorWin.loadURL(urls.invite(inviteToken));
    if (operatorWin.isMinimized()) operatorWin.restore();
    operatorWin.focus();
    operatorStatus({ state: 'open' });
    return { ok: true };
  }
  closeOperatorWindow(); // адрес сервера сменился — старое окно не держим
  operatorStatus({ state: 'checking' });
  const probe = await probeOperatorServer(settings.serverUrl);
  bootLog.write('operator', `проба сервера: ${probe.ok ? 'ok' : probe.reason}${probe.version ? ` (версия ${probe.version})` : ''}`);
  if (!probe.ok) {
    operatorStatus({ state: 'error', ...probe });
    return probe;
  }
  const ses = prepareOperatorSession();
  // язык страницы — язык приложения (сервер выбирает его по Accept-Language)
  const lang = settings.locale === 'en' ? 'en-US,en' : (settings.locale === 'ru' ? 'ru-RU,ru' : app.getLocale());
  ses.setUserAgent(ses.getUserAgent(), lang);
  operatorOrigin = urls.origin;
  operatorCredsLoaded = false;
  operatorWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    title: 'EnotDesk',
    backgroundColor: '#0B1020',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'operator-preload.cjs'),
      partition: OPERATOR_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  const wc = operatorWin.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNav = (e, url) => { if (!isAllowedNavigation(url, operatorOrigin)) e.preventDefault(); };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // новая загрузка страницы — новая разовая выдача сохранённых кредов
  wc.on('did-navigate', () => { operatorCredsLoaded = false; });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 ABORTED: отменённая нами навигация
    bootLog.write('operator', `did-fail-load ${code} ${desc}`);
    operatorStatus({ state: 'error', reason: 'server-unreachable' });
    closeOperatorWindow();
  });
  wc.on('render-process-gone', (_e, details) => {
    bootLog.write('operator', `render-process-gone ${JSON.stringify(details)}`);
  });
  wc.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { label: t('menu.copy'), role: 'copy', enabled: params.editFlags.canCopy },
      { label: t('menu.paste'), role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: t('menu.selectAll'), role: 'selectAll' },
    ]).popup({ window: operatorWin });
  });
  const thisWin = operatorWin;
  operatorWin.on('closed', () => {
    if (operatorWin === thisWin) { operatorWin = null; operatorOrigin = null; }
    operatorStatus({ state: 'closed' });
  });
  operatorWin.loadURL(inviteToken ? urls.invite(inviteToken) : urls.operator).catch(() => { /* did-fail-load уже сообщил */ });
  operatorStatus({ state: 'open', version: probe.version });
  return { ok: true, version: probe.version };
}

function registerIpc() {
  const fromOurRenderer = (e) => win !== null && !win.isDestroyed() && e.sender === win.webContents;
  const guard = (e) => {
    if (!fromOurRenderer(e)) throw new Error('Доступ запрещён: недоверенный отправитель');
  };

  const fromWidget = (e) => chatWidgetWin !== null && !chatWidgetWin.isDestroyed() && e.sender === chatWidgetWin.webContents;
  // Гварды по НАЗНАЧЕНИЮ канала (ревью GLM-5.3: были перепутаны местами и оба
  // направления молча дропались). 'msg' — сообщения оператора из главного
  // рендерера (владельца DC-чата) в виджет; 'out' — ответ клиента из виджета
  // обратно в рендерер.
  ipcMain.on('enot:chat-widget-msg', (e, text) => {
    if (!fromOurRenderer(e) || typeof text !== 'string' || !text) return;
    chatWidgetIncoming(text);
  });
  ipcMain.on('enot:chat-widget-out', (e, text) => {
    if (!fromWidget(e) || typeof text !== 'string' || !text) return;
    const clean = text.slice(0, 2000);
    // ответ клиента → в DC чата через главный рендерер (он владеет state.dcs.chat)
    if (win && !win.isDestroyed()) win.webContents.send('enot:chat-widget-out', clean);
    // эхо в виджет как «you» (без unread и без уведомления)
    pushChatWidgetMsg({ who: 'you', text: clean });
  });
  ipcMain.on('enot:chat-widget-toggle', (e) => {
    if (!fromWidget(e)) return;
    chatWidgetState = chatWidgetState.collapsed ? chatWidgetOnExpand() : chatWidgetOnCollapse(chatWidgetState);
    const w = chatWidgetWin;
    if (w && !w.isDestroyed()) {
      // 44px «полоска» ниже дефолтного minHeight: Electron клампит setBounds
      // минимумом окна — ослабляем на время сворачивания (ревью GLM-5.3).
      w.setMinimumSize(260, chatWidgetState.collapsed ? 44 : 120);
      const b = w.getBounds();
      w.setBounds({ ...b, height: chatWidgetState.collapsed ? 44 : 420 });
    }
    chatWidgetPushState();
  });
  ipcMain.on('enot:chat-widget-close', (e) => {
    if (!fromWidget(e)) return;
    chatWidgetState = { visible: false, collapsed: false, unread: 0 };
    destroyChatWidget();
  });
  ipcMain.on('enot:chat-widget-end', (e) => {
    if (!fromOurRenderer(e)) return; // сеанс завершён — виджет больше не нужен
    destroyChatWidget();
  });

  ipcMain.handle('enot:getSettings', (e) => { guard(e); return { serverUrl: settings.serverUrl, allowInsecureHttp: settings.allowInsecureHttp, locale: settings.locale, firstRun: !fs.existsSync(settingsPath), version: app.isPackaged ? app.getVersion() : pkg.version }; });

  // «Запомнить меня» на входе оператора: пароль хранится ТОЛЬКО шифротекстом
  // safeStorage (DPAPI/Keychain/keyring; Linux basic_text = как «нет») в файле
  // 0600 профиля пользователя; шифрование недоступно — рендереру честно
  // отказываем, чекбокс скрыт, протухший файл стираем (ревью 10.10 P1-1/P2-3).
  const opCreds = createOpCredentialsStore({
    readText: async (p) => {
      const st = await fs.promises.stat(p);
      if (st.size > 4096) throw new Error('too_large'); // чужой гигантский файл — не читаем (P2-1)
      return fs.promises.readFile(p, 'utf8');
    },
    writeText: (p, data) => fs.promises.writeFile(p, data, { mode: 0o600 }),
    unlink: (p) => fs.promises.unlink(p),
    exists: (p) => fs.existsSync(p),
    safeStorage,
    file: path.join(app.getPath('userData'), 'op-credentials.json'),
  });
  // Хранилищем пользуется только окно оператора (мост enot-op:*, ниже); главный
  // рендерер к кредам доступа не имеет (ADR 0033, этап 3).
  // К хранилищу ОС — только по запросу окна оператора, не на старте: на Linux
  // safeStorage идёт в gnome-keyring синхронно, и при запертой или ещё не
  // созданной связке ключей главный процесс ждал ответа на окно GNOME «пароль
  // для связки» — клиент помощи не открывал окно вовсе (стенд, 22.10).
  let opCredsChecked = false;
  const opCredsAvailable = async () => {
    const ok = await opCreds.available();
    if (!opCredsChecked) {
      opCredsChecked = true;
      if (!ok) await opCreds.clear(); // протухший файл при недоступном шифровании
    }
    return ok;
  };

  // Окно оператора (ADR 0033, этап 2): главное окно просит открыть программу
  // оператора с сервера; ответ {ok, reason?, version?}, статус — enot:operator-window.
  ipcMain.handle('enot:openOperatorWindow', (e) => { guard(e); return openOperatorWindow(); });
  // Мост «запомнить меня» окна оператора: только главный фрейм окна оператора со
  // страницы origin сервера; креды привязаны к этому origin; выдача — один раз за
  // загрузку страницы и не после входа (save/clear вызывает страница после входа).
  const operatorGuard = (e) => {
    const ok = isTrustedOperatorFrame({
      isOperatorWindow: operatorWin !== null && !operatorWin.isDestroyed() && e.sender === operatorWin.webContents,
      isMainFrame: e.senderFrame != null && e.senderFrame === e.sender.mainFrame,
      frameUrl: e.senderFrame?.url,
      origin: operatorOrigin,
    });
    if (!ok) throw new Error('Доступ запрещён: недоверенный отправитель');
  };
  ipcMain.handle('enot-op:credentials-available', (e) => {
    operatorGuard(e);
    return rememberAllowed(operatorOrigin) ? opCredsAvailable() : false;
  });
  ipcMain.handle('enot-op:credentials-load', (e) => {
    operatorGuard(e);
    if (operatorCredsLoaded || !rememberAllowed(operatorOrigin)) return null;
    operatorCredsLoaded = true;
    return opCreds.load({ origin: operatorOrigin });
  });
  ipcMain.handle('enot-op:credentials-save', (e, creds) => {
    operatorGuard(e);
    operatorCredsLoaded = true;
    if (!rememberAllowed(operatorOrigin)) return { ok: false, reason: 'insecure-origin' };
    const { login, password } = creds && typeof creds === 'object' ? creds : {};
    return opCreds.save({ login, password, origin: operatorOrigin });
  });
  ipcMain.handle('enot-op:credentials-clear', (e) => { operatorGuard(e); operatorCredsLoaded = true; return opCreds.clear(); });

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
    api = makeApi();
    // окно оператора показывает страницу прежнего сервера — закрываем
    if (operatorOrigin && operatorWindowUrls(settings.serverUrl)?.origin !== operatorOrigin) closeOperatorWindow();
    return { ...saved, serverUrl: settings.serverUrl };
  });

  // Установка машины (службы агента) из работающего клиента (ADR 0029).
  // Привилегированную часть выполняет сам человек в окне UAC (Start-Process
  // -Verb RunAs): main только скачивает setup.exe для портативки, генерирует
  // install-скрипт (чистый генератор — client/lib/agent-install.mjs, тесты
  // agent-install.test.mjs), ждёт и разбирает журнал. Только упакованное
  // приложение, только Windows.
  ipcMain.handle('enot:installAgentService', async (e, payload = {}) => {
    guard(e);
    if (process.platform !== 'win32' || !app.isPackaged) return { ok: false, reason: 'unsupported' };
    const code = safeCode(payload?.code);
    if (!code) return { ok: false, reason: 'bad-code' };
    const src = resolveInstallSource({ execPath: process.execPath, portableFile: process.env.PORTABLE_EXECUTABLE_FILE ?? '' });
    if (!src) return { ok: false, reason: 'unsupported' };
    // Отдельный временный каталог: предсказуемые имена в общем %TEMP% —
    // конфликт двух установок и окно TOCTOU (ревью ADR 0029 P2-1).
    // ASCII-путь: с кириллицей в имени пользователя cmd не находил свои файлы (ревью 1.13)
    const workRoot = installWorkRoot({ tempDir: app.getPath('temp'), systemRoot: process.env.SystemRoot });
    const work = fs.mkdtempSync(path.join(workRoot, 'enot-install-'));
    const scriptPath = path.join(work, 'install.cmd');
    const runPath = path.join(work, 'run.cmd');
    const logPath = path.join(work, 'install.log');
    try {
      let setupExe = '';
      if (src.mode === 'download') {
        if (!src.setupUrl) return { ok: false, reason: 'unsupported' };
        // Установщик пойдёт под UAC — сверяем sha256 с checksums того же фида
        // (ревью ADR 0029 P2-2: без проверки 'latest' позволяет и подмену, и даунгрейд).
        const sumsUrl = src.setupUrl.replace(/EnotDesk-win-x64-setup\.exe$/, 'checksums-sha256.txt');
        const sums = await (await fetch(sumsUrl, { redirect: 'follow' })).text();
        const expect = /([a-f0-9]{64})\s+\*?EnotDesk-win-x64-setup\.exe/i.exec(sums)?.[1]?.toLowerCase();
        if (!expect) return { ok: false, reason: 'setup-verify' };
        const res = await fetch(src.setupUrl, { redirect: 'follow' });
        if (!res.ok) throw new Error(`setup HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > 600_000_000) throw new Error('setup too big');
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1_000_000) throw new Error('setup too small');
        if (crypto.createHash('sha256').update(buf).digest('hex') !== expect) return { ok: false, reason: 'setup-verify' };
        setupExe = path.join(work, 'EnotDesk-win-x64-setup.exe');
        fs.writeFileSync(setupExe, buf);
      }
      const script = buildInstallScript({
        serverUrl: settings.serverUrl,
        code,
        agentName: os.hostname(),
        appExe: src.appExe ?? '',
        setupExe,
      });
      // Обёртка уводит вывод elevated-скрипта в журнал: у cmd редирект живёт
      // внутри call, поэтому PowerShell-команда остаётся без вложенных кавычек.
      fs.writeFileSync(scriptPath, script);
      fs.writeFileSync(runPath, `@echo off\r\ncall "${scriptPath}" > "${logPath}" 2>&1\r\n`);
      const ps = `Start-Process -FilePath '${runPath.replace(/'/g, "''")}' -Verb RunAs -Wait`;
      let psExit = null;
      await new Promise((resolve) => {
        // 900 с: бюджет скрипта ~180 с (setup-ожидание) + установка + 20 с
        // (рестарт службы) + 120 с (регистрация) + запас на медленный диск;
        // таймаут убивает powershell, но не elevated-cmd — см. ADR 0029.
        const child = nodeSpawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, timeout: 900_000 });
        child.on('close', (c) => { psExit = c; resolve(); });
        child.on('error', () => resolve());
      });
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-4000) : '';
      // Пустой журнал — установщик не дошёл до редиректа: отказ в UAC или
      // системная ошибка запуска (честно отличаем от провала самой установки,
      // ревью ADR 0029 P1-3); код выхода обёртки прикладываем для диагностики.
      if (!log) return { ok: false, reason: 'no-log', log: `powershell exit ${psExit ?? '?'}` };
      if (log.trimEnd().endsWith(INSTALL_RESULT_OK)) return { ok: true };
      return { ok: false, reason: 'install-failed', log };
    } catch (err) {
      return { ok: false, reason: 'install-failed', log: String(err?.message ?? err) };
    } finally {
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* уже нет */ }
    }
  });

  ipcMain.handle('enot:request', async (e, operation, payload) => {
    guard(e);
    if (typeof operation !== 'string') throw new Error('Некорректная операция');
    if (payload !== undefined && (payload === null || typeof payload !== 'object')) throw new Error('Некорректные данные запроса');
    const result = await api.request(operation, payload ?? {});
    // Keep-awake на время помощи (тёмный экран/замороженный ввод на ночной
    // машине — приёмка 02.10): дисплей и система бодрствуют от создания сеанса
    // до его завершения; на не-Windows/без koffi — no-op внутри либы.
    if (operation === 'session.create' && result.status === 201) keepAwake.acquire();
    // Тестовая сборка (ENOT_AUTO_SESSION): ID и пароль сеанса — в файл профиля,
    // чтобы автопрогон приёмки на стенде подключался без ручного ввода (ADR 0037).
    // В prod-релизах флага нет — файла нет.
    if (TEST_AUTO_SESSION && operation === 'session.create' && result.status === 201) {
      try {
        const report = { hostId: settings.hostId, sessionId: result.body?.sessionId ?? null, password: helpPassword, at: new Date().toISOString() };
        fs.writeFileSync(path.join(app.getPath('userData'), 'auto-session.json'), JSON.stringify(report), { mode: 0o600 });
      } catch (err) { bootLog.write('main', `auto-session: отчёт не записан: ${err?.message ?? err}`); }
    }
    if (operation === 'session.end') keepAwake.release();
    // Ошибки HTTP приходят рендереру как {status, body:{error}} — честно, без выдуманных данных
    return result;
  });

  ipcMain.handle('enot:openSignal', (e, params) => {
    guard(e);
    // Окно ведёт сигналинг только клиента помощи: операторская сторона —
    // программа оператора с сервера в своём окне (ADR 0033, этап 3)
    if (!params || typeof params !== 'object' || params.role !== 'host') {
      throw new Error('Некорректные параметры сигналинга');
    }
    return startSignal(params);
  });

  // Статус показа экрана клиента помощи операторам — тем же сообщением, что статус
  // видео машины (machine-video): ждём системное окно Wayland, захват пошёл,
  // захват не удался. Только allowlist состояний и причин.
  ipcMain.handle('enot:captureStatus', (e, status) => {
    guard(e);
    const st = ['connecting', 'running', 'error'].includes(status?.state) ? status.state : null;
    const reason = ['wayland-portal', 'capture-denied'].includes(status?.reason) ? status.reason : '';
    if (!st || !signal) return false;
    try { signal.sendMachineVideo({ state: st, ...(reason ? { reason } : {}) }); return true; } catch { return false; }
  });

  ipcMain.handle('enot:sendSignal', (e, message) => {
    guard(e);
    if (!signal) throw new Error('Сигнальное соединение закрыто');
    signal.sendSignal(message); // валидация ограниченного протокола внутри
    return { ok: true };
  });

  // file-link (v0.4.0): ссылка на файл в резервном релее counterpart-стороне
  ipcMain.handle('enot:sendFileLink', (e, link) => {
    guard(e);
    if (!signal) throw new Error('Сигнальное соединение закрыто');
    signal.sendFileLink(link ?? {});
    return { ok: true };
  });

  // Загрузка файла в резервный релей сервера: авторизация hostToken (не утекает
  // в рендерер); ответ {url, name, size} рендерер отправляет как file-link.
  ipcMain.handle('enot:relayUpload', async (e, { name, buffer }) => {
    guard(e);
    if (!api || !api.hostToken) throw new Error('Нет активного сеанса');
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!bytes.length || bytes.length > 200 * 1024 * 1024) {
      throw new Error('Некорректный файл');
    }
    const base = new URL('/api/v1/relay', settings.serverUrl);
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api.hostToken}`,
        'content-type': 'application/octet-stream',
        'x-file-name': String(name ?? 'file').slice(0, 200),
      },
      body: bytes,
    });
    const body = await res.json().catch(() => null);
    if (res.status !== 201 || !body?.url) throw new Error(body?.error?.message ?? 'Релей недоступен');
    return { url: body.url, name: body.name ?? name, size: body.size ?? bytes.length };
  });

  ipcMain.handle('enot:closeSignal', (e) => { guard(e); stopSignal(); return { ok: true }; });

  ipcMain.handle('enot:sources', async (e) => { guard(e); return { items: await listSources() }; });

  ipcMain.handle('enot:selectSource', async (e, id) => {
    guard(e);
    if (typeof id !== 'string') throw new Error('Некорректный источник');
    return selectSource(id);
  });

  ipcMain.handle('enot:selectPrimaryScreen', async (e) => { guard(e); return selectPrimaryScreen(); });

  ipcMain.handle('enot:permissions', (e) => { guard(e); return permissionsReport(); });

  ipcMain.handle('enot:input', (e, ev, opKey = 'primary') => {
    guard(e);
    // Арбитраж (W-C4): ввод не-активного оператора отбрасывается ДО idle-таймера
    // и инъекции — таймер простоя считает только разрешённые события
    if (!inputArbiter.isAllowed(typeof opKey === 'string' && opKey ? opKey : 'primary')) {
      droppedInputCount += 1;
      const now = Date.now();
      if (now - droppedInputLoggedAt > 5000) { // счётчик без тел событий (в вводе бывают пароли)
        droppedInputLoggedAt = now;
        svcDiag.write('input', `отброшено событий не-активных операторов: ${droppedInputCount}`);
      }
      return { ok: false, reason: 'input-not-granted' };
    }
    lastInputAt = Date.now(); // разрешённая активность оператора сбрасывает таймер простоя
    // Ворота и диспетчер — main, по реальному WS-состоянию (см. input-pipeline.mjs)
    if (!selectedSource) return { ok: false, reason: 'no-source' };
    // Окно-источник живёт: его двигают/ресайзят/максимизируют во время сеанса —
    // актуализируем прямоугольник (не чаще раза в 500 мс), иначе ввод уходит по
    // устаревшему rect (ревью 28.09).
    if (selectedSource.hwnd) {
      const now = Date.now();
      if (now - windowRectAt > 500) {
        windowRectAt = now;
        const wr = nativeInput.windowRect(selectedSource.hwnd);
        if (wr) selectedSource.bounds = { width: wr.w, height: wr.h, originX: wr.x, originY: wr.y };
      }
    }
    return inputPipeline.handle(ev, selectedSource.bounds);
  });

  // Арбитраж ввода (W-C4): claim/release — от оператора по его input-каналу,
  // attach/drop — от рендерера host-стороны (operator-joined/left)
  ipcMain.handle('enot:input-claim', (e, opKey) => {
    guard(e);
    if (typeof opKey !== 'string' || !opKey) throw new Error('Некорректный оператор');
    inputArbiter.claim(opKey);
    return { ok: true };
  });
  ipcMain.handle('enot:input-release', (e, opKey) => {
    guard(e);
    if (typeof opKey !== 'string' || !opKey) throw new Error('Некорректный оператор');
    inputArbiter.release(opKey);
    return { ok: true };
  });
  // ADR 0035: передача ввода конкретному участнику и «только смотреть» —
  // тоже от оператора по его input-каналу; решает арбитр в main
  ipcMain.handle('enot:input-pass', (e, opKey, to) => {
    guard(e);
    if (typeof opKey !== 'string' || !opKey || typeof to !== 'string' || !to || to.length > 128) throw new Error('Некорректный оператор');
    inputArbiter.pass(opKey, to);
    return { ok: true };
  });
  ipcMain.handle('enot:input-view-only', (e, opKey, on) => {
    guard(e);
    if (typeof opKey !== 'string' || !opKey || typeof on !== 'boolean') throw new Error('Некорректный оператор');
    inputArbiter.setViewOnly(opKey, on);
    return { ok: true };
  });
  ipcMain.handle('enot:input-attach', (e, claimId) => {
    guard(e);
    if (typeof claimId !== 'string' || !claimId) throw new Error('Некорректный оператор');
    inputArbiter.attach(claimId);
    return { ok: true };
  });
  ipcMain.handle('enot:input-drop', (e, claimId) => {
    guard(e);
    if (typeof claimId !== 'string' || !claimId) throw new Error('Некорректный оператор');
    inputArbiter.drop(claimId);
    return { ok: true };
  });

  ipcMain.handle('enot:copy', (e, text) => {
    guard(e);
    if (typeof text !== 'string') return { ok: false, error: 'Некорректный текст' };
    try { clipboard.writeText(text); return { ok: true }; } catch (err) {
      return { ok: false, error: `Буфер обмена недоступен: ${err.message}` };
    }
  });

  // One-click (R04): репорт {sessionId,password} на hub идёт из main — CSP
  // рендерера (connect-src 'self' file:) не пускает fetch на чужой origin.
  // reportJoin сам валидирует вход и шлёт строго {sessionId,password};
  // hostToken не покидает main (interfaces.md).
  ipcMain.handle('enot:joinReport', (e, server, token, creds) => {
    guard(e);
    return reportJoin(server, token, creds ?? {}, fetch);
  });

  // Версия клиента в рендерер: живая диагностика (текст ошибки захвата несёт её,
  // чтобы со скриншота было видно, какая сборка установлена). В dev Electron
  // отдаёт свою версию — показываем версию продукта, как в getSettings.
  ipcMain.handle('enot:appVersion', (e) => { guard(e); return app.isPackaged ? app.getVersion() : (pkg.version ?? '?'); });
}

function createWindow() {
  bootLog.write('win', 'создаётся главное окно');
  win = new BrowserWindow({
    // Компактное окно клиента помощи: весь путь (кнопка → ID/пароль → согласие)
    // помещается без прокрутки; размер — по содержимому, без рамки ОС
    width: 760,
    height: 580,
    useContentSize: true,
    minWidth: 360,
    minHeight: 480,
    title: 'EnotDesk',
    backgroundColor: '#020D0B',
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

  // Запросы разрешений (SEC-004, одна default-session на все окна, включая мост):
  // разрешены запись санитизированного буфера, полноэкранный режим и захват
  // экрана — но только когда источник уже выбран в рамках сеанса
  // (selectedSource ставит selectPrimaryScreen/selectSource).
  // ВАЖНО (ревью GLM-5.3, подтверждено прогонами и исходниками Electron 44):
  // getDisplayMedia приходит сюда со строкой 'media' (общий медиа-путь
  // RequestMediaAccessPermission), а не 'display-capture' — та строка живёт
  // только в Permissions API (navigator.permissions.query). Без ветки 'media'
  // хендлер отклонял захват: NotAllowedError на любой ОС, всегда.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media' || permission === 'display-capture') {
      // 'media' без уточнения покрывает и getUserMedia: разрешаем только видео-захват
      const mt = details?.mediaTypes;
      if (Array.isArray(mt) && mt.some((t) => t !== 'video')) return callback(false);
      return callback(Boolean(selectedSource));
    }
    callback(permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
  });
  // Синхронные проверки (navigator.permissions.query и подобные пути) — та же политика
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin) => {
    if (permission === 'media' || permission === 'display-capture') {
      return Boolean(selectedSource);
    }
    return permission === 'clipboard-sanitized-write' || permission === 'fullscreen';
  });

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

  // Захват через задокументированный путь: setDisplayMediaRequestHandler.
  // Сопоставление источника устойчиво к нестабильности id на Windows:
  // id → display_id → (для экрана) первый доступный экран.
  session.defaultSession.setDisplayMediaRequestHandler((_opts, callback) => {
    if (!selectedSource) {
      callback({}); // рендерер получит отказ и покажет честную ошибку
      return;
    }
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const byId = sources.find((s) => s.id === selectedSource.id);
      const byDisplay = selectedSource.displayId
        ? sources.find((s) => String(s.display_id ?? '') === selectedSource.displayId)
        : null;
      const src = byId ?? byDisplay ?? sources[0];
      if (src) callback({ video: src });
      else { selectedSource = null; callback({}); }
    });
  }, { useSystemPicker: false });

  // Принятые файлы: системный диалог «Сохранить как» (решение владельца, v0.4.0) —
  // получатель сам выбирает место; отмена диалога отменяет загрузку.
  session.defaultSession.on('will-download', (_event, item, _webContents) => {
    if (win) {
      dialog.showSaveDialog(win, {
        title: item.getFilename(),
        defaultPath: item.getFilename(),
      }).then(({ canceled, filePath }) => {
        if (!canceled && filePath) item.setSavePath(filePath);
        else item.cancel();
      });
    } else {
      item.cancel();
    }
  });

  win.on('minimize', () => { svcDiag.write('win', 'minimize'); });
  win.on('restore', () => { svcDiag.write('win', 'restore'); });
  win.on('closed', () => { win = null; winLoaded = false; closeOperatorWindow(); });
  // «Окно не молчит» (лаба 05.10): packaged-отказ рендерера раньше был немым —
  // пустое окно без единой строки в логах, дефект искали неделю. Все жизненные
  // события главного окна идут в svc-diag; краш рендерера — один честный
  // автоперезапуск страницы.
  let rendererReloaded = false;
  win.webContents.on('render-process-gone', (e, details) => {
    svcDiag.write('win', `render-process-gone ${JSON.stringify(details)}`);
    bootLog.write('win', `render-process-gone ${JSON.stringify(details)}`);
    console.error('render-process-gone:', JSON.stringify(details));
    if (!rendererReloaded && !win.isDestroyed()) {
      rendererReloaded = true;
      svcDiag.write('win', 'auto-reload после краша рендерера');
      bootLog.write('win', 'auto-reload после краша рендерера');
      win.webContents.reload();
    }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain) return; // ошибки подресурсов не убивают страницу
    svcDiag.write('win', `did-fail-load ${code} ${desc} ${url}`);
    bootLog.write('win', `did-fail-load ${code} ${desc} ${url}`);
    console.error('did-fail-load:', code, desc, url);
  });
  win.webContents.on('preload-error', (e, p, err) => {
    svcDiag.write('win', `preload-error ${p} ${err}`);
    bootLog.write('win', `preload-error ${p} ${err}`);
    console.error('preload-error:', p, err);
  });
  win.webContents.on('unresponsive', () => { svcDiag.write('win', 'unresponsive'); bootLog.write('win', 'unresponsive'); });
  win.webContents.on('responsive', () => { svcDiag.write('win', 'responsive'); bootLog.write('win', 'responsive'); });
  // Join-ссылка, пришедшая до загрузки страницы, уходит рендереру, когда
  // слушатели (client-view) уже установлены (R04)
  win.webContents.on('did-finish-load', () => {
    winLoaded = true;
    bootMarks.loaded ??= Math.round(performance.now());
    bootLog.write('win', 'страница загружена');
    flushPendingJoin();
    // Тестовая сборка (ENOT_AUTO_SESSION): сеанс создаётся сам при старте —
    // ID/пароль стабильны, пока процесс жив (рендерер гвардит двойной старт),
    // новые — при перезапуске. Рендерер не делает join-report без server/token.
    if (TEST_AUTO_SESSION) sendToRenderer('enot:onJoinStart', {});
  });
  win.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
}

// Скрытый renderer-мост RTC терминала (R09): по approved (rtc()) создаётся
// невидимое BrowserWindow со страницей client/agent-bridge/, где есть нативный
// RTCPeerConnection. Offer/answer/ICE и данные DataChannel релеются по
// фиксированным IPC-каналам (BRIDGE_IPC) через createBridgeRelay. Мост живёт
// только внутри сеанса: pcLike.close() на ended/stop; краш страницы не роняет
// агента — терминал честно закрывается (relay.destroy → onclose канала).
function createAgentRtc({ fetchIceServers, videoForward = null } = {}) {
  return () => {
    let win = null;
    let relay = null;
    const ipcHandlers = [];
    // ADR 0031: Linux unattended-видео — getDisplayMedia в мосту требует
    // хендлер источника. Интерактивного пикера нет (и не должно быть: согласие
    // даёт операторский claim зачисленной машины) — авто-выбор первичного
    // экрана. Ставится только в агент-режиме на linux и macOS (ADR 0038: на
    // Mac агент живёт LaunchAgent'ом в сеансе пользователя); attended-окно
    // ставит свой хендлер в createWindow() (там пикер по selectedSource).
    if (BRIDGE_CAPTURE) {
      session.defaultSession.setDisplayMediaRequestHandler((_opts, callback) => {
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const primary = screen.getPrimaryDisplay();
            const src = sources.find((s) => String(s.display_id ?? '') === String(primary.id)) ?? sources[0];
            if (src) callback({ video: src });
            else callback({});
          })
          .catch(() => callback({}));
      }, { useSystemPicker: false });
    }
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
      bootLog.write('bridge', `мост RTC недоступен: ${e.message}`);
      return null;
    }
    bootLog.write('bridge', 'мост RTC создан (скрытое окно)');
    videoForward?.setGdm?.(null); // новый мост — захват ещё не стартовал
    win.on('closed', () => { win = null; });
    // Тот же контур, что у главного окна (SEC-003): мост не открывает окна
    // и не навигируется — страница фиксированная (client/agent-bridge/page.html).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    relay = createBridgeRelay({
      send: (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); },
      onClosed: cleanup,
      // TURN для pc терминала (R09): релей запросит конфиг один раз до первого
      // offer; сбой/пусто — релей сам честно деградирует в iceServers:[] (по LAN).
      fetchIceServers,
      log: console,
    });
    // Кадры видео-хелпера (ADR 0027) идут только в мост текущего сеанса;
    // videoForward (см. startAgentMode) знает актуальный relay.
    videoForward?.setRelay?.((channel, payload) => relay.sendToBridge(channel, payload));
    // отправитель — только наше окно: чужие ipc-посылки не проходят
    for (const channel of Object.values(BRIDGE_IPC)) {
      const handler = (e, payload) => {
        if (win && !win.isDestroyed() && e.sender === win.webContents) relay.handleMessage(channel, payload);
      };
      ipcMain.on(channel, handler);
      ipcHandlers.push([channel, handler]);
    }
    // Статус Linux-захвата моста (ADR 0031): honest running/unavailable — в
    // svc-diag; мост никогда не фейкает кадры, недоступность видит оператор.
    {
      const handler = (e, payload) => {
        if (win && !win.isDestroyed() && e.sender === win.webContents) {
          svcDiag.write('video', `gdm ${payload?.state ?? '?'}${payload?.reason ? ` (${payload.reason})` : ''}`);
          videoForward?.setGdm?.({ state: payload?.state, reason: payload?.reason });
        }
      };
      ipcMain.on('enot:bridge-gdm', handler);
      ipcHandlers.push(['enot:bridge-gdm', handler]);
    }
    win.webContents.on('did-finish-load', () => {
      relay.markReady(); // мост готов получать offer
      // ADR 0031/0038: включаем захват в мосту (gdm) — linux и macOS, env
      // EDESK_AGENT_VIDEO=off отключает; кадры Windows-хелпера приоритетнее.
      if (BRIDGE_CAPTURE) {
        win.webContents.send('enot:video-mode', { gdm: true });
      }
    });
    win.webContents.on('render-process-gone', () => {
      console.warn('[enotdesk-agent] мост RTC упал — терминал честно закрывается');
      bootLog.write('bridge', 'мост RTC упал (render-process-gone)');
      relay.destroy();
    });
    win.loadFile(path.join(import.meta.dirname, 'agent-bridge', 'page.html')).catch((e) => {
      console.error(`[enotdesk-agent] страница моста не загрузилась: ${e.message}`);
      relay.destroy();
    });
    // W-C2 (волна C): релей держит N pc (Map<op>) — агенту нужен сам relay
    // (getPcLike(op)/closeOp(op)/ops()); pcLike-поле остаётся для легаси-шим.
    return relay;
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
  // WoL (v0.6): MAC'и и локальные IPv4 — курьерам magic packet и выбору соседей.
  // Сервер санитизирует allowlist'ом (≤8×60, мусор выкидывается поэлементно).
  try {
    const macs = new Set();
    const localIps = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list ?? []) {
        if (i.mac && i.mac !== '00:00:00:00:00:00') macs.add(i.mac.toUpperCase());
        if (i.family === 'IPv4' && !i.internal) localIps.add(i.address);
      }
    }
    if (macs.size) inventory.macs = [...macs];
    if (localIps.size) inventory.localIps = [...localIps];
  } catch { /* networkInterfaces недоступен — поля честно отсутствуют, WoL не обещаем */ }
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

  // Видео-хелпер (ADR 0027, v0.6): спавн в консольном сеансе + pipe → мост.
  // Хелпер есть только в упакованной сборке (extraResources); в dev честно
  // spawn-bad-exe → machine-сеанс живёт без видео.
  // Релей кадров в мост текущего сеанса: setRelay вызывается из createAgentRtc
  // при открытии RTC (v0.6 fix ревью GLM-5.3 — раньше метода не существовало и
  // каждый кадр молча терялся).
  const videoForward = {
    relay: null,
    setRelay(fn) { this.relay = fn; },
  };
  const videoStatusCb = { fn: null };
  // ADR 0031: на Linux видео даёт мост (getDisplayMedia) — оператору уходит
  // его реальный статус захвата; createAgentRtc передаёт сюда состояние моста.
  const gdmVideo = BRIDGE_CAPTURE;
  let gdmState = null;
  videoForward.setGdm = (payload) => {
    gdmState = payload;
    const s = gdmVideoStatus(payload);
    if (s) videoStatusCb.fn?.(s);
  };
  let spawnKoffi;
  try { spawnKoffi = createRequire(import.meta.url)('koffi'); } catch { spawnKoffi = null; } // честный spawn-koffi-unavailable
  // Портативная сборка самораспаковывается в %TEMP%\<случай>\ с SYSTEM-only ACL
  // на файлах: CreateProcessAsUserW от консольного пользователя не может даже
  // прочитать exe хелпера (этап 4, 06.10 — «Access is denied» воспроизведён).
  // Копируем хелпер в ProgramData (Users получают RX по наследованию) и спавним
  // оттуда. При установке NSIS (Program Files) путь уже доступен — копия не
  // нужна. Копия не удалась — честно отдаём исходный путь: спавн отчитает отказ.
  let helperExe = app.isPackaged ? path.join(process.resourcesPath, 'enotdesk-video.exe') : '';
  if (process.platform === 'win32' && helperExe) {
    try {
      const helperDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'EnotDesk', 'helper');
      fs.mkdirSync(helperDir, { recursive: true });
      const dst = path.join(helperDir, 'enotdesk-video.exe');
      // Аудит 15.10 P2-1: ProgramData пишется любым пользователем — size-only
      // проверка позволяла подложить чужой exe совпадающего размера (эскалация
      // в сессию консольного пользователя). Сверяем SHA-256 с эталоном.
      const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest();
      const same = (() => { try { return sha(dst).equals(sha(helperExe)); } catch { return false; } })();
      if (!same) fs.copyFileSync(helperExe, dst);
      helperExe = dst;
      svcDiag.write('video', `helper path: ${dst}`);
    } catch (e) {
      svcDiag.write('video', `helper copy failed (${e.message}) — пробуем исходный путь`);
    }
  }
  // B2.1 (волна 0.6.19): вне Windows хелпера нет, а Linux-захвата в продукте
  // не существует (мост рисует только кадры Windows-хелпера). Раньше на Linux
  // createSessionSpawner падал на koffi.load('kernel32.dll') и оператор видел
  // бессмысленный spawn-native-unavailable. Честное ограничение: videoHost не
  // строится вовсе, start() сразу репортит video-unsupported-platform.
  const videoSupported = process.platform === 'win32';
  let videoHost = null;
  if (videoSupported) {
    videoHost = createVideoHost({
      // Токен и argv строит сам videoHost на каждый start() (аудит 15.10 P2-2:
      // переиспользуемый argv-токен живёт весь lifetime агента — одноразовый
      // по контракту README хелпера). argv нужен: DETACHED-спавн не имеет stdin,
      // командная строка видна только процессам того же пользователя.
      spawner: createSessionSpawner({
        koffi: spawnKoffi,
        log: { warn: (...a) => { console.warn(...a); svcDiag.write('video', a.map(String).join(' ')); } },
      }),
      netFactory: (p) => net.connect(p),
      // Абсолютный путь (ревью безопасности 22.10, P3-1): голое имя искалось бы по PATH.
      killer: (pid) => { nodeSpawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); },
      exePath: helperExe,
      log: { warn: (...a) => { console.warn(...a); svcDiag.write('video', a.map(String).join(' ')); } },
      onFrame: (jpeg) => videoForward.relay?.(BRIDGE_IPC.VIDEO_FRAME, jpeg),
      onStatus: (s) => videoStatusCb.fn?.(s),
    });
  }
  // Контракт для agent.mjs (deps.video): жизненный цикл, ввод, статусы.
  // W2 (0.6.8): пресеты качества — оператор шлёт {quality:'high|medium|low'}
  // по input-каналу, хост маппит в параметры хелпера (хелпер сам клампит
  // jpegQ 40..90, maxFps 1..60; параметры живут до конца сеанса хелпера).
  const QUALITY_PRESETS = {
    high: { jpegQ: 90, maxFps: 24 },
    medium: { jpegQ: 70, maxFps: 15 },
    low: { jpegQ: 45, maxFps: 8 },
  };
  const video = {
    bind: () => {}, // relay привязывается в createAgentRtc (videoForward.setRelay)
    start: () => {
      if (!videoHost && gdmVideo) {
        // мост ещё не отчитался — «запускается»; running/unavailable придут от моста
        const s = gdmVideoStatus(gdmState) ?? { state: 'connecting' };
        videoStatusCb.fn?.(s);
        return s;
      }
      if (!videoHost) {
        const s = { state: 'error', reason: 'video-unsupported-platform' };
        videoStatusCb.fn?.(s);
        return s;
      }
      return videoHost.start();
    },
    stop: () => { videoHost?.stop(); },
    sendCommand: (obj) => videoHost?.sendCommand(obj),
    sendInput: (raw) => videoHost?.sendCommand({ cmd: 'input', raw }),
    handleInputChannel: (ch) => {
      if (!videoHost) return; // платформа без видео: каналы честно игнорируются
      ch.onmessage = (m) => {
        if (typeof m?.data !== 'string') return;
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; }
        // svc-diag: только тип события, без тела — в JSON ввода бывают пароли,
        // набираемые оператором на удалённой машине (аудит 12.10, P3)
        svcDiag.write('video', `input msg: type=${typeof ev?.type === 'string' ? ev.type : 'unknown'}`);
        // privacy MVP: управление дисплеем через тот же канал (v0.6)
        if (ev?.display === 'off' || ev?.display === 'on') {
          videoHost.sendCommand({ cmd: ev.display === 'off' ? 'sleep' : 'wake' });
          return;
        }
        // W2: пресет качества — тем же каналом, тем же доверием
        if (typeof ev?.quality === 'string' && QUALITY_PRESETS[ev.quality]) {
          videoHost.sendCommand({ cmd: 'quality', ...QUALITY_PRESETS[ev.quality] });
          return;
        }
        // v0.6 fix (ревью GLM-5.3): протокольное событие → словарь команд
        // хелпера (mouse/key/wheel) — хелпер не знает конверта 'input'.
        for (const cmd of inputEventToCommands(ev)) videoHost.sendCommand(cmd);
      };
    },
    onStatus: (cb) => { videoStatusCb.fn = cb; },
  };

  // v0.6.4: на Linux хелпера нет — ввод machine-сеанса идёт нативному адаптеру
  // (X11/XTest); размер дисплея берётся из самого адаптера, Electron screen у
  // службы отсутствует. У macOS-адаптера size() нет (ревизия 06.10: sink давал
  // бы клики в угол) — границы даёт Electron screen (ниже). Windows — прежний
  // путь через хелпер.
  // ADR 0038: на macOS агент работает в сеансе пользователя (LaunchAgent),
  // поэтому у него есть Electron screen — границы первичного экрана в точках,
  // в тех же координатах, что CGEvent. Без GUI-сеанса (старый LaunchDaemon)
  // screen бросает — sink честно молчит (no-bounds), видео тоже не стартует.
  const macBounds = () => { try { return screen.getPrimaryDisplay().bounds; } catch { return null; } };
  const inputSink = (process.platform === 'linux' || process.platform === 'darwin') ? createAgentInputSink({
    nativeInput,
    getBounds: () => (process.platform === 'darwin' ? macBounds() : nativeInput.bounds()),
    log: { warn: (...a) => { console.warn(...a); svcDiag.write('input', a.map(String).join(' ')); } },
  }) : null;

  const agent = createAgent({
    api: agentApi,
    signal: () => createSignalClient({ url: new URL('/signal', settings.serverUrl).toString().replace(/^http/, 'ws') }),
    native: nativeInput,
    // Терминал (R09 + SEC-001): оболочка поднимается от консольного пользователя,
    // а не от службы — иначе на Linux агент-служба (root) открывала бы root-shell.
    // Консольного пользователя нет (экран входа/чистый сервис) — spawnShellFor
    // честно пометит контекст 'service'.
    termHost: (() => {
      // NoNewPrivileges юнита запрещает setuid — sudo -u консольному пользователю
      // невозможно в принципе (приёмка 05.10): не назначаем его вовсе,
      // spawnShellFor честно пометит контекст 'service'.
      const consoleUser = noNewPrivs() ? null : resolveConsoleUser({ platform: process.platform });
      return createTermHost({
        platform: process.platform,
        ...(consoleUser ? { consoleUser: consoleUser.user, uid: consoleUser.uid } : {}),
      });
    })(),
    // pc терминала живёт в скрытом renderer-мосте: в main-процессе Electron
    // нет RTCPeerConnection. Не собрали мост — createAgent честно предупредит.
    rtc: createAgentRtc({
      // TURN терминала (R09): /rtc-config с машинным токеном. Токен читаем из
      // store в момент открытия терминала — к этому моменту машина
      // зарегистрирована; отзыв/не-200/зависание хук честно отчитает.
      fetchIceServers: createIceServersFetcher({ api: agentApi, tokenLoad: () => tokenStore.load() }),
      videoForward,
    }),
    // Сообщение на экран машины (R08): платформа известна здесь, текст приходит
    // из heartbeat-ответа сервера. Показ не блокирует цикл (см. deliverToast).
    notify: (text) => showToast(process.platform, text),
    // ADR 0037 (Р5): сообщение человеку за компьютером о подключении через
    // службу и о конце сеанса — тексты из словаря.
    noticeText: (kind, { operator = '', reason = '' } = {}) => (kind === 'start'
      ? t(reason ? 'agent.notice.startReason' : 'agent.notice.start', { operator: operator || t('agent.notice.someone'), reason })
      : t('agent.notice.end')),
    // W-U6 (v0.5): чат (тост консольному пользователю) и файлы (запись в общую
    // папку) из machine-сеанса. Диагностика — в svc-diag, как у агента.
    services: createMachineServices({
      platform: process.platform,
      notify: (text) => showToast(process.platform, text),
      log: { warn: (...a) => { console.warn(...a); svcDiag.write('agent', a.map(String).join(' ')); } },
    }),
    // v0.6 (ADR 0027): видео+ввод в консольном сеансе через хелпер.
    video,
    // v0.6.4: ввод machine-сеанса на Linux — нативный пайплайн (на Windows null).
    inputSink,
    policy: {
      name: process.env.EDESK_AGENT_NAME || os.hostname(),
      os: process.platform,
      version: app.isPackaged ? app.getVersion() : pkg.version,
      heartbeatMs: 5000,
      backoffBaseMs: 1000,
      backoffMaxMs: 30000,
      tokenStore,
      getInventory: collectInventory, // инвентарь машин (R06) с каждым heartbeat
      // W-U2 diag: статусы агента (регистрация/подключение/backoff) дублируются
      // в файловый лог — у службы stdout теряется. Все четыре метода обязательны:
      // agent.mjs зовёт info/warn/error без optional chaining (ревью v0.4.4)
      log: {
        log: (...a) => { console.log(...a); svcDiag.write('agent', a.map(String).join(' ')); },
        info: (...a) => { console.info(...a); svcDiag.write('agent', a.map(String).join(' ')); },
        warn: (...a) => { console.warn(...a); svcDiag.write('agent', a.map(String).join(' ')); },
        error: (...a) => { console.error(...a); svcDiag.write('agent', a.map(String).join(' ')); },
      },
    },
  });
  app.on('before-quit', () => agent.stop());
  const code = process.env.EDESK_AGENT_CODE;
  const started = agent.start(code ? { code } : {});
  svcDiag.write('agent', `start: ok=${started.ok}${started.error ? ` error=${started.error}` : ''} server=${settings.serverUrl}${code ? ' (по onboarding-коду)' : ' (по сохранённому токену)'}`);
  if (started.ok) {
    console.log(`[enotdesk-agent] запущен: сервер ${settings.serverUrl}, машина «${process.env.EDESK_AGENT_NAME || os.hostname()}»${code ? ' (регистрация по onboarding-коду)' : ''}`);
  } else {
    console.error(`[enotdesk-agent] не запущен: ${started.error}`);
  }
}

// Закрытие окна = реальный выход, без фонового процесса (R16.1)
function cleanupAndQuit() {
  bootLog.write('main', 'выход: окно закрыто');
  keepAwake.release();
  // Best-effort revoke: не ждём сервер дольше ~1с, локальное завершение от него не зависит
  if (api.hostSessionId && api.hostToken) {
    const revoke = api.request('session.end', { sessionId: api.hostSessionId, asHost: true }).catch(() => {});
    void Promise.race([revoke, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  stopSignal();
  nativeInput.end();
  api.clearSessionTokens();
}
// Подтверждённое обновление: в will-quit (после before-quit-очистки) тихо
// ставим и просим установщик перезапустить приложение (--force-run). Это
// закрывает находку 10.10: раньше всё оставалось на quit-хуке electron-updater'а
// (install при выходе без перезапуска), который молча пропускал установку при
// exitCode ≠ 0, а пользователь после закрытия видел «ничего не произошло».
app.on('will-quit', () => {
  if (!updateOnQuitVersion || !activeUpdater) return;
  const version = updateOnQuitVersion;
  console.log(`[enotdesk] обновление ${version}: тихая установка с перезапуском`);
  bootLog.write('update', `обновление ${version}: quitAndInstall (тихая, с перезапуском)`);
  try {
    activeUpdater.quitAndInstall(true, true);
  } catch (e) {
    bootLog.write('update', `обновление ${version}: quitAndInstall ошибка: ${e?.message ?? e}`);
  }
});
app.on('before-quit', cleanupAndQuit);
app.on('window-all-closed', () => {
  // Агент живёт без окон: скрытый мост терминала — единственное окно процесса, и
  // его destroy в конце сеанса НЕ означает конец агента (ревью 28.09: без гварда
  // агент умирал после первого же unattended-сеанса). Жизненным циклом агента
  // управляет SCM-родитель (служба) или внешний процесс.
  if (AGENT) return;
  // №9-хвост (крест-тест 01.10, v0.4.7): revoke сеанса — ДО app.quit().
  // Electron не ждёт промисы в before-quit: fetch session.end проигрывал гонку
  // выходу процесса, и сеанс умирал host-lost после ВСЕГО грейса вместо честного
  // 'ended' — оператор 30 с смотрел «переподключается» на намеренное закрытие.
  // Ждём revoke до 1.2 с, только потом quit (+5с страховка от зависшего выхода).
  const revokeDone = (api.hostSessionId && api.hostToken)
    ? Promise.race([
        api.request('session.end', { sessionId: api.hostSessionId, asHost: true }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ])
    : Promise.resolve();
  revokeDone.then(() => {
    app.quit();
    setTimeout(() => {
      try { app.exit(0); } catch { /* уже мёртв */ }
    }, 5000).unref();
  });
});

app.whenReady().then(() => {
  bootMarks.ready = Math.round(performance.now());
  bootLog.write('main', 'app ready');
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
  // Linux: ярлык приложения в меню (находка 10.10: на ВМ ярлыка не было, запуск
  // только из терминала). Только упакованный десктоп-режим; AppImage-обновление
  // меняет файл по тому же пути, при смене пути Exec перезапишется сам.
  if (process.platform === 'linux' && !AGENT && !SMOKE && app.isPackaged) {
    try {
      const r = applyDesktopEntry({
        home: os.homedir(),
        execPath: process.env.APPIMAGE || process.execPath,
        iconSource: path.join(app.getAppPath(), 'assets', 'icon.png'),
        comment: t('desktop.entryComment'),
        runXdgMime: (cmd, id, mime) => { execFile('xdg-mime', [cmd, id, mime], () => {}); },
      });
      if (r.changed) console.log(`[enotdesk] ярлык приложения: ${r.entryFile}`);
    } catch { /* ярлык не критичен */ }
  }
  // Join-ссылка, пришедшая до ready (mac open-url / win-linux argv, R04):
  // применяем после loadSettings — настройки и api уже готовы
  if (STARTUP_JOIN_LINK) pendingRawJoin = STARTUP_JOIN_LINK;
  if (STARTUP_INVITE_LINK) pendingInviteToken = parseInviteLink(STARTUP_INVITE_LINK).token;
  processPendingJoinLink();
  if (AGENT) {
    // Агент-служба: окно, IPC и рендерер не создаются — только цикл и логи
    startAgentMode();
    return;
  }
  registerIpc();
  createWindow();
  flushPendingInvite(); // гард в flush не съест токен до did-finish-load (ревью GLM-5.3)
  startUpdater();
  if (SMOKE) {
    setTimeout(async () => {
      const lines = [];
      lines.push(`SMOKE timing: ${JSON.stringify(bootMarks)}`);
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
      // Протокол enotdesk:// (R04): фактическое состояние регистрации этого прогона
      lines.push(`SMOKE protocol: ${PROTOCOL_REGISTERED ? 'registered' : 'not registered'} (enotdesk://)`);
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
        lines.push(`SMOKE screenshot: ${shotPath}`);
        console.log(`SMOKE screenshot: ${shotPath}`);
      } catch (e) {
        lines.push(`SMOKE screenshot failed: ${e.message}`);
        console.log(`SMOKE screenshot failed: ${e.message}`);
      }
      console.log('SMOKE OK');
      // Смоук собранной программы в CI (scripts/smoke-artifact.mjs): у GUI-exe
      // Windows stdout ненадёжен — итог дублируется в файл
      if (process.env.EDESK_SMOKE_LOG) {
        try { fs.writeFileSync(process.env.EDESK_SMOKE_LOG, `${lines.join('\n')}\nSMOKE OK\n`); } catch { /* итог есть в stdout */ }
      }
      // закрытие окна должно завершить процесс (window-all-closed → quit), а не app.quit напрямую
      win.close();
    }, 2500);
  }
});


// ---- Таймаут бездействия (v0.4.0) --------------------------------------
// Проверка раз в 15 с: в утверждённом сеансе хоста без инъекции ввода дольше
// IDLE_MINUTES — предупреждение за 60 с, затем локальное завершение (reason idle).
if (IDLE_MINUTES > 0) {
  const idleMs = IDLE_MINUTES * 60_000;
  setInterval(() => {
    if (!signal || signalRole !== 'host' || !gate.isOpen()) return;
    const idleFor = Date.now() - (lastInputAt || 0);
    if (idleFor < idleMs - 60_000) {
      if (idleWarned) {
        idleWarned = false;
        sendToRenderer('enot:signal', { type: 'idle-clear' });
        // релей операторам: снять баннер и у них (ревью v0.5: без сети clear
        // доходил только своему рендереру)
        try { signal.sendIdleClear(); } catch { /* WS уже мёртв */ }
      }
      return;
    }
    const remainingSec = Math.max(1, Math.ceil((idleMs - idleFor) / 1000));
    if (idleFor >= idleMs) {
      idleWarned = false;
      // локальное завершение: hostToken (reason idle виден обеим сторонам)
      if (api.hostSessionId && api.hostToken) {
        api.request('session.end', { sessionId: api.hostSessionId, asHost: true, reason: 'idle' }).catch(() => {});
      }
      stopSignal();
      return;
    }
    if (!idleWarned) {
      idleWarned = true;
      sendToRenderer('enot:signal', { type: 'idle-warning', remainingSec });
      // v0.5: оператор узнаёт заранее (сервер релеит host→операторам), а не
      // только post factum по ended/reason=idle — иначе конец сеанса выглядит
      // загадочным «не было активности»
      try { signal.sendIdleWarning({ remainingSec }); } catch { /* WS уже мёртв */ }
    }
  }, 15_000).unref();
}

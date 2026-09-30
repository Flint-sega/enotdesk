// Windows SCM-родитель (дефект №4, живой сеанс 28.09): наш exe ставится службой
// через sc.exe, но Electron-процесс без StartServiceCtrlDispatcher SCM убивает
// по 1053 («служба не ответила»). Родительский режим EDESK_AGENT_SVC=1:
// процесс НЕ инициализирует Electron, а служит тонкой SCM-обёрткой, которая
// держит живым дочерний агент (тот же exe с EDESK_AGENT=1).
//
// Потоковая модель (по доке koffi callbacks.md): колбэки из чужих потоков
// встают в очередь главного JS-потока и исполняются, «как только event loop
// получит шанс». Поэтому StartServiceCtrlDispatcher зовётся через .async —
// блокируется поток libuv, а главный JS-поток свободен и прокачивает
// ServiceMain/обработчик управления. Всё в одном koffi-контексте, без
// передачи указателей между потоками.
//
// Логика отделена от koffi-клея (createScmParentLogic) и тестируется на
// инъекциях без koffi и без Windows.

import { envDiagSlice, maskJoinTokens } from './svc-diag.mjs';

const SERVICE_WIN32_OWN_PROCESS = 0x10;
const SERVICE_STOPPED = 0x1;
const SERVICE_START_PENDING = 0x2;
const SERVICE_STOP_PENDING = 0x3;
const SERVICE_RUNNING = 0x4;
const SERVICE_ACCEPT_STOP = 0x1;
const SERVICE_ACCEPT_SHUTDOWN = 0x2;
const SERVICE_CONTROL_STOP = 0x1;
const SERVICE_CONTROL_SHUTDOWN = 0x2;
const NO_ERROR = 0;

// Рестарт дочернего агента при падении: 1с, 2с, 5с, 10с, затем 30с; счётчик
// сбрасывается после 60 с стабильной работы. После MAX_RESTART_ATTEMPTS падений
// ПОДРЯД родитель сдаётся и честно рапортует SCM SERVICE_STOPPED — вступают
// SCM-failure actions (restart 5с/10с/30с): они рестартуют всю службу целиком.
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10000];
const RESTART_CAP_MS = 30000;
const STABLE_RESET_MS = 60000;
const MAX_RESTART_ATTEMPTS = 5;

// Создаёт обработчики жизненного цикла службы. Все побочные эффекты — через
// инъекции: setStatus(code, {waitHint}) — SetServiceStatus; spawnChild(onExit) /
// killChild() — управление дочерним процессом; log — консоль/журнал.
export function createScmParentLogic({ setStatus = () => {}, spawnChild = () => {}, killChild = () => {}, log = console } = {}) {
  const state = {
    statusHandle: null,
    childRunning: false,
    stopping: false,
    restartAttempt: 0,
    startedAt: 0,
    restartTimer: null,
  };

  const clearRestart = () => {
    if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
  };

  const onChildExit = () => {
    state.childRunning = false;
    if (state.stopping) return;
    if (state.startedAt && Date.now() - state.startedAt > STABLE_RESET_MS) state.restartAttempt = 0;
    if (state.restartAttempt >= MAX_RESTART_ATTEMPTS) {
      // Перманентное падение ребёнка: честный STOPPED вместо вечного «RUNNING»
      // с мёртвым ребёнком — SCM-failure actions рестартуют службу целиком.
      log.error?.(`[svc] ребёнок падает ${state.restartAttempt + 1}-й раз подряд — сдаюсь, отчёт STOPPED (рестарт силами SCM)`);
      state.stopping = true;
      clearRestart();
      setStatus(SERVICE_STOPPED, {});
      return;
    }
    const delay = state.restartAttempt < RESTART_DELAYS_MS.length
      ? RESTART_DELAYS_MS[state.restartAttempt]
      : RESTART_CAP_MS;
    state.restartAttempt += 1;
    log.warn?.(`[svc] дочерний агент завершился — перезапуск через ${delay} мс (попытка ${state.restartAttempt})`);
    clearRestart();
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      spawnOnce();
    }, delay);
  };

  const spawnOnce = () => {
    if (state.stopping || state.childRunning) return;
    state.startedAt = Date.now();
    state.childRunning = true;
    try {
      spawnChild(onChildExit);
    } catch (e) {
      state.childRunning = false;
      log.error?.(`[svc] запуск дочернего агента не удался: ${e.message}`);
      onChildExit();
    }
  };

  return {
    state,
    // ServiceMain: SCM вызывает в чужом потоке — koffi доставит в главный JS-поток.
    onServiceMain() {
      try {
        if (!state.statusHandle) throw new Error('status handle не зарегистрирован');
        setStatus(SERVICE_START_PENDING, { waitHint: 10000 });
        spawnOnce();
        setStatus(SERVICE_RUNNING, {});
      } catch (e) {
        log.error?.(`[svc] ServiceMain не удался: ${e.message}`);
        state.stopping = true;
        clearRestart();
        setStatus(SERVICE_STOPPED, {});
      }
    },
    // Обработчик управления: STOP/SHUTDOWN — гасим ребёнка и останавливаемся.
    // Возврат — DWORD: NO_ERROR, если команду приняли.
    onControl(control) {
      if (control === SERVICE_CONTROL_STOP || control === SERVICE_CONTROL_SHUTDOWN) {
        if (state.stopping) return NO_ERROR;
        state.stopping = true;
        clearRestart();
        setStatus(SERVICE_STOP_PENDING, { waitHint: 5000 });
        // Убивать есть что только у живого ребёнка: в окне рестарта lastPid
        // указывает на уже мёртвый pid — taskkill /T /F от SYSTEM по
        // переиспользованному pid убил бы чужой процесс.
        if (state.childRunning) {
          try { killChild(); } catch (e) { log.warn?.(`[svc] остановка ребёнка: ${e.message}`); }
        }
        state.childRunning = false;
        setStatus(SERVICE_STOPPED, {});
      }
      return NO_ERROR;
    },
    // Регистрацию status-handle делает ServiceMain через glue; хук для тестов.
    setStatusHandle(handle) { state.statusHandle = handle; },
    isStopping() { return state.stopping; },
  };
}

// Koffi-клей: настоящий SCM-цикл. Блокирует поток libuv до остановки службы,
// возвращает промис. childArgv/childEnv — что и с какими переменными запускать
// ребёнком (родитель передаёт свой env насквозь, включая EDESK_AGENT=1).
// diag (W-U2) — файловый логгер svc-diag: маркеры koffi/диспетчер/ServiceMain/
// статусы/spawn — ровно те точки, где гипотезы №1/№2б расходятся.

// Именованные типы koffi живут в реестре НА ПРОЦЕСС: повторная регистрация
// бросает «Duplicate type name» (конвенция native-input.mjs). Мемоизируем —
// повторный вызов runAsScmParent в одном процессе переиспользует типы
// (ревью v0.4.5).
let scmGlue = null;
function scmTypes(koffi) {
  if (scmGlue) return scmGlue;
  // Повторная регистрация имени бросает «Duplicate type name»: при частичном
  // отказе прошлого вызова (структура зарегистрирована, scmGlue не присвоен)
  // повторный вызов падал бы тем же классом, что чинил 3349bf4 (ревью v0.4.6).
  // Конвенция native-input.mjs: дубликат глотаем — тип уже в реестре процесса.
  const regStruct = (name, fields) => {
    try { koffi.struct(name, fields); } catch (e) {
      if (!/Duplicate type name/.test(e?.message ?? '')) throw e;
    }
  };
  regStruct('ENOT_SERVICE_STATUS', {
    dwServiceType: 'unsigned long',
    dwCurrentState: 'unsigned long',
    dwControlsAccepted: 'unsigned long',
    dwWin32ExitCode: 'unsigned long',
    dwServiceSpecificExitCode: 'unsigned long',
    dwCheckPoint: 'unsigned long',
    dwWaitHint: 'unsigned long',
  });
  // ВАЖНО (корень W-U2, найден diag-логом 29.09 на живой машине): koffi.proto
  // регистрирует тип под именем ИЗ СТРОКИ прототипа. Раньше строка называла
  // ENOT_HandlerProc, а сигнатура ниже ссылались на HandlerProc * — koffi
  // бросал «Unknown or invalid type name 'HandlerProc'», родитель умирал за
  // 1 с (exit 1) до всякого SetServiceStatus, и SCM рапортовал 7009/1053.
  // Имя типа в прототипе обязано совпадать со строковой ссылкой.
  let HandlerProc;
  let ServiceMainProc;
  try {
    HandlerProc = koffi.proto('unsigned long HandlerProc(unsigned long, unsigned long, void *, void *)');
    ServiceMainProc = koffi.proto('void ServiceMainProc(unsigned long, void *)');
  } catch (e) {
    if (!/Duplicate/.test(e?.message ?? '')) throw e;
    // прототипы уже в реестре (частичный отказ прошлого вызова) —
    // ссылки по имени: сигнатуры и koffi.pointer принимают имя типа строкой
    HandlerProc = 'HandlerProc';
    ServiceMainProc = 'ServiceMainProc';
  }
  regStruct('ENOT_SERVICE_TABLE_ENTRY', {
    lpServiceName: 'const char *',
    // ВАЖНО (ревью 28.09): koffi-тип НЕ конкатенируется со строкой —
    // ServiceMainProc + ' *' даёт '[object Object] *' и koffi.struct бросает.
    // Только явный koffi.pointer(...). Имя-строкой тоже валидно.
    lpServiceProc: koffi.pointer(ServiceMainProc),
  });
  scmGlue = { HandlerProc, ServiceMainProc };
  return scmGlue;
}

export async function runAsScmParent({ serviceName = 'EnotDeskAgent', childArgv = [], childEnv = {}, log = console, diag = { write: () => false } } = {}) {
  const koffi = (await import('koffi')).default;
  diag.write('svc', 'koffi загружен');
  const { spawn, execFileSync } = await import('node:child_process');
  const advapi32 = koffi.load('advapi32.dll');
  const { HandlerProc, ServiceMainProc } = scmTypes(koffi);

  const RegisterServiceCtrlHandlerExA = advapi32.func('void *RegisterServiceCtrlHandlerExA(const char *, HandlerProc *, void *)');
  const SetServiceStatus = advapi32.func('int SetServiceStatus(void *, const ENOT_SERVICE_STATUS *)');
  const StartServiceCtrlDispatcherA = advapi32.func('int StartServiceCtrlDispatcherA(const ENOT_SERVICE_TABLE_ENTRY *)');

  let handle = null;
  let lastPid = 0;

  const setStatus = (code, { waitHint = 0 } = {}) => {
    diag.write('svc', `SetServiceStatus code=${code} waitHint=${waitHint} handle=${handle ? 'ok' : 'null'}`);
    if (!handle) return;
    const ok = SetServiceStatus(handle, {
      dwServiceType: SERVICE_WIN32_OWN_PROCESS,
      dwCurrentState: code,
      dwControlsAccepted: code === SERVICE_RUNNING ? (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN) : 0,
      dwWin32ExitCode: 0,
      dwServiceSpecificExitCode: 0,
      dwCheckPoint: 0,
      dwWaitHint: waitHint,
    });
    if (!ok) log.warn?.(`[svc] SetServiceStatus(${code}) не принят`);
  };

  const logic = createScmParentLogic({
    setStatus,
    spawnChild: (onExit) => {
      // argv может нести join-ссылку с одноразовым токеном — в лог он не идёт
      // (контракт svc-diag, ревью v0.4.6: маска была только в main.mjs)
      diag.write('svc', `spawn: exec="${process.execPath}" argv=${maskJoinTokens(JSON.stringify(childArgv))} childEnv=[${Object.keys(childEnv).join(',')}] env[${envDiagSlice()}]`);
      const child = spawn(process.execPath, childArgv, {
        env: { ...process.env, ...childEnv },
        stdio: 'ignore',
        windowsHide: true,
      });
      lastPid = child.pid;
      child.on('exit', (code, signal) => {
        diag.write('svc', `child exit pid=${lastPid} code=${code} signal=${signal ?? '-'}`);
        lastPid = 0; onExit();
      });
      child.on('error', (e) => { log.error?.(`[svc] ребёнок: ${e.message}`); diag.write('svc', `child error: ${e.message}`); lastPid = 0; onExit(); });
      log.info?.(`[svc] дочерний агент запущен (pid ${child.pid})`);
    },
    killChild: () => {
      // Дерево целиком: Electron-агент — несколько процессов. timeout обязателен:
      // execFileSync блокирует единственный JS-поток (onControl — koffi-колбэк).
      if (!lastPid) return;
      diag.write('svc', `killChild pid=${lastPid}`);
      try { execFileSync('taskkill', ['/PID', String(lastPid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); }
      catch { /* уже умер или не дождались — STOPPED всё равно отчитываем */ }
    },
    log,
  });

  const handlerCb = koffi.register((control) => logic.onControl(control), koffi.pointer(HandlerProc));
  const serviceMainCb = koffi.register(() => {
    diag.write('svc', 'ServiceMain вошёл (SCM вызвал точку входа)');
    try {
      handle = RegisterServiceCtrlHandlerExA(serviceName, handlerCb, null);
      if (!handle) throw new Error('RegisterServiceCtrlHandlerExA вернул NULL');
      logic.setStatusHandle(handle);
      diag.write('svc', 'хендлр зарегистрирован');
    } catch (e) {
      // Без хендла SCM не отчитаться вовсе: процесс-служба завис бы навечно
      // (диспетчер ждёт SERVICE_STOPPED, который некому отправить). Честный
      // выход — SCM-failure actions рестартуют службу.
      log.error?.(`[svc] регистрация хендлера не удалась: ${e.message}`);
      diag.write('svc', `регистрация хендлера не удалась: ${e.message}`);
      process.exit(1);
    }
    logic.onServiceMain();
  }, koffi.pointer(ServiceMainProc));

  const table = [
    { lpServiceName: serviceName, lpServiceProc: serviceMainCb },
    { lpServiceName: null, lpServiceProc: null },
  ];

  return new Promise((resolve) => {
    diag.write('svc', 'StartServiceCtrlDispatcher вызван');
    StartServiceCtrlDispatcherA.async(table, (err, res) => {
      // №2б (ретест 28–29.09): res=0 «отверг таблицу» даёт ТОТ ЖЕ портрет, что
      // и недоставленный Environment — STOPPED/exit 0/7009. Маркер различает их.
      if (err) log.error?.(`[svc] диспетчер завершился ошибкой: ${err.message ?? err}`);
      else if (!res) log.error?.('[svc] StartServiceCtrlDispatcher отверг таблицу (запуск не через SCM?)');
      diag.write('svc', `диспетчер вернулся: err=${err ? String(err.message ?? err) : '-'} res=${res}`);
      koffi.unregister(handlerCb);
      koffi.unregister(serviceMainCb);
      resolve(res);
    });
  });
}

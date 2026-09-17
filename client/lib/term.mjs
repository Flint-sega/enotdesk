// PTY-шов удалённого терминала (spec R09/R09.1, interfaces.md — frozen):
// createTerm({shell, cols, rows}) → {write, onData, resize, kill} и
// spawnShellFor(platform). Различия ОС и контекст запуска спрятаны здесь.
//
// Честные границы v1 (spec «Терминал»): зависимости не добавляются, node-pty
// нет — реальный адаптер работает через пайпы child_process (без isatty),
// resize сохраняется и дойдёт до PTY-адаптера, когда тот появится. Контекст
// запуска оболочки отдаётся наружу как честная пометка (win — «SYSTEM» от
// службы, unix — пользователь консоли или «service»). Реальные оболочки —
// MANUAL-QA; тесты гоняют фейк-PTY (spawn инъекцией).
//
// Лимиты (spec «Терминал»): 1 терминал на машину (createTermHost), кольцевой
// буфер вывода 512 КБ, таймаут простоя 5 мин. Открытие канала — только внутри
// утверждённого сеанса: createTermHost подключается к datachannel'ам pc
// сеанса, а pc живёт только после approved — решение остаётся на host-стороне.

import { spawn as nodeSpawn } from 'node:child_process';

export const TERM_BUFFER_LIMIT = 512 * 1024; // байт вывода в кольце
export const TERM_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // простой до закрытия
const TERM_MAX_MESSAGE = 8192; // символы в одном вводе оператора
const TERM_REPLAY_CHUNK = 64 * 1024; // размер куска реплея буфера

// Резолв оболочки по платформе: чистая функция, никаких запусков.
// context — честная пометка учётки, от которой пойдёт оболочка.
export function spawnShellFor(platform, { consoleUser, uid } = {}) {
  if (platform === 'win32') {
    // Служба агента работает от LocalSystem — оболочка честно помечается SYSTEM.
    return { file: 'powershell.exe', args: ['-NoProfile', '-NoLogo'], context: 'SYSTEM' };
  }
  if (platform === 'linux') {
    if (consoleUser) return { file: 'sudo', args: ['-u', consoleUser, 'bash'], context: consoleUser };
    return { file: 'bash', args: [], context: 'service' };
  }
  if (platform === 'darwin') {
    // best-effort: launchctl asuser требует uid, а не имя — его даёт вызывающий.
    if (consoleUser && uid != null) {
      return { file: 'launchctl', args: ['asuser', String(uid), '/bin/zsh'], context: consoleUser };
    }
    return { file: '/bin/zsh', args: [], context: 'service' };
  }
  return { file: '/bin/sh', args: [], context: 'service' };
}

// Реальный адаптер (прод): пайпы без PTY — это ограничение v1, задокументировано выше.
function defaultSpawn({ shell }) {
  const child = nodeSpawn(shell.file, shell.args ?? [], {
    ...(shell.env ? { env: shell.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    write: (data) => { child.stdin?.write(data); },
    kill: () => { try { child.kill('SIGKILL'); } catch { /* уже мёртв */ } },
    resize: () => {}, // пайпы не имеют размера; см. честную пометку в шапке
    onData: (cb) => {
      child.stdout?.on('data', (chunk) => cb(String(chunk)));
      child.stderr?.on('data', (chunk) => cb(String(chunk)));
    },
    onExit: (cb) => { child.on('close', (code) => cb({ code })); },
  };
}

function clampSize(v, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) return null;
  return n;
}

export function createTerm({
  shell,
  cols: colsIn = 80,
  rows: rowsIn = 24,
  spawn = defaultSpawn,
  idleTimeoutMs = TERM_IDLE_TIMEOUT_MS,
  bufferLimit = TERM_BUFFER_LIMIT,
} = {}) {
  if (!shell || typeof shell.file !== 'string' || !shell.file) {
    throw new Error('createTerm: нужна оболочка {file, args?}');
  }
  let cols = clampSize(colsIn, 2, 500) ?? 80;
  let rows = clampSize(rowsIn, 2, 200) ?? 24;

  const proc = spawn({ shell, cols, rows });
  if (!proc || typeof proc.write !== 'function' || typeof proc.kill !== 'function'
      || typeof proc.onData !== 'function' || typeof proc.onExit !== 'function') {
    throw new Error('createTerm: spawn должен вернуть {write, kill, onData, onExit}');
  }

  // Кольцевой буфер: строки-куски + суммарный размер в байтах; при переполнении
  // выбрасываем голову. Мультибайт внутри куска может резаться по краям — для
  // журнала вывода это приемлемо (куски крупные, 64 КБ+).
  const ring = [];
  let ringBytes = 0;
  let outputCbs = [];
  let exitCbs = [];
  let exited = false;
  let exitPayload = null;
  let idleTimer = null;
  let dead = false;

  const emitExit = (payload) => {
    if (exited) return;
    exited = true;
    exitPayload = payload;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const cb of exitCbs) cb(payload);
    exitCbs = [];
    outputCbs = [];
  };

  const refreshIdle = () => {
    if (dead || exited || !(idleTimeoutMs > 0)) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      dead = true;
      // сначала фиксируем причину: синхронный close фейк-PTY не перебьёт её
      emitExit({ reason: 'idle-timeout' });
      try { proc.kill(); } catch { /* уже мёртв */ }
    }, idleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  };

  proc.onData((chunk) => {
    if (exited || chunk == null || chunk === '') return;
    ring.push(chunk);
    ringBytes += Buffer.byteLength(chunk);
    while (ringBytes > bufferLimit && ring.length > 1) {
      ringBytes -= Buffer.byteLength(ring[0]);
      ring.shift();
    }
    if (ringBytes > bufferLimit && ring.length === 1) {
      // кусок крупнее лимита: оставляем хвост, влезающий в лимит (граница R09);
      // хвост может резать мультибайт — для журнала вывода это приемлемо
      const tail = Buffer.from(ring[0]).subarray(-bufferLimit).toString('utf8');
      ring[0] = tail;
      ringBytes = Buffer.byteLength(tail);
    }
    refreshIdle();
    for (const cb of outputCbs) cb(chunk);
  });
  proc.onExit((info) => emitExit({ reason: 'exit', ...(info && info.code != null ? { code: info.code } : {}) }));
  refreshIdle();

  return {
    write(data) {
      if (dead || exited || typeof data !== 'string' || data.length === 0 || data.length > TERM_MAX_MESSAGE) return false;
      refreshIdle();
      try { proc.write(data); } catch { return false; }
      return true;
    },
    onData(cb) {
      if (typeof cb === 'function') outputCbs.push(cb);
    },
    // Выход оболочки/таймаута — ровно одно событие; после — терминал мёртв.
    onExit(cb) {
      if (typeof cb !== 'function') return;
      if (exited) cb(exitPayload);
      else exitCbs.push(cb);
    },
    resize(nextCols, nextRows) {
      if (dead || exited) return false;
      const c = clampSize(nextCols, 2, 500);
      const r = clampSize(nextRows, 2, 200);
      if (c == null || r == null) return false;
      cols = c; rows = r;
      refreshIdle();
      try { proc.resize?.(c, r); } catch { /* адаптер без размера — честный no-op */ }
      return true;
    },
    kill(reason = 'killed') {
      if (dead) return false;
      dead = true;
      emitExit({ reason }); // причина инициатора старше синхронного close процесса
      try { proc.kill(); } catch { /* уже мёртв */ }
      return true;
    },
    // Хвост вывода (для реплея переподключившемуся/опоздавшему оператору).
    buffer() { return ring.join(''); },
    size: () => ({ cols, rows }),
    isAlive: () => !dead && !exited,
  };
}

// Host-сторона DC-канала `term` (одно имя из allowlist каналов ADR 0014 + term).
// Протокол (JSON, текстовые сообщения):
//   host → оператор: {type:'opened', context} | {type:'out', data} |
//                    {type:'exit', reason} | {type:'error', code}
//   оператор → host: {type:'in', data} | {type:'resize', cols, rows} | {type:'close'}
export function createTermHost({
  platform,
  consoleUser,
  uid,
  createTerm: makeTerm = createTerm,
  spawnShellFor: resolveShell = spawnShellFor,
  onActiveChange,
} = {}) {
  let active = null; // {term, ch}
  const notify = (v) => { if (typeof onActiveChange === 'function') onActiveChange(v); };

  function release(sendExit) {
    if (!active) return;
    const { term: liveTerm, ch } = active;
    active = null;
    notify(false);
    if (liveTerm && liveTerm.isAlive()) liveTerm.kill('closed');
    if (sendExit && ch.readyState === 'open') {
      try { ch.send(JSON.stringify({ type: 'exit', reason: 'closed' })); } catch { /* канал умирает */ }
    }
    if (ch.readyState === 'open') { try { ch.close(); } catch { /* уже закрыт */ } }
  }

  function handleChannel(ch) {
    // Лимит «1 терминал на машину»: повторное открытие честно отклоняется.
    if (active) {
      try { ch.send(JSON.stringify({ type: 'error', code: 'term-busy' })); } catch { /* не уйдёт — закрываем */ }
      try { ch.close(); } catch { /* уже закрыт */ }
      return false;
    }
    let term = null;
    let opened = false;

    const send = (obj) => { try { ch.send(JSON.stringify(obj)); } catch { /* канал умирает — exit догонит release */ } };

    function openTerm() {
      if (opened) return; // повторный onopen того же канала не переоткрывает
      opened = true;
      const shell = resolveShell(platform, { consoleUser, uid });
      try {
        term = makeTerm({ shell, cols: 80, rows: 24 });
      } catch {
        send({ type: 'error', code: 'spawn-failed' });
        try { ch.close(); } catch { /* уже закрыт */ }
        return;
      }
      active = slot;
      slot.term = term;
      notify(true);
      // Честная пометка контекста исполнения (R09.1): SYSTEM/пользователь/служба.
      send({ type: 'opened', context: shell.context });
      // Реплей кольца кусками: оператор видит хвост вывода после переподключения.
      const buf = term.buffer();
      for (let i = 0; i < buf.length; i += TERM_REPLAY_CHUNK) {
        send({ type: 'out', data: buf.slice(i, i + TERM_REPLAY_CHUNK) });
      }
      term.onData((data) => send({ type: 'out', data }));
      term.onExit((info) => {
        if (active === slot) {
          active = null;
          notify(false);
          send({ type: 'exit', reason: info?.reason ?? 'exit' });
          if (ch.readyState === 'open') { try { ch.close(); } catch { /* уже закрыт */ } }
        }
      });
    }

    const slot = { term: null, ch };
    ch.onopen = openTerm;
    ch.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; } // не-JSON игнорируется (allowlist)
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'in' && term) {
        term.write(typeof msg.data === 'string' ? msg.data.slice(0, TERM_MAX_MESSAGE) : '');
      } else if (msg.type === 'resize' && term) {
        term.resize(msg.cols, msg.rows);
      } else if (msg.type === 'close') {
        release(false);
      }
      // прочие типы не проходят allowlist
    };
    ch.onclose = () => release(false);
    return true;
  }

  return {
    handleChannel,
    isActive: () => active != null,
    // Завершение сеанса/остановка агента убивает живой терминал.
    close: () => release(true),
  };
}

// Честный отказ каналу 'term' от host'а без терминала (attended-человек):
// оболочку поднимает только machine-агент (spec R09).
export function rejectTermChannel(ch, code = 'term-unavailable') {
  try { ch.send(JSON.stringify({ type: 'error', code })); } catch { /* канал умирает */ }
  const bye = () => { try { ch.close(); } catch { /* уже закрыт */ } };
  // даём ошибке уйти до закрытия: кадры DataChannel уходят асинхронно
  if (typeof setTimeout === 'function') setTimeout(bye, 100);
  else bye();
}

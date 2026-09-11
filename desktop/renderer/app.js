// Рендерер ЕнотDesk: только UI, media-треки и RTCPeerConnection.
// Вся сеть и нативный ввод — через window.enot (context-isolated мост).

const $ = (id) => document.getElementById(id);
const enot = window.enot;

const state = {
  role: 'client',
  me: null, // {name, role} оператора
  // клиент помощи
  session: null, // {sessionId, password}
  // оператор
  connect: null, // {sessionId, claimId}
  pc: null, dc: null, localStream: null,
  iceQueue: [],
  busy: false,
  pages: { contacts: 0, history: 0, audit: 0 },
  query: { contacts: '' },
};

const END_REASONS = {
  ended: 'Сеанс завершён.',
  denied: 'Вы отклонили запрос оператора.',
  'host-lost': 'Приложение помощи закрылось — сеанс завершён.',
  'operator-lost': 'Оператор отключился — сеанс завершён.',
  'lease-expired': 'Сеанс завершён по таймауту неактивности.',
  'server-restart': 'Сервер перезапущен — сеанс завершён.',
  'signal-lost': 'Связь с сервером потеряна — сеанс завершён.',
  rtc: 'Соединение экрана прервалось.',
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function setBusy(btn, busy, labelBusy) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy && labelBusy) { btn.dataset.label = btn.textContent; btn.textContent = labelBusy; }
  else if (!busy && btn.dataset.label) { btn.textContent = btn.dataset.label; }
}
function text(el, value) { el.textContent = value; }

function switchView(role) {
  state.role = role;
  for (const [id, active] of [['tab-client', role === 'client'], ['tab-operator', role === 'operator']]) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  $(role === 'client' ? 'view-client' : 'view-operator').classList.remove('hidden');
  hide($(role === 'client' ? 'view-operator' : 'view-client'));
}
$('tab-client').addEventListener('click', () => switchView('client'));
$('tab-operator').addEventListener('click', () => switchView('operator'));

// ---------- клиент: машина состояний ----------

function clientShow(section) {
  for (const id of ['client-idle', 'client-registering', 'client-waiting', 'client-consent', 'client-connected', 'client-ended', 'client-error']) {
    hide($(id));
  }
  show($('client-' + section));
}

$('btn-start').addEventListener('click', startHelp);
$('btn-retry').addEventListener('click', startHelp);

async function startHelp() {
  if (state.session) return; // двойное начало не создаёт второй сеанс
  setBusy($('btn-start'), true, 'Соединяемся…');
  clientShow('registering');
  try {
    const res = await enot.request('session.create', {});
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? `Сервер ответил ${res.status}`);
    state.session = { sessionId: res.body.sessionId, password: res.body.password };
    text($('client-id'), res.body.sessionId);
    text($('client-password'), res.body.password);
    await enot.openSignal({ role: 'host', sessionId: res.body.sessionId });
    clientShow('waiting');
  } catch (e) {
    state.session = null;
    text($('client-error-text'), e.message);
    clientShow('error');
  } finally {
    setBusy($('btn-start'), false);
  }
}

$('btn-cancel-wait').addEventListener('click', async () => {
  await enot.request('session.end', { sessionId: state.session?.sessionId, asHost: true }).catch(() => {});
  cleanupSession();
  clientShow('idle');
});

async function copyText(btn, value, okMsg) {
  setBusy(btn, true);
  const r = await enot.copy(value);
  text($('copy-status'), r.ok ? okMsg : (r.error ?? 'Не удалось скопировать'));
  setBusy(btn, false);
}
$('btn-copy-id').addEventListener('click', (e) => copyText(e.currentTarget, state.session?.sessionId ?? '', 'ID скопирован'));
$('btn-copy-password').addEventListener('click', (e) => copyText(e.currentTarget, state.session?.password ?? '', 'Пароль скопирован'));
$('btn-copy-both').addEventListener('click', (e) => copyText(e.currentTarget, `ID: ${state.session?.sessionId}\nПароль: ${state.session?.password}`, 'Скопировано'));

$('btn-allow').addEventListener('click', () => decide(true));
$('btn-deny').addEventListener('click', () => decide(false));

async function decide(allow) {
  const { sessionId, claimId } = state.pendingClaim ?? {};
  setBusy($('btn-allow'), true);
  try {
    const res = await enot.request('session.decision', { sessionId, claimId, allow });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? 'Ошибка подтверждения');
    if (!allow) { cleanupSession(); clientShow('idle'); }
    // при allow ждём approved из сигналинга
  } catch (e) {
    text($('ended-reason'), e.message);
    cleanupSession();
    clientShow('ended');
  } finally {
    setBusy($('btn-allow'), false);
  }
}

$('btn-stop').addEventListener('click', endByHost);
$('btn-end-session').addEventListener('click', endByHost);

async function endByHost() {
  await enot.request('session.end', { sessionId: state.session?.sessionId, asHost: true }).catch(() => {});
  cleanupSession();
  text($('ended-reason'), 'Вы завершили доступ. Для следующей помощи нужна новая регистрация.');
  clientShow('ended');
}
$('btn-again').addEventListener('click', () => { cleanupSession(); clientShow('idle'); });

function cleanupSession() {
  stopMedia();
  enot.closeSignal().catch(() => {});
  state.session = null;
  state.pendingClaim = null;
  state.connect = null;
}

function stopMedia() {
  try { state.localStream?.getTracks().forEach((t) => t.stop()); } catch { /* треки уже остановлены */ }
  try { state.dc?.close(); } catch { /* уже закрыт */ }
  try { state.pc?.close(); } catch { /* уже закрыт */ }
  state.localStream = null; state.dc = null; state.pc = null; state.iceQueue = [];
  $('remote-video').srcObject = null;
}

// ---------- WebRTC: host — offerer, operator — answerer, ICE в очереди ----------

function makePc(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = (e) => {
    if (e.candidate) enot.sendSignal({ type: 'signal', data: { candidate: e.candidate.toJSON() } }).catch(() => {});
  };
  // Host-сторона: принимает datachannel оператора; сырой кадр уходит в main,
  // где парс/валидация/ворота/диспетчер — единый код (input-pipeline.mjs).
  pc.ondatachannel = (e) => {
    e.channel.onmessage = (m) => { enot.input(m.data).catch(() => {}); };
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && (state.session || state.connect)) {
      // Потеря RTC — завершение и понятная ошибка, не вечный connected (R15.2)
      const wasClient = state.role === 'client' || !!state.session;
      cleanupSession();
      if (wasClient) { text($('ended-reason'), END_REASONS.rtc); clientShow('ended'); }
      else { showConnectForm(); text($('conn-error'), END_REASONS.rtc); }
    }
  };
  return pc;
}

function drainIce(pc) {
  for (const c of state.iceQueue) pc.addIceCandidate(c).catch(() => {});
  state.iceQueue = [];
}

async function startHostRtc() {
  const srcs = await enot.sources();
  if (!srcs.items?.length) throw new Error('Экраны не найдены: разрешение на запись экрана не выдано или захват недоступен');
  // выбор источника: экраны отдельно, окна — по одному
  const pick = document.createElement('div');
  pick.className = 'card';
  pick.innerHTML = '<h2>Что показать оператору?</h2><p class="muted">Выберите экран или окно. Трансляция начнётся после выбора.</p>';
  const list = document.createElement('div');
  list.className = 'list';
  for (const s of srcs.items) {
    const item = document.createElement('button');
    item.className = 'btn wide';
    item.textContent = s.name || '(без названия)';
    item.addEventListener('click', () => chooseSource(s.id, pick));
    list.appendChild(item);
  }
  pick.appendChild(list);
  $('view-client').appendChild(pick);

  async function chooseSource(id, pickEl) {
    setBusyAll(list, true);
    const sel = await enot.selectSource(id);
    if (!sel.ok) { text($('client-error-text'), sel.error ?? 'Источник недоступен'); clientShow('error'); pickEl.remove(); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      const perms = await enot.permissions();
      const hint = perms.platform === 'darwin'
        ? 'Разрешите запись экрана: Системные настройки → Конфиденциальность и безопасность → Запись экрана, затем перезапустите ЕнотDesk.'
        : 'Захват экрана запрещён системой. Предоставьте разрешение и попробуйте снова.';
      text($('client-error-text'), hint);
      clientShow('error');
      pickEl.remove();
      return;
    }
    pickEl.remove();
    state.localStream = stream;
    const cfg = await enot.request('rtc.config', { asHost: true });
    const pc = makePc(cfg.body?.iceServers ?? []);
    state.pc = pc;
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await enot.sendSignal({ type: 'signal', data: { description: { type: 'offer', sdp: pc.localDescription.sdp } } });
    clientShow('connected');
  }
}

function setBusyAll(container, busy) {
  for (const btn of container.querySelectorAll('button')) btn.disabled = busy;
}

async function operatorAnswer(offerSdp) {
  const cfg = await enot.request('rtc.config', {});
  const pc = makePc(cfg.body?.iceServers ?? []);
  state.pc = pc;
  state.dc = pc.createDataChannel('input');
  wireOperatorInput(state.dc);
  pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0]; };
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  drainIce(pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await enot.sendSignal({ type: 'signal', data: { description: { type: 'answer', sdp: pc.localDescription.sdp } } });
}

// ---------- сигналинг: единая точка входа событий ----------

enot.onSignal(async (msg) => {
  switch (msg.type) {
    case 'ready':
      break;
    case 'claim':
      // Клиент подтверждает видимое имя авторизованного оператора (R15/R15.3)
      state.pendingClaim = { sessionId: state.session?.sessionId, claimId: msg.claimId };
      text($('consent-operator'), msg.operator?.name ?? 'неизвестный оператор');
      clientShow('consent');
      break;
    case 'approved':
      if (state.role === 'client' && state.session) {
        clientShow('connected');
        text($('connected-operator'), document.getElementById('consent-operator').textContent);
        try { await startHostRtc(); } catch (e) {
          text($('client-error-text'), e.message);
          clientShow('error');
        }
      } else if (state.role === 'operator') {
        show($('op-waiting'));
        text($('remote-status'), 'Ожидаем экран клиента…');
      }
      break;
    case 'signal':
      try {
        if (msg.data?.description) {
          if (state.role === 'operator' && msg.data.description.type === 'offer') {
            await operatorAnswer(msg.data.description.sdp);
            show($('op-remote'));
            hide($('op-waiting'));
            text($('remote-status'), 'Подключено');
          } else if (state.role === 'client' && state.pc && msg.data.description.type === 'answer') {
            await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.data.description.sdp });
            drainIce(state.pc);
          }
        } else if (msg.data?.candidate) {
          const c = msg.data.candidate;
          if (state.pc && state.pc.remoteDescription) await state.pc.addIceCandidate(c);
          else state.iceQueue.push(c); // кандидаты в очередь до remote description
        }
      } catch { /* некорректный сигнал игнорируется: транспорт не открывается */ }
      break;
    case 'ended':
      stopMedia();
      enot.closeSignal().catch(() => {});
      const clientSide = state.role === 'client';
      state.session = null; state.pendingClaim = null; state.connect = null;
      if (clientSide) {
        text($('ended-reason'), END_REASONS[msg.reason] ?? `Сеанс завершён (${msg.reason ?? 'причина неизвестна'}).`);
        clientShow('ended');
      } else {
        showConnectForm();
        text($('conn-error'), END_REASONS[msg.reason] ?? `Сеанс завершён (${msg.reason ?? 'причина неизвестна'}).`);
      }
      break;
    case 'error':
      if (state.role === 'client' && state.session) { text($('client-error-text'), msg.message ?? 'Ошибка сервера'); clientShow('error'); }
      break;
    default:
      break;
  }
});

// ---------- оператор ----------

function showConnectForm() { show($('op-connect-form')); hide($('op-waiting')); hide($('op-remote')); }

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-login');
  setBusy(btn, true, 'Входим…');
  text($('login-error'), '');
  try {
    const res = await enot.request('login', {
      login: $('login-name').value.trim(),
      password: $('login-password').value,
    });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? 'Не удалось войти');
    state.me = res.body.user;
    text($('op-who'), `${state.me.name} (${roleName(state.me.role)})`);
    hide($('op-login'));
    show($('op-work'));
    loadContactsIntoSelect();
  } catch (err) {
    text($('login-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

function roleName(r) { return { admin: 'администратор', operator: 'оператор', auditor: 'наблюдатель' }[r] ?? r; }

$('btn-logout').addEventListener('click', async () => {
  await enot.request('logout', {}).catch(() => {});
  state.me = null;
  hide($('op-work'));
  show($('op-login'));
});

$('form-invite-accept').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-accept-invite');
  setBusy(btn, true, 'Принимаем…');
  text($('invite-accept-error'), ''); text($('invite-accept-status'), '');
  try {
    // из ссылки берём фрагмент #token=…, иначе считаем, что введён сам код
    let code = $('invite-code').value.trim();
    if (code.includes('#token=')) code = code.split('#token=')[1].split('&')[0];
    if (code.includes('/invite')) code = '';
    const res = await enot.request('invite.accept', {
      token: code,
      login: $('invite-login').value.trim(),
      name: $('invite-name').value.trim(),
      password: $('invite-password').value,
    });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? 'Приглашение не принято');
    text($('invite-accept-status'), 'Готово! Теперь войдите с вашим логином и паролем.');
  } catch (err) {
    text($('invite-accept-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

$('btn-connect').addEventListener('click', async () => {
  const btn = $('btn-connect');
  setBusy(btn, true, 'Подключаемся…');
  text($('conn-error'), '');
  try {
    const res = await enot.request('session.claim', {
      sessionId: $('conn-session-id').value.replace(/\s+/g, ''),
      password: $('conn-password').value,
      contactId: $('conn-contact').value || undefined,
    });
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? 'Не удалось подключиться');
    state.connect = { sessionId: res.body.sessionId, claimId: res.body.claimId };
    await enot.openSignal({ role: 'operator', sessionId: res.body.sessionId, claimId: res.body.claimId });
    hide($('op-connect-form'));
    show($('op-waiting'));
  } catch (err) {
    text($('conn-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

$('btn-cancel-connect').addEventListener('click', async () => {
  await enot.request('session.end', { sessionId: state.connect?.sessionId }).catch(() => {});
  cleanupSession();
  showConnectForm();
});

// Ввод: ограниченный протокол, частота ограничена, координаты 0..1.
// Allowlist клавиш — единый источник в main (protocol.mjs), приходит через permissions().
let allowedKeys = null;
function ensureKeys() {
  allowedKeys ??= enot.permissions().then((p) => new Set(p.inputKeys ?? [])).catch(() => new Set());
  return allowedKeys;
}

const KEY_MAP = (k) => {
  if (/^[a-zа-яё0-9]$/i.test(k)) return k.toLowerCase();
  const map = { ' ': 'space', Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Shift: 'shift', Control: 'control', Alt: 'alt', Meta: 'meta' };
  return map[k] ?? null;
};

let keyErrorReset = null;
function showKeyError(key) {
  // неподдерживаемая клавиша честно отклоняется с видимой ошибкой, не молча
  text($('remote-status'), `Клавиша «${key}» не поддерживается`);
  clearTimeout(keyErrorReset);
  keyErrorReset = setTimeout(() => text($('remote-status'), 'Подключено'), 2000);
}

function wireOperatorInput(dc) {
  const video = $('remote-video');
  video.tabIndex = 0;
  let lastMove = 0;
  const send = (obj) => {
    if (dc.readyState !== 'open') return;
    try { dc.send(JSON.stringify(obj)); } catch { /* канал закрывается — ввод прекращается */ }
  };
  const norm = (e) => {
    const r = video.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  video.onmousemove = (e) => {
    const now = Date.now();
    if (now - lastMove < 25) return; // не чаще ~40 событий/с
    lastMove = now;
    const { x, y } = norm(e);
    send({ type: 'move', x, y });
  };
  video.onmousedown = (e) => {
    const btnName = { 0: 'left', 1: 'middle', 2: 'right' }[e.button];
    if (btnName) { e.preventDefault(); send({ type: 'button', button: btnName, down: true }); }
  };
  video.onmouseup = (e) => {
    const btnName = { 0: 'left', 1: 'middle', 2: 'right' }[e.button];
    if (btnName) send({ type: 'button', button: btnName, down: false });
  };
  video.oncontextmenu = (e) => e.preventDefault();
  video.onwheel = (e) => {
    e.preventDefault();
    send({ type: 'scroll', dx: Math.max(-1000, Math.min(1000, e.deltaX)), dy: Math.max(-1000, Math.min(1000, e.deltaY)) });
  };
  video.onkeydown = async (e) => {
    const key = KEY_MAP(e.key);
    if (!key) { showKeyError(e.key); return; }
    e.preventDefault();
    const allowed = await ensureKeys();
    if (!allowed.has(key)) { showKeyError(e.key); return; }
    send({ type: 'key', key, down: true });
  };
  video.onkeyup = async (e) => {
    const key = KEY_MAP(e.key);
    if (!key) return;
    e.preventDefault();
    const allowed = await ensureKeys();
    if (!allowed.has(key)) return; // keydown уже отклонён с ошибкой; up молчать нечему
    send({ type: 'key', key, down: false });
  };
}

// ---------- адресная книга ----------

async function fetchList(op, params) {
  const res = await enot.request(op, params);
  if (res.status !== 200) throw new Error(res.body?.error?.message ?? `Ошибка ${res.status}`);
  return res.body;
}

async function renderContacts() {
  const box = $('contacts-list');
  box.textContent = '';
  text($('contacts-status'), 'Загрузка…');
  try {
    const body = await fetchList('contacts.list', { q: state.query.contacts || undefined, limit: 20, offset: state.pages.contacts * 20 });
    box.textContent = '';
    if (!body.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = state.query.contacts
        ? 'Ничего не найдено. Измените запрос.'
        : 'Книга пуста. Нажмите «Добавить», чтобы создать первый контакт.';
      box.appendChild(empty);
    }
    for (const c of body.items) box.appendChild(contactItem(c));
    text($('contacts-page'), `Стр. ${state.pages.contacts + 1}, всего ${body.total}`);
    $('contacts-prev').disabled = state.pages.contacts === 0;
    $('contacts-next').disabled = (state.pages.contacts + 1) * 20 >= body.total;
    text($('contacts-status'), '');
  } catch (e) {
    text($('contacts-status'), '');
    const err = document.createElement('p');
    err.className = 'err-text';
    err.textContent = e.message;
    box.appendChild(err);
  }
}

function contactItem(c) {
  const item = document.createElement('div');
  item.className = 'list-item';
  const main = document.createElement('div');
  main.className = 'grow';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = c.name;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = c.notes ? c.notes.slice(0, 120) : '';
  main.append(title, sub);
  item.appendChild(main);
  for (const t of (c.tags ?? []).slice(0, 10)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = t;
    item.appendChild(tag);
  }
  const edit = document.createElement('button');
  edit.className = 'btn small';
  edit.textContent = 'Изменить';
  edit.addEventListener('click', () => openContactEditor(c));
  const del = document.createElement('button');
  del.className = 'btn small danger-ghost';
  del.textContent = 'Удалить';
  del.addEventListener('click', async () => {
    if (!window.confirm(`Удалить контакт «${c.name}»?`)) return; // явное подтверждение удаления
    const res = await enot.request('contacts.delete', { id: c.id, revision: c.revision });
    if (res.status !== 200) text($('contacts-status'), res.body?.error?.message ?? 'Не удалось удалить');
    else renderContacts();
  });
  item.append(edit, del);
  return item;
}

let editingContact = null;
function openContactEditor(c) {
  editingContact = c ?? null;
  text($('contact-editor-title'), c ? 'Изменить контакт' : 'Новый контакт');
  $('contact-name').value = c?.name ?? '';
  $('contact-notes').value = c?.notes ?? '';
  $('contact-tags').value = (c?.tags ?? []).join(', ');
  text($('contact-error'), '');
  show($('contact-editor'));
  $('contact-name').focus();
}
$('btn-contact-add').addEventListener('click', () => openContactEditor(null));
$('btn-contact-cancel').addEventListener('click', () => hide($('contact-editor')));

$('form-contact').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-contact-save');
  setBusy(btn, true, 'Сохраняем…');
  text($('contact-error'), '');
  const name = $('contact-name').value.trim();
  if (!name || name.length > 120) { text($('contact-error'), 'Имя обязательно (1–120 символов)'); setBusy(btn, false); return; }
  const tags = $('contact-tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10);
  const base = { name, notes: $('contact-notes').value, tags };
  const res = editingContact
    ? await enot.request('contacts.update', { id: editingContact.id, ...base, revision: editingContact.revision })
    : await enot.request('contacts.create', base);
  setBusy(btn, false);
  if (res.status === 409) {
    text($('contact-error'), 'Контакт изменён кем-то другим. Проверьте актуальную версию и повторите.');
    renderContacts();
    return;
  }
  if (res.status !== 200 && res.status !== 201) {
    text($('contact-error'), res.body?.error?.message ?? 'Не удалось сохранить');
    return;
  }
  hide($('contact-editor'));
  renderContacts();
});

$('form-contact-search').addEventListener('submit', (e) => {
  e.preventDefault();
  state.query.contacts = $('contact-search').value.trim();
  state.pages.contacts = 0;
  renderContacts();
});
$('contacts-prev').addEventListener('click', () => { state.pages.contacts = Math.max(0, state.pages.contacts - 1); renderContacts(); });
$('contacts-next').addEventListener('click', () => { state.pages.contacts += 1; renderContacts(); });

async function loadContactsIntoSelect() {
  const sel = $('conn-contact');
  sel.textContent = '';
  const opt0 = document.createElement('option');
  opt0.value = ''; opt0.textContent = '—';
  sel.appendChild(opt0);
  try {
    const body = await fetchList('contacts.list', { limit: 100 });
    for (const c of body.items) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    }
  } catch { /* пустой список выбора — не критично */ }
}

// ---------- команда ----------

async function renderTeam() {
  const box = $('members-list');
  const ibox = $('invites-list');
  box.textContent = ''; ibox.textContent = '';
  text($('team-status'), 'Загрузка…');
  text($('team-error'), '');
  try {
    const [members, invites] = await Promise.all([
      fetchList('members.list', {}),
      fetchList('invites.list', {}).catch(() => ({ items: [], total: 0 })), // не-admin не видит приглашения
    ]);
    box.textContent = '';
    if (!members.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Команда пуста. Создайте приглашение ниже и отправьте его коллеге.';
      box.appendChild(empty);
    }
    for (const m of members.items) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const main = document.createElement('div');
      main.className = 'grow';
      main.innerHTML = `<div class="title"></div><div class="sub"></div>`;
      main.querySelector('.title').textContent = `${m.name} (@${m.login})`;
      main.querySelector('.sub').textContent = m.active ? 'активен' : 'отключён';
      item.appendChild(main);
      if (state.me?.role === 'admin') {
        const roleSel = document.createElement('select');
        roleSel.setAttribute('aria-label', `Роль: ${m.name}`);
        for (const [v, label] of [['admin', 'Администратор'], ['operator', 'Оператор'], ['auditor', 'Наблюдатель']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = label;
          roleSel.appendChild(o);
        }
        roleSel.value = m.role;
        roleSel.addEventListener('change', () => patchMember(m, { role: roleSel.value }));
        const toggle = document.createElement('button');
        toggle.className = 'btn small';
        toggle.textContent = m.active ? 'Отключить' : 'Включить';
        toggle.addEventListener('click', () => patchMember(m, { active: !m.active }));
        item.append(roleSel, toggle);
      }
      box.appendChild(item);
    }
    ibox.textContent = '';
    if (!invites.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Активных приглашений нет. Создайте одноразовое приглашение и передайте его в чате.';
      ibox.appendChild(empty);
    }
    for (const inv of invites.items) {
      const item = document.createElement('div');
      item.className = 'list-item';
      const main = document.createElement('div');
      main.className = 'grow';
      main.innerHTML = '<div class="title"></div><div class="sub"></div>';
      main.querySelector('.title').textContent = `Приглашение на роль: ${roleName(inv.role)}`;
      main.querySelector('.sub').textContent = `действует до ${new Date(inv.expiresAt).toLocaleString('ru')}`;
      const revoke = document.createElement('button');
      revoke.className = 'btn small danger-ghost';
      revoke.textContent = 'Отозвать';
      revoke.addEventListener('click', async () => {
        const res = await enot.request('invites.revoke', { id: inv.id });
        if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? 'Не удалось отозвать');
        else renderTeam();
      });
      item.append(main, revoke);
      ibox.appendChild(item);
    }
    text($('team-status'), '');
  } catch (e) {
    text($('team-status'), '');
    text($('team-error'), e.message);
  }
}

async function patchMember(m, patch) {
  const res = await enot.request('members.patch', { id: m.id, ...patch });
  if (res.status !== 200) text($('team-error'), res.body?.error?.message ?? 'Не удалось изменить участника');
  else renderTeam();
}

$('form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-invite-create');
  setBusy(btn, true, 'Создаём…');
  text($('invite-result'), ''); text($('team-error'), '');
  try {
    const res = await enot.request('invites.create', { role: $('invite-role').value });
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? 'Не удалось создать приглашение');
    // одноразовый токен приглашения — единственный токен, отдаваемый на рендерер
    const url = res.body.url || `${res.body.token}`;
    text($('invite-result'), `Приглашение (одноразовое, скопируйте и отправьте): ${url}`);
    await enot.copy(url);
    renderTeam();
  } catch (err) {
    text($('team-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

// ---------- история и журнал ----------

function renderTimeList(box, statusEl, items, emptyText, format) {
  box.textContent = '';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    box.appendChild(empty);
    return;
  }
  for (const it of items) {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = '<div class="grow"><div class="title"></div><div class="sub"></div></div>';
    item.querySelector('.title').textContent = format.title(it);
    item.querySelector('.sub').textContent = format.sub(it);
    box.appendChild(item);
  }
}

async function renderHistory() {
  const box = $('history-list');
  text($('history-status'), 'Загрузка…');
  try {
    const body = await fetchList('history.list', { limit: 20, offset: state.pages.history * 20 });
    renderTimeList(box, $('history-status'), body.items,
      'История пуста. Здесь появятся завершённые сеансы помощи.',
      {
        title: (it) => `Сеанс ${it.sessionId} — ${it.state}`,
        sub: (it) => `${it.operatorName ?? '—'} · ${new Date(it.createdAt).toLocaleString('ru')} · причина: ${it.endReason ?? '—'}`,
      });
    text($('history-page'), `Стр. ${state.pages.history + 1}, всего ${body.total}`);
    $('history-prev').disabled = state.pages.history === 0;
    $('history-next').disabled = (state.pages.history + 1) * 20 >= body.total;
    text($('history-status'), '');
  } catch (e) {
    text($('history-status'), e.message);
  }
}

async function renderAudit() {
  const box = $('audit-list');
  text($('audit-status'), 'Загрузка…');
  try {
    const body = await fetchList('audit.list', { limit: 20, offset: state.pages.audit * 20 });
    renderTimeList(box, $('audit-status'), body.items,
      'Журнал пуст. Действия команды будут записываться сюда автоматически.',
      {
        title: (it) => `${it.action}`,
        sub: (it) => `${new Date(it.createdAt).toLocaleString('ru')}${it.detail && typeof it.detail === 'string' ? ` · ${it.detail}` : ''}`,
      });
    text($('audit-page'), `Стр. ${state.pages.audit + 1}, всего ${body.total}`);
    $('audit-prev').disabled = state.pages.audit === 0;
    $('audit-next').disabled = (state.pages.audit + 1) * 20 >= body.total;
    text($('audit-status'), '');
  } catch (e) {
    text($('audit-status'), e.message);
  }
}
$('history-prev').addEventListener('click', () => { state.pages.history = Math.max(0, state.pages.history - 1); renderHistory(); });
$('history-next').addEventListener('click', () => { state.pages.history += 1; renderHistory(); });
$('audit-prev').addEventListener('click', () => { state.pages.audit = Math.max(0, state.pages.audit - 1); renderAudit(); });
$('audit-next').addEventListener('click', () => { state.pages.audit += 1; renderAudit(); });

for (const btn of document.querySelectorAll('.side-tab')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.side-tab')) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); }
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    for (const pane of document.querySelectorAll('.pane')) hide(pane);
    show($('pane-' + btn.dataset.pane));
    if (btn.dataset.pane === 'contacts') renderContacts();
    if (btn.dataset.pane === 'team') renderTeam();
    if (btn.dataset.pane === 'history') renderHistory();
    if (btn.dataset.pane === 'audit') renderAudit();
  });
}

// ---------- настройки ----------

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', () => hide($('settings-overlay')));

async function openSettings() {
  const s = await enot.getSettings();
  $('settings-url').value = s.serverUrl;
  text($('settings-status'), s.firstRun ? 'Первый запуск: укажите адрес сервера ЕнотDesk.' : '');
  text($('settings-error'), '');
  text($('perm-report'), '');
  show($('settings-overlay'));
  $('settings-url').focus();
}

$('btn-settings-save').addEventListener('click', async () => {
  const btn = $('btn-settings-save');
  setBusy(btn, true, 'Проверяем…');
  text($('settings-error'), ''); text($('settings-status'), '');
  try {
    const r = await enot.setServerUrl($('settings-url').value.trim());
    if (!r.ok) throw new Error(r.error ?? 'Не удалось сохранить');
    const health = await enot.request('health', {});
    if (health.status !== 200) throw new Error('Сервер ответил ошибкой — проверьте адрес');
    text($('settings-status'), `Сервер доступен, версия ${health.body?.version ?? '—'}`);
    const perms = await enot.permissions();
    const notes = [];
    if (perms.platform === 'darwin' && perms.screenCapture !== 'granted') notes.push('Запись экрана на macOS не разрешена — разрешите в Системных настройках.');
    if (perms.wayland) notes.push(perms.controlNote);
    if (perms.nativeInput && !perms.nativeInput.available) notes.push('Нативный ввод недоступен: управление мышью/клавиатурой работать не будет.');
    text($('perm-report'), notes.join(' '));
  } catch (e) {
    text($('settings-error'), `Сервер недоступен: ${e.message}`);
  } finally {
    setBusy(btn, false);
  }
});

// ---------- запуск ----------

(async function boot() {
  const s = await enot.getSettings();
  if (s.firstRun) openSettings(); // первый запуск: экран адреса сервера
})();

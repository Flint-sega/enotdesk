// Сессионные сервисы поверх DataChannel (ADR 0014): чат, буфер обмена,
// передача файлов. Вся сетевая логика — через window.enot и state.

import { $, enot, text, show, hide } from './dom.js';
import { state } from './state.js';
import { t } from '../lib/i18n.mjs';
import { parseChatMessage, chatMessage } from '../lib/chat.mjs';
// Чистый модуль без node-импортов: lib/term.mjs тянет node:child_process,
// который в sandbox-рендерере блокируется CSP и роняет весь модульный граф.
import { rejectTermChannel } from '../lib/term-protocol.mjs';
import { parseClipMessage, clipMessage } from '../lib/clipboard-sync.mjs';
import {
  parseFileControl, createFileReceiver, createFileSender,
  fileMeta, fileAccept, fileReject, makeFileId,
} from '../lib/file-transfer.mjs';

let unreadChat = 0;
// whoKey: 'you' | 'operator' | 'client' | 'system' — подпись берётся из словаря,
// а класс строки (me/them) определяется ключом, не переведённым текстом.
export function appendChat(logId, whoKey, value) {
  const log = $(logId);
  const line = document.createElement('p');
  line.className = `chat-line chat-${whoKey === 'you' ? 'me' : 'them'}`;
  const name = document.createElement('strong');
  name.textContent = `${t(`chat.${whoKey}`)}: `;
  line.appendChild(name);
  line.appendChild(document.createTextNode(value));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // оператор в другой вкладке — честный счётчик непрочитанного на вкладке «Подключение»
  if (logId === 'op-chat-log' && whoKey !== 'you' && state.activePane !== 'connect') {
    unreadChat += 1;
    text(document.querySelector('.side-tab[data-pane="connect"]'), t('op.paneConnectUnread', { count: unreadChat }));
  }
}

export function resetUnreadChat() {
  unreadChat = 0;
}

function sendChat(side) {
  const input = $(side === 'client' ? 'client-chat-input' : 'op-chat-input');
  const logId = side === 'client' ? 'client-chat-log' : 'op-chat-log';
  const value = input.value.trim();
  if (!value) return;
  const wire = chatMessage(value);
  if (!wire) { input.value = ''; return; }
  if (side === 'client') {
    // Мультиоператор: сообщение клиента уходит ВСЕМ присоединённым операторам
    let sent = false;
    for (const dc of hostOperatorChannels('chat')) {
      try { dc.send(wire); sent = true; } catch { /* канал закрывается */ }
    }
    if (!sent) return;
    appendChat(logId, 'you', value);
    input.value = '';
    return;
  }
  const dc = state.dcs?.chat;
  if (!dc || dc.readyState !== 'open') return;
  try { dc.send(wire); } catch { /* канал закрывается */ return; }
  appendChat(logId, 'you', value);
  input.value = '';
}
$('client-chat-send').addEventListener('click', () => sendChat('client'));
$('op-chat-send').addEventListener('click', () => sendChat('op'));
for (const id of ['client-chat-input', 'op-chat-input']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(id === 'client-chat-input' ? 'client' : 'op'); }
  });
}

// Host-сторона: приём каналов оператора. opKey (claimId) различает операторов —
// каналы keyed `${label}:${opKey}`; ввод ЛЮБОГО оператора идёт в одну очередь
// инъекции (last-write-wins, модель RustDesk).
export function wireHostChannel(ch, opKey = 'primary') {
  state.dcs ??= {};
  state.dcs[`${ch.label}:${opKey}`] = ch;
  // Зеркало в персональную карту оператора: fan-out (чат/буфер) и дроп
  // читают op.dcs, keyed-запись в state.dcs — плоский индекс.
  const op = state.operators.get(opKey);
  if (op) { op.dcs ??= {}; op.dcs[ch.label] = ch; }
  if (ch.label === 'input') {
    ch.onmessage = (m) => { enot.input(m.data).catch(() => {}); };
  } else if (ch.label === 'chat') {
    ch.onmessage = (m) => {
      const msg = parseChatMessage(m.data);
      if (!msg) return;
      appendChat('client-chat-log', 'operator', msg.text);
      // чат-виджет в углу (спека владельца 02.10): показываем сообщение оператора
      enot.chatWidgetMsg?.(msg.text);
    };
  } else if (ch.label === 'clip') {
    ch.onmessage = (m) => {
      const msg = parseClipMessage(m.data);
      if (msg && state.clip.client) enot.copy(msg.text).catch(() => { /* буфер недоступен */ });
    };
  } else if (ch.label === 'file') {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (m) => hostFileMessage(ch, m.data, opKey);
  } else if (ch.label === 'term') {
    // Терминал — только machine-сеанс (R09): человек-хост честно отказывает.
    rejectTermChannel(ch);
  }
}

// Открытые каналы `label` всех присоединённых операторов (fan-out клиентских
// сообщений: чат/буфер/файл).
function hostOperatorChannels(label) {
  const out = [];
  for (const op of state.operators.values()) {
    const ch = op.dcs?.[label];
    if (ch?.readyState === 'open') out.push(ch);
  }
  return out;
}

// Ответ клиента из чат-виджета: отправка в DC чата + лог основного окна
// (маршрут: виджет → main → onChatWidgetOut). Вызывается из session-media.
export function sendWidgetChat(text) {
  const wire = chatMessage(text);
  if (!wire) return;
  let sent = false;
  for (const dc of hostOperatorChannels('chat')) {
    try { dc.send(wire); sent = true; } catch { /* канал закрывается */ }
  }
  if (!sent) return;
  appendChat('client-chat-log', 'you', text);
}

export function listenChatWidgetOut() {
  enot.onChatWidgetOut?.((text) => sendWidgetChat(String(text ?? '').slice(0, 2000)));
}

// Исходящий буфер: событие copy уходит в канал, только если синхронизация включена.
document.addEventListener('copy', () => {
  const on = state.role === 'client' ? state.clip.client : state.clip.operator;
  if (!on) return;
  const selected = String(document.getSelection?.() ?? '');
  const wire = clipMessage(selected);
  if (!wire) return;
  if (state.role === 'client') {
    // Мультиоператор: буфер уходит всем присоединённым операторам
    for (const dc of hostOperatorChannels('clip')) {
      try { dc.send(wire); } catch { /* канал закрывается */ }
    }
    return;
  }
  const dc = state.dcs?.clip;
  if (!dc || dc.readyState !== 'open') return;
  try { dc.send(wire); } catch { /* канал закрывается */ }
});
$('clip-client-toggle').addEventListener('change', (e) => { state.clip.client = e.target.checked; });
$('clip-op-toggle').addEventListener('change', (e) => { state.clip.operator = e.target.checked; });

// Приём файлов per-оператор (key = claimId): файловые каналы независимы.
const fileRxs = new Map(); // opKey → {rx, dc, prog}

// Уборка при дропе оператора (конец сеанса / смерть его pc): недокачанный
// приёмник не должен переживать канал.
export function resetFileReceivers(opKey) {
  if (opKey === undefined) fileRxs.clear();
  else fileRxs.delete(opKey);
}

function showFileProgress(rx) {
  return () => {
    if (!rx || !rx.prog) return;
    rx.prog.textContent = t('files.progress', {
      got: (rx.received / 1048576).toFixed(1),
      total: (rx.meta.size / 1048576).toFixed(1),
    });
  };
}

function saveReceivedBlob(blob, name, box) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = t('files.saveLink', { name, size: (blob.size / 1048576).toFixed(1) });
  box.textContent = '';
  box.appendChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Клиент: оператор отправляет файл — явное «Принять/Отклонить» обязательно.
// Приём per-оператор (key = claimId): файловые каналы независимы.
function hostFileMessage(ch, data, opKey) {
  if (typeof data === 'string') {
    const ctl = parseFileControl(data);
    if (!ctl) return;
    if (ctl.kind === 'meta') {
      const rx = createFileReceiver(ctl);
      const prog = document.createElement('p');
      prog.className = 'note';
      fileRxs.set(opKey, { rx, dc: ch, prog });
      const box = $('client-file-prompt');
      box.textContent = '';
      const label = document.createElement('p');
      label.textContent = t('files.fromOperator', { name: ctl.name, size: (ctl.size / 1048576).toFixed(1) });
      const accept = document.createElement('button');
      accept.className = 'btn';
      accept.textContent = t('files.accept');
      accept.addEventListener('click', () => {
        try { ch.send(fileAccept(ctl.id)); } catch { /* канал закрыт */ }
        box.textContent = '';
        box.appendChild(prog);
      });
      const reject = document.createElement('button');
      reject.className = 'btn danger-ghost';
      reject.textContent = t('files.reject');
      reject.addEventListener('click', () => {
        fileRxs.delete(opKey);
        box.textContent = '';
        try { ch.send(fileReject(ctl.id)); } catch { /* канал закрыт */ }
      });
      box.append(label, accept, reject);
    } else if (ctl.kind === 'done') {
      const entry = fileRxs.get(opKey);
      const { rx } = entry ?? {};
      if (!rx) return;
      const blob = rx.complete();
      const name = rx.meta.name;
      fileRxs.delete(opKey);
      if (!blob) { appendChat('client-chat-log', 'system', t('files.broken')); return; }
      saveReceivedBlob(blob, name, $('client-file-prompt'));
    }
    return;
  }
  const { rx } = fileRxs.get(opKey) ?? {};
  if (rx?.push(data)) showFileProgress(rx)();
}

// Оператор: клиент шлёт файл только по своему явному действию — принимаем сами.
export function operatorFileMessage(ch, data) {
  if (typeof data === 'string') {
    const ctl = parseFileControl(data);
    if (!ctl) return;
    if (ctl.kind === 'meta') {
      state.fileRx = { rx: createFileReceiver(ctl), dc: ch, prog: null };
      try { ch.send(fileAccept(ctl.id)); } catch { /* канал закрыт */ }
      text($('file-op-status'), t('files.clientSending', { name: ctl.name }));
    } else if (ctl.kind === 'done') {
      const { rx } = state.fileRx ?? {};
      if (!rx) return;
      const blob = rx.complete();
      const name = rx.meta.name;
      state.fileRx = null;
      text($('file-op-status'), '');
      if (!blob) { text($('file-op-status'), t('files.brokenShort')); return; }
      saveReceivedBlob(blob, name, $('op-file-list'));
    } else if (ctl.kind === 'reject') {
      text($('file-op-status'), t('files.clientRejected'));
    }
  }
}

// Операторские приёмники чата и буфера (каналы создаёт operatorAnswer).
export function operatorChatMessage(value) {
  appendChat('op-chat-log', 'client', value);
}

// SEC-002 (desktop, зеркально web-оператору): входящий текст НЕ пишется в буфер
// оператора автоматически — вредоносный клиент мог бы молча подменять буфер.
// Текст держится в памяти и попадает в буфер только по явному клику
// «Вставить из сеанса»; новый текст заменяет ожидающий.
let pendingClip = null;

export function operatorClipMessage(value) {
  pendingClip = value;
  show($('btn-op-clip-paste'));
}

export function resetOperatorClip() {
  pendingClip = null;
  hide($('btn-op-clip-paste')); // текст сеанса не переживает сеанс
}

$('btn-op-clip-paste').addEventListener('click', () => {
  const value = pendingClip;
  if (!value) return;
  pendingClip = null;
  hide($('btn-op-clip-paste'));
  // единственное место записи буфера оператора — явное действие человека
  enot.copy(value).catch(() => { /* буфер недоступен */ });
});

// Отправка файла (обе стороны): meta + чанки через один file-канал.
// Файл приходит и из input, и из drag&drop — общий путь один.
// Обе стороны видят передачу: отправителю — прогресс, получателю — «Принять»/прогресс/ссылку.
export async function sendFileFrom(side, file) {
  if (!file) return;
  let dc = state.dcs?.file;
  if (!dc && side === 'client') {
    // Мультиоператор: файловые каналы keyed `file:<claimId>`. Волна 1 шлёт
    // первому открытому каналу (адресная передача нескольким — волна 2).
    for (const key of Object.keys(state.dcs ?? {})) {
      if (key.startsWith('file:') && state.dcs[key]?.readyState === 'open') { dc = state.dcs[key]; break; }
    }
  }
  if (!dc || dc.readyState !== 'open') {
    // Фолбэк: резервный релей сервера (TTL 3 суток) — файл уходит ссылкой получателю
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const up = await enot.relayUpload(file.name, buf);
      await enot.sendFileLink({ name: up.name, size: up.size, url: up.url });
      if (side === 'client') text($('client-live-note'), t('files.relayLink', { name: up.name }));
      else text($('file-op-status'), t('files.relayLink', { name: up.name }));
    } catch { /* релей недоступен — честно молчим, канал всё равно мёртв */ }
    return;
  }
  const id = makeFileId();
  const noteEl = side === 'client' ? $('client-live-note') : null;
  const statusEl = side === 'op' ? $('file-op-status') : null;
  const show = (el, s) => { if (el) text(el, s); };
  try {
    dc.send(fileMeta(id, file.name, file.size));
    createFileSender({
      file, dc, id,
      onProgress: (sent) => show(statusEl, t('files.sendingProgress', { name: file.name, pct: Math.round((sent / file.size) * 100) })),
      onSent: () => show(statusEl, t('files.sentWaiting', { name: file.name })),
    }).start();
  } catch { /* канал закрыт */ return; }
  show(statusEl, t('files.sending', { name: file.name }));
  show(noteEl, t('files.sending', { name: file.name }));
}
function sendFile(side) {
  const input = $(side === 'client' ? 'client-file-input' : 'op-file-input');
  const file = input.files?.[0];
  input.value = '';
  sendFileFrom(side, file);
}
$('btn-client-file').addEventListener('click', () => $('client-file-input').click());
$('client-file-input').addEventListener('change', () => sendFile('client'));
$('btn-op-file').addEventListener('click', () => $('op-file-input').click());
$('op-file-input').addEventListener('change', () => sendFile('op'));

// Drag&drop файла на карточки сеанса, у обеих сторон.
function wireFileDrop(zone, side) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drop-hover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop-hover');
    sendFileFrom(side, e.dataTransfer?.files?.[0]);
  });
}
wireFileDrop($('client-connected'), 'client');
wireFileDrop($('op-remote'), 'op');

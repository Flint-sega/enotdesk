// Сессионные сервисы поверх DataChannel (ADR 0014): чат, буфер обмена,
// передача файлов. Вся сетевая логика — через window.enot и state.

import { $, enot, text } from './dom.js';
import { state } from './state.js';
import { parseChatMessage, chatMessage } from '../lib/chat.mjs';
import { parseClipMessage, clipMessage } from '../lib/clipboard-sync.mjs';
import {
  parseFileControl, createFileReceiver, createFileSender,
  fileMeta, fileAccept, fileReject, makeFileId,
} from '../lib/file-transfer.mjs';

let unreadChat = 0;
export function appendChat(logId, who, value) {
  const log = $(logId);
  const line = document.createElement('p');
  line.className = `chat-line chat-${who === 'Вы' ? 'me' : 'them'}`;
  const name = document.createElement('strong');
  name.textContent = `${who}: `;
  line.appendChild(name);
  line.appendChild(document.createTextNode(value));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // оператор в другой вкладке — честный счётчик непрочитанного на вкладке «Подключение»
  if (logId === 'op-chat-log' && who !== 'Вы' && state.activePane !== 'connect') {
    unreadChat += 1;
    text(document.querySelector('.side-tab[data-pane="connect"]'), `Подключение (${unreadChat})`);
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
  const dc = state.dcs?.chat;
  if (!dc || dc.readyState !== 'open') return;
  try { dc.send(wire); } catch { /* канал закрывается */ return; }
  appendChat(logId, 'Вы', value);
  input.value = '';
}
$('client-chat-send').addEventListener('click', () => sendChat('client'));
$('op-chat-send').addEventListener('click', () => sendChat('op'));
for (const id of ['client-chat-input', 'op-chat-input']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(id === 'client-chat-input' ? 'client' : 'op'); }
  });
}

// Host-сторона: приём каналов оператора.
export function wireHostChannel(ch) {
  state.dcs ??= {};
  state.dcs[ch.label] = ch;
  if (ch.label === 'input') {
    ch.onmessage = (m) => { enot.input(m.data).catch(() => {}); };
  } else if (ch.label === 'chat') {
    ch.onmessage = (m) => {
      const msg = parseChatMessage(m.data);
      if (msg) appendChat('client-chat-log', 'Оператор', msg.text);
    };
  } else if (ch.label === 'clip') {
    ch.onmessage = (m) => {
      const msg = parseClipMessage(m.data);
      if (msg && state.clip.client) enot.copy(msg.text).catch(() => { /* буфер недоступен */ });
    };
  } else if (ch.label === 'file') {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (m) => hostFileMessage(ch, m.data);
  }
}

// Исходящий буфер: событие copy уходит в канал, только если синхронизация включена.
document.addEventListener('copy', () => {
  const on = state.role === 'client' ? state.clip.client : state.clip.operator;
  if (!on) return;
  const dc = state.dcs?.clip;
  if (!dc || dc.readyState !== 'open') return;
  const selected = String(document.getSelection?.() ?? '');
  const wire = clipMessage(selected);
  if (!wire) return;
  try { dc.send(wire); } catch { /* канал закрывается */ }
});
$('clip-client-toggle').addEventListener('change', (e) => { state.clip.client = e.target.checked; });
$('clip-op-toggle').addEventListener('change', (e) => { state.clip.operator = e.target.checked; });

function showFileProgress(size) {
  return () => {
    const rx = state.fileRx?.rx;
    if (!rx || rx.meta.size !== size) return;
    state.fileRx.prog.textContent = `Получено ${(rx.received / 1048576).toFixed(1)} из ${(size / 1048576).toFixed(1)} МБ`;
  };
}

function saveReceivedBlob(blob, name, box) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = `Сохранить «${name}» (${(blob.size / 1048576).toFixed(1)} МБ)`;
  box.textContent = '';
  box.appendChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Клиент: оператор отправляет файл — явное «Принять/Отклонить» обязательно.
function hostFileMessage(ch, data) {
  if (typeof data === 'string') {
    const ctl = parseFileControl(data);
    if (!ctl) return;
    if (ctl.kind === 'meta') {
      const rx = createFileReceiver(ctl);
      const prog = document.createElement('p');
      prog.className = 'note';
      state.fileRx = { rx, dc: ch, prog };
      const box = $('client-file-prompt');
      box.textContent = '';
      const label = document.createElement('p');
      label.textContent = `Оператор отправляет файл «${ctl.name}» (${(ctl.size / 1048576).toFixed(1)} МБ). Принять?`;
      const accept = document.createElement('button');
      accept.className = 'btn';
      accept.textContent = 'Принять';
      accept.addEventListener('click', () => {
        try { ch.send(fileAccept(ctl.id)); } catch { /* канал закрыт */ }
        box.textContent = '';
        box.appendChild(prog);
      });
      const reject = document.createElement('button');
      reject.className = 'btn danger-ghost';
      reject.textContent = 'Отклонить';
      reject.addEventListener('click', () => {
        state.fileRx = null;
        box.textContent = '';
        try { ch.send(fileReject(ctl.id)); } catch { /* канал закрыт */ }
      });
      box.append(label, accept, reject);
    } else if (ctl.kind === 'done') {
      const { rx } = state.fileRx ?? {};
      if (!rx) return;
      const blob = rx.complete();
      const name = rx.meta.name;
      state.fileRx = null;
      if (!blob) { appendChat('client-chat-log', 'Система', 'Файл получен с ошибкой — передача прервана.'); return; }
      saveReceivedBlob(blob, name, $('client-file-prompt'));
    }
    return;
  }
  const { rx } = state.fileRx ?? {};
  if (rx?.push(data)) showFileProgress(rx.meta.size)();
}

// Оператор: клиент шлёт файл только по своему явному действию — принимаем сами.
export function operatorFileMessage(ch, data) {
  if (typeof data === 'string') {
    const ctl = parseFileControl(data);
    if (!ctl) return;
    if (ctl.kind === 'meta') {
      state.fileRx = { rx: createFileReceiver(ctl), dc: ch, prog: null };
      try { ch.send(fileAccept(ctl.id)); } catch { /* канал закрыт */ }
      text($('file-op-status'), `Клиент отправляет «${ctl.name}»…`);
    } else if (ctl.kind === 'done') {
      const { rx } = state.fileRx ?? {};
      if (!rx) return;
      const blob = rx.complete();
      const name = rx.meta.name;
      state.fileRx = null;
      text($('file-op-status'), '');
      if (!blob) { text($('file-op-status'), 'Файл получен с ошибкой'); return; }
      saveReceivedBlob(blob, name, $('op-file-list'));
    } else if (ctl.kind === 'reject') {
      text($('file-op-status'), 'Клиент отклонил файл.');
    }
  }
}

// Операторские приёмники чата и буфера (каналы создаёт operatorAnswer).
export function operatorChatMessage(value) {
  appendChat('op-chat-log', 'Клиент', value);
}
export function operatorClipMessage(value) {
  if (state.clip.operator) enot.copy(value).catch(() => { /* буфер недоступен */ });
}

// Отправка файла (обе стороны): meta + чанки через один file-канал.
// Файл приходит и из input, и из drag&drop — общий путь один.
export function sendFileFrom(side, file) {
  if (!file) return;
  const dc = state.dcs?.file;
  if (!dc || dc.readyState !== 'open') {
    if (side === 'op') text($('file-op-status'), 'Канал передачи недоступен');
    return;
  }
  const id = makeFileId();
  try {
    dc.send(fileMeta(id, file.name, file.size));
    createFileSender({ file, dc, id }).start();
  } catch { /* канал закрыт */ return; }
  if (side === 'op') text($('file-op-status'), `Отправляем «${file.name}»…`);
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

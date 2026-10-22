// Сессионные сервисы клиента помощи (host) поверх DataChannel (ADR 0014):
// чат, буфер обмена, передача файлов операторам. Вся сетевая логика — через
// window.enot и state. Операторская сторона — программа оператора с сервера.

import { $, enot, text } from './dom.js';
import { state } from './state.js';
import { t } from '../lib/i18n.mjs';
import { parseChatMessage, chatMessage } from '../lib/chat.mjs';
import { participantsMessage, parseControlMessage } from '../lib/input-arbiter.mjs';
// Чистый модуль без node-импортов: lib/term.mjs тянет node:child_process,
// который в sandbox-рендерере блокируется CSP и роняет весь модульный граф.
import { rejectTermChannel } from '../lib/term-protocol.mjs';
import { parseClipMessage, clipMessage } from '../lib/clipboard-sync.mjs';
import {
  parseFileControl, createFileReceiver, createFileSender,
  fileMeta, fileAccept, fileReject, makeFileId,
} from '../lib/file-transfer.mjs';

// whoKey: 'you' | 'operator' | 'system' — подпись берётся из словаря,
// а класс строки (me/them) определяется ключом, не переведённым текстом.
// opName (G2): имя автора для сообщений операторов («Оператор {name}»); без
// имени (старый сервер не прислал) — прежний ключ chat.operator.
export function appendChat(logId, whoKey, value, opName) {
  const log = $(logId);
  const line = document.createElement('p');
  line.className = `chat-line chat-${whoKey === 'you' ? 'me' : 'them'}`;
  const name = document.createElement('strong');
  const label = whoKey === 'operator' && opName ? t('op.messageBy', { name: opName }) : t(`chat.${whoKey}`);
  name.textContent = `${label}: `;
  line.appendChild(name);
  line.appendChild(document.createTextNode(value));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function sendChat() {
  const input = $('client-chat-input');
  const value = input.value.trim();
  if (!value) return;
  // G2: исходящие хоста помечаются from:'host' — операторы-получатели отличают
  // его от сообщений других операторов (старые клиенты поле молча игнорируют)
  const wire = chatMessage(value, { from: 'host' });
  if (!wire) { input.value = ''; return; }
  // Мультиоператор: сообщение клиента уходит ВСЕМ присоединённым операторам
  let sent = false;
  for (const dc of hostOperatorChannels('chat')) {
    try { dc.send(wire); sent = true; } catch { /* канал закрывается */ }
  }
  if (!sent) return;
  appendChat('client-chat-log', 'you', value);
  input.value = '';
}
$('client-chat-send').addEventListener('click', sendChat);
$('client-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
});

// Имя оператора для списка участников (ADR 0035): из operator-joined.
export const operatorName = (id) => state.operators.get(id)?.name ?? '';

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
    // Арбитраж ввода (W-C4): служебные claim/release перехватываются до событий
    // ввода; события уходят в main с opKey — не-активного оператора main отбросит
    // до инъекции (idle-таймер считает только разрешённые).
    ch.onmessage = (m) => {
      const svc = parseControlMessage(m.data);
      if (svc) {
        if (svc.type === 'claim-input') enot.inputClaim(opKey).catch(() => {});
        else if (svc.type === 'release-input') enot.inputRelease(opKey).catch(() => {});
        else if (svc.type === 'pass-input') enot.inputPass?.(opKey, svc.to).catch(() => {});
        else if (svc.type === 'view-only') enot.inputViewOnly?.(opKey, svc.on).catch(() => {});
        return; // служебное (и битое служебное) в инъекцию не идёт
      }
      enot.input(m.data, opKey).catch(() => {});
    };
    // Начальный input-grant (P3-1 ревью Рината, приёмка C+D): событие
    // input-active может прийти до открытия канала (inputAttach уходит раньше
    // createOffer) и потеряться на ещё не открытом канале — сливаем текущее
    // состояние арбитража оператору в момент готовности его канала.
    const sendInitialGrant = () => {
      try { ch.send(JSON.stringify({ type: 'input-grant', granted: state.inputActiveClaimId === opKey })); } catch { /* канал закрывается */ }
      // ADR 0035: и текущий состав сеанса — список мог разойтись до открытия канала
      if (state.inputParticipants) {
        try { ch.send(JSON.stringify(participantsMessage(state.inputParticipants, opKey, operatorName))); } catch { /* канал закрывается */ }
      }
    };
    // W-C5: деградация без видео — честный статус по input-каналу оператора,
    // как только канал открыт (каналы открываются после answer)
    if (op && op.noVideo) {
      const info = JSON.stringify({ type: 'session-info', video: false, reason: 'video-slots-full' });
      const sendInfo = () => { sendInitialGrant(); try { ch.send(info); } catch { /* канал закрывается */ } };
      if (ch.readyState === 'open') sendInfo();
      else ch.onopen = sendInfo;
    } else if (ch.readyState !== 'open') {
      ch.onopen = sendInitialGrant;
    } else {
      sendInitialGrant();
    }
  } else if (ch.label === 'chat') {
    ch.onmessage = (m) => {
      const msg = parseChatMessage(m.data);
      if (!msg) return;
      const opName = state.operators.get(opKey)?.name ?? '';
      appendChat('client-chat-log', 'operator', msg.text, opName);
      // чат-виджет в углу (спека владельца 02.10): показываем сообщение оператора
      enot.chatWidgetMsg?.(msg.text);
      // Мультиоператор: хост — точка fan-out и для операторов: сообщение
      // одного оператора релеется чат-каналам остальных (исходящие хоста уже
      // уходят всем — sendChat/sendWidgetChat). Приёмка C+D (16.10): раньше
      // сообщения операторов видел только хост, операторы — друг друга нет.
      // G2 (16.10): релей подписан автором (from:'operator', name) — хост
      // единственный, кто может ставить метку, оператор не подделает «хоста»;
      // старые клиенты (≤0.6.20) лишние поля игнорируют и видят текст как раньше.
      const wire = chatMessage(msg.text, { from: 'operator', ...(opName ? { name: opName } : {}) });
      if (!wire) return;
      for (const dc of hostOperatorChannels('chat')) {
        if (dc === ch) continue; // отправителю не эхаем
        try { dc.send(wire); } catch { /* канал закрывается */ }
      }
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
// G2: исходящие хоста — from:'host' (паритет с sendChat клиентской стороны).
export function sendWidgetChat(text) {
  const wire = chatMessage(text, { from: 'host' });
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

// Исходящий буфер: событие copy на вкладке клиента уходит всем присоединённым
// операторам, только если синхронизация включена.
document.addEventListener('copy', () => {
  if (state.role !== 'client' || !state.clip.client) return;
  const selected = String(document.getSelection?.() ?? '');
  const wire = clipMessage(selected);
  if (!wire) return;
  for (const dc of hostOperatorChannels('clip')) {
    try { dc.send(wire); } catch { /* канал закрывается */ }
  }
});
$('clip-client-toggle').addEventListener('change', (e) => { state.clip.client = e.target.checked; });

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

// Отправка файла оператору: meta + чанки через file-канал. Файл приходит и из
// input, и из drag&drop — общий путь один; получатель видит прогресс/ссылку.
export async function sendFileFrom(file) {
  if (!file) return;
  // Мультиоператор: файловые каналы keyed `file:<claimId>`. Волна 1 шлёт
  // первому открытому каналу (адресная передача нескольким — волна 2).
  let dc = null;
  for (const key of Object.keys(state.dcs ?? {})) {
    if (key.startsWith('file:') && state.dcs[key]?.readyState === 'open') { dc = state.dcs[key]; break; }
  }
  if (!dc || dc.readyState !== 'open') {
    // Фолбэк: резервный релей сервера (TTL 3 суток) — файл уходит ссылкой получателю
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const up = await enot.relayUpload(file.name, buf);
      await enot.sendFileLink({ name: up.name, size: up.size, url: up.url });
      text($('client-live-note'), t('files.relayLink', { name: up.name }));
    } catch { /* релей недоступен — честно молчим, канал всё равно мёртв */ }
    return;
  }
  const id = makeFileId();
  try {
    dc.send(fileMeta(id, file.name, file.size));
    createFileSender({ file, dc, id }).start();
  } catch { /* канал закрыт */ return; }
  text($('client-live-note'), t('files.sending', { name: file.name }));
}
$('btn-client-file').addEventListener('click', () => $('client-file-input').click());
$('client-file-input').addEventListener('change', () => {
  const input = $('client-file-input');
  const file = input.files?.[0];
  input.value = '';
  sendFileFrom(file);
});

// Drag&drop файла на карточку живого сеанса клиента.
function wireFileDrop(zone) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drop-hover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drop-hover');
    sendFileFrom(e.dataTransfer?.files?.[0]);
  });
}
wireFileDrop($('client-connected'));

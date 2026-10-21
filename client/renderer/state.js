// Общее состояние рендерера; тексты причин завершения сеанса — из словаря i18n.

import { t } from '../lib/i18n.mjs';

export const state = {
  role: 'client', // активная вкладка окна: 'client' | 'operator' (карточка окна оператора)
  // клиент помощи
  session: null, // {sessionId, password}
  pendingClaim: null, // {sessionId, claimId}
  localStream: null, // захват экрана хоста — один на всех операторов
  dcs: null, // каналы сессии (ADR 0014); у хоста ключ `${label}:${claimId}`
  // синхронизация буфера ВКЛЮЧЕНА по умолчанию (решение владельца 27.09), тогглом отключается
  clip: { client: true },
  // Мультиоператор (модель RustDesk: N подписчиков на один поток): персональный
  // pc и каналы на каждого присоединённого оператора, ключ — claimId.
  operators: new Map(), // claimId → {pc, iceQueue: [], dcs: {label: channel}}
  // Арбитраж (W-C4): последний активный вводчик из main (enot:input-active) —
  // нужен wireHostChannel'у для начального input-grant при открытии канала:
  // событие смены могло прийти до готовности канала и потеряться (P3-1).
  inputActiveClaimId: null,
  // ADR 0035: последний список участников из main — для начальной рассылки
  inputParticipants: null,
  // Состояние операторской стороны браузерной программы оператора (web/operator.mjs
  // импортирует этот модуль): {sessionId, claimId}, pc/каналы/приём файла/очередь ICE.
  connect: null,
  pc: null, dc: null, fileRx: null, iceQueue: [],
};

// Коды причин из протокола; человекочитаемый текст берётся из словаря по ключу end.<код>.
export const END_REASONS = ['ended', 'denied', 'host-lost', 'operator-lost', 'lease-expired', 'server-restart', 'signal-lost', 'rtc', 'idle'];

export function endReasonText(reason) {
  if (reason && END_REASONS.includes(reason)) return t(`end.${reason}`);
  return t('end.generic', { reason: reason ?? '—' });
}

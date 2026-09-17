// Общее состояние рендерера; тексты причин завершения сеанса — из словаря i18n.

import { t } from '../lib/i18n.mjs';

export const state = {
  role: 'client',
  me: null, // {name, role} оператора
  // клиент помощи
  session: null, // {sessionId, password}
  pendingClaim: null, // {sessionId, claimId}
  // оператор
  connect: null, // {sessionId, claimId}
  pc: null, dc: null, localStream: null,
  dcs: null, // {input, chat, clip, file} — каналы сессии (ADR 0014)
  clip: { client: false, operator: true }, // синхронизация буфера: у клиента выключена по умолчанию
  fileRx: null, // приём файла {rx, dc, prog}
  iceQueue: [],
  busy: false,
  pages: { contacts: 0, history: 0, audit: 0 },
  query: { contacts: '' },
  activePane: 'connect', // активная боковая вкладка оператора (для счётчика чата)
};

// Коды причин из протокола; человекочитаемый текст берётся из словаря по ключу end.<код>.
export const END_REASONS = ['ended', 'denied', 'host-lost', 'operator-lost', 'lease-expired', 'server-restart', 'signal-lost', 'rtc'];

export function endReasonText(reason) {
  if (reason && END_REASONS.includes(reason)) return t(`end.${reason}`);
  return t('end.generic', { reason: reason ?? '—' });
}

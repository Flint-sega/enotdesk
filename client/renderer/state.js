// Общее состояние рендерера и тексты причин завершения сеанса.

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

export const END_REASONS = {
  ended: 'Сеанс завершён.',
  denied: 'Вы отклонили запрос оператора.',
  'host-lost': 'Приложение помощи закрылось — сеанс завершён.',
  'operator-lost': 'Оператор отключился — сеанс завершён.',
  'lease-expired': 'Сеанс завершён по таймауту неактивности.',
  'server-restart': 'Сервер перезапущен — сеанс завершён.',
  'signal-lost': 'Связь с сервером потеряна — сеанс завершён.',
  rtc: 'Соединение экрана прервалось.',
};

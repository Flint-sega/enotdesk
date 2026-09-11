// WS-клиент /signal для main-процесса. Первое сообщение — auth (не query-параметры).
// Исходящие сигналы проходят validateOutgoingSignal; ошибки сервера попадают в onMessage.

import WebSocket from 'ws';
import { validateOutgoingSignal } from './protocol.mjs';

export function createSignalClient({ url, wsFactory = (u) => new WebSocket(u), authTimeoutMs = 5000 }) {
  let ws = null;
  let closedByUs = false;
  const listeners = new Set();
  const seen = []; // буфер: wait() может прийти после получения сообщения

  function emit(msg) {
    seen.push(msg);
    for (const cb of listeners) cb(msg);
  }

  return {
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    wait(pred, ms = 2000) {
      return new Promise((resolve, reject) => {
        const buffered = seen.find((m) => m && pred(m));
        if (buffered) return resolve(buffered);
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('timeout: не дождались сообщения')); }, ms);
        const unsubscribe = this.onMessage((m) => {
          if (m && pred(m)) {
            clearTimeout(timer);
            unsubscribe();
            resolve(m);
          }
        });
      });
    },

    open(auth) {
      return new Promise((resolve, reject) => {
        closedByUs = false;
        ws = wsFactory(url);
        let ready = false;
        const timer = setTimeout(() => {
          reject(new Error('auth-timeout: сервер не подтвердил подключение'));
          try { ws.close(); } catch { /* уже закрыт */ }
        }, authTimeoutMs);
        const fail = (err) => { if (!ready) { clearTimeout(timer); reject(err); } };
        ws.on('open', () => {
          // Контракт: {type:'auth',role:'host',sessionId,token:hostToken} —
          // на проводе ключ token; openSignal() наружу принимает hostToken.
          const payload = {
            type: 'auth',
            role: auth.role,
            sessionId: auth.sessionId,
            token: auth.hostToken ?? auth.token,
          };
          if (auth.claimId) payload.claimId = auth.claimId;
          ws.send(JSON.stringify(payload));
        });
        ws.on('message', (raw) => {
          let msg = null;
          try { msg = JSON.parse(raw.toString('utf8')); } catch { msg = null; }
          if (!msg) return;
          if (msg.type === 'ready' && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve(msg);
          } else if (msg.type === 'error' && !ready) {
            fail(new Error(`сигнальный сервер: ${msg.code ?? 'error'} ${msg.message ?? ''}`.trim()));
          }
          emit(msg);
        });
        ws.on('close', (code, reason) => {
          clearTimeout(timer);
          if (!ready) {
            // сокет закрылся до ready: это ошибка подключения (reject), а не конец сеанса
            if (!closedByUs) fail(new Error(`closed ${code} ${reason?.toString?.() ?? ''}`.trim()));
            return;
          }
          emit({ type: 'socket-closed', code, reason: reason?.toString?.() ?? '' });
        });
        ws.on('error', (e) => {
          clearTimeout(timer);
          fail(new Error(`Сервер недоступен: ${e.message}`));
        });
      });
    },

    sendSignal(message) {
      const v = validateOutgoingSignal(message);
      if (!v.ok) throw new Error(`Некорректный сигнал (${v.reason}) — не отправлен`);
      if (!ws || ws.readyState !== 1) throw new Error('Сигнальное соединение закрыто');
      ws.send(JSON.stringify(message));
    },

    heartbeat() {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat' }));
    },

    close() {
      closedByUs = true;
      try { ws?.close(1000, 'client-stop'); } catch { /* уже закрыт */ }
      ws = null;
      listeners.clear();
    },
  };
}

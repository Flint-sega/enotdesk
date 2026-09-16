// Проводка ввода оператора: datachannel → main-ворота → диспетчер нативного адаптера.
// Один код используется и main-процессом, и тестом шва (инертный адаптер-приёмник).

import { validateInputEvent } from './protocol.mjs';

function parseEvent(ev) {
  if (typeof ev === 'string') {
    try { ev = JSON.parse(ev); } catch { return { error: 'bad-json' }; }
  }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { error: 'shape' };
  return { value: ev };
}

// Main-ворота: решение о вводе принимает main по реальному WS-состоянию, не рендерер.
// Принимает как объект события, так и сырую строку datachannel (парс — здесь, один раз).
export function createInputPipeline({ gate, nativeInput }) {
  return {
    handle(ev, bounds) {
      const p = parseEvent(ev);
      if (p.error) return { ok: false, reason: p.error };
      const v = validateInputEvent(p.value);
      if (!v.ok) return { ok: false, reason: `invalid:${v.reason}` };
      // без реальных границ дисплея move уехал бы в угол (0,0) — честный отказ
      if (p.value.type === 'move' && !(bounds?.width > 0 && bounds?.height > 0)) {
        return { ok: false, reason: 'no-bounds' };
      }
      if (!gate.isOpen()) return { ok: false, reason: 'gate-closed' };
      if (gate.needInputReset()) nativeInput.end();
      return nativeInput.dispatch(p.value, bounds);
    },
  };
}

// Именованный шов канала оператора (используется тестом доставки).
export function createHostChannel({ handle }) {
  return { onMessage: (raw) => handle(raw) };
}

// Ввод оператора в machine-сеансе без Windows-хелпера (Linux-агент, v0.6.4):
// DataChannel 'input' → dispatch нативного адаптера. Отдельных ворот нет —
// канал создаётся оператором только внутри утверждённого сеанса (тот же
// принцип, что у Windows-хелпера: комментарий в agent.mjs ondatachannel).
// Масштабирование нормализованных координат делает dispatch (bounds из
// размера X-дисплея адаптера), валидация и throttle — тоже внутри dispatch.
export function createAgentInputSink({ nativeInput, getBounds, log } = {}) {
  return {
    handleChannel(ch) {
      ch.onmessage = (m) => {
        if (typeof m?.data !== 'string') return;
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; } // мусор не роняет канал
        // Гашение дисплея — фича Windows-хелпера (sleep/wake); на Linux v1
        // честно не поддерживается — молча игнорируем, не эмулируем.
        if (ev?.display === 'off' || ev?.display === 'on') return;
        const bounds = getBounds?.() ?? null;
        // Как в attended-пайплайне (input-pipeline.mjs): move без реальных
        // границ уехал бы в угол (0,0) с ответом ok:true — честный отказ вместо
        // фейкового успеха (ревизия 06.10). button/scroll/key без границ идут —
        // кнопка жмёт в текущей позиции курсора (та же семантика у pipeline).
        if (ev?.type === 'move' && !(bounds?.width > 0 && bounds?.height > 0)) {
          log?.warn?.('agent-input: no-bounds');
          return;
        }
        const r = nativeInput.dispatch(ev, bounds);
        // throttle — норма движения мыши, не шумим; остальные отказы видимы.
        if (!r?.ok && r?.reason !== 'throttled') log?.warn?.('agent-input: ' + r.reason);
      };
    },
  };
}

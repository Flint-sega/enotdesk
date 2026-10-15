// Арбитраж ввода мультиоператора (волна C, W-C4). Чистый модуль без
// DOM/node-импортов: живёт и в attended-main (client/main.mjs), и в цикле
// машины (client/lib/agent.mjs) — тестируется без Electron.
//
// Правила (решение волны C, ADR 0030):
//  — пока оператор один — ввод его (attach при отсутствии активного назначает
//    активного автоматически: сеанс одного оператора ведёт себя как раньше);
//  — при >1 ввод имеет только захвативший: claim(op) переключает активного,
//    хост рассылает всем операторам {type:'input-grant', granted} по их
//    input-каналам; события ввода не-активного отбрасываются ДО инъекции;
//  — release/drop активного сбрасывает активного БЕЗ автопередачи — детерминизм:
//    следующий получает ввод только по своей явной кнопке (никаких «последний
//    вводивший за N сек» — драка курсором и случайные перехваты);
//  — drop не-активного убирает оператора из списка, активного не трогает.
// Состояние «активный вводчик» — на host-стороне (конвенция: решение о вводе
// принимает только main/агент, не рендерер и не браузер).

export function createInputArbiter({ onChange } = {}) {
  let active = null;
  const attached = new Set();

  // onChange(activeOp | null, attachedOps[]): рассылка grants и бейджи UI.
  const notify = () => {
    if (typeof onChange !== 'function') return;
    try { onChange(active, [...attached]); } catch { /* слушатель не должен ронять арбитра */ }
  };

  return {
    attach(op) {
      if (typeof op !== 'string' || !op || attached.has(op)) return;
      attached.add(op);
      if (active == null) active = op; // одинокий оператор — ввод сразу его
      notify();
    },
    drop(op) {
      if (!attached.delete(op)) return;
      if (active === op) active = null; // без автопередачи (см. шапку)
      notify();
    },
    claim(op) {
      if (!attached.has(op) || active === op) return; // повторный claim — no-op
      active = op;
      notify();
    },
    release(op) {
      if (active !== op) return;
      active = null;
      notify();
    },
    active: () => active,
    attached: () => [...attached],
    isAllowed: (op) => active != null && active === op,
    // Конец сеанса/сброс сигналинга: операторов нет, активного нет.
    reset() {
      if (active == null && attached.size === 0) return;
      active = null;
      attached.clear();
      notify();
    },
  };
}

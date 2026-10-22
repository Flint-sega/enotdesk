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
// Этапы 2–3 (ADR 0035):
//  — pass(from, to): активный передаёт ввод конкретному участнику;
//  — «только смотреть» (setViewOnly): участник не получает ввод ни автоматически,
//    ни по claim, его события отбрасываются; это удобство для наблюдателя,
//    не граница безопасности (оператор сам снимает режим);
//  — participants(): список для панели «кто в сеансе, у кого управление».
// Состояние «активный вводчик» — на host-стороне (конвенция: решение о вводе
// принимает только main/агент, не рендерер и не браузер).

export function createInputArbiter({ onChange } = {}) {
  let active = null;
  const attached = new Set();
  const viewOnly = new Set();
  const participants = () => [...attached].map((op) => ({ op, control: op === active, viewOnly: viewOnly.has(op) }));

  // onChange(activeOp | null, attachedOps[], participants[]): рассылка grants,
  // списка участников и бейджи UI.
  const notify = () => {
    if (typeof onChange !== 'function') return;
    try { onChange(active, [...attached], participants()); } catch { /* слушатель не должен ронять арбитра */ }
  };

  return {
    attach(op) {
      if (typeof op !== 'string' || !op || attached.has(op)) return;
      attached.add(op);
      if (active == null && !viewOnly.has(op)) active = op; // одинокий оператор — ввод сразу его
      notify();
    },
    drop(op) {
      if (!attached.delete(op)) return;
      viewOnly.delete(op);
      if (active === op) active = null; // без автопередачи (см. шапку)
      notify();
    },
    claim(op) {
      if (!attached.has(op) || active === op || viewOnly.has(op)) return; // повторный claim — no-op
      active = op;
      notify();
    },
    // Передача ввода конкретному участнику: только от активного, только тому,
    // кто в сеансе и не в режиме «только смотреть».
    pass(from, to) {
      if (active == null || active !== from || from === to) return;
      if (!attached.has(to) || viewOnly.has(to)) return;
      active = to;
      notify();
    },
    // «Только смотреть»: включение снимает ввод с участника; выключение
    // возвращает ввод, только если управлять больше некому (как у одинокого).
    setViewOnly(op, on) {
      if (!attached.has(op) || viewOnly.has(op) === Boolean(on)) return;
      if (on) {
        viewOnly.add(op);
        if (active === op) active = null;
      } else {
        viewOnly.delete(op);
        const canControl = [...attached].filter((o) => !viewOnly.has(o));
        if (active == null && canControl.length === 1) active = op;
      }
      notify();
    },
    release(op) {
      if (active !== op) return;
      active = null;
      notify();
    },
    active: () => active,
    attached: () => [...attached],
    participants,
    isAllowed: (op) => active != null && active === op,
    // Конец сеанса/сброс сигналинга: операторов нет, активного нет.
    reset() {
      if (active == null && attached.size === 0) return;
      active = null;
      attached.clear();
      viewOnly.clear();
      notify();
    },
  };
}

// Сообщение хоста оператору со списком участников (ADR 0035): одно на
// получателя — поле you отмечает его самого. Имена подставляет хост (оператор
// не может переименовать других); пустое имя — UI покажет нейтральную метку.
export function participantsMessage(parts, you, nameOf = () => '') {
  return {
    type: 'participants',
    you,
    list: parts.map((p) => ({
      id: p.op,
      name: String(nameOf(p.op) ?? '').slice(0, 120),
      control: p.control === true,
      viewOnly: p.viewOnly === true,
    })),
  };
}

// Служебные сообщения оператора по input-каналу: claim/release (ADR 0030),
// pass/view-only (ADR 0035). null — не служебное (событие ввода или мусор).
export function parseControlMessage(raw) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'claim-input' || m.type === 'release-input') return { type: m.type };
  if (m.type === 'pass-input') return typeof m.to === 'string' && m.to && m.to.length <= 128 ? { type: m.type, to: m.to } : { type: 'invalid' };
  if (m.type === 'view-only') return typeof m.on === 'boolean' ? { type: m.type, on: m.on } : { type: 'invalid' };
  return null;
}

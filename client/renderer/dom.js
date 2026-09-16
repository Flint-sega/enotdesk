// Общие DOM-хелперы рендерера: поиск элементов, статусы, списки, роли.

export const $ = (id) => document.getElementById(id);
export const enot = window.enot;

export function show(el) { el.classList.remove('hidden'); }
export function hide(el) { el.classList.add('hidden'); }
export function setBusy(btn, busy, labelBusy) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy && labelBusy) { btn.dataset.label = btn.textContent; btn.textContent = labelBusy; }
  else if (!busy && btn.dataset.label) { btn.textContent = btn.dataset.label; }
}
export function setBusyAll(container, busy) {
  for (const btn of container.querySelectorAll('button')) btn.disabled = busy;
}
export function text(el, value) { el.textContent = value; }

export async function fetchList(op, params) {
  const res = await enot.request(op, params);
  if (res.status !== 200) throw new Error(res.body?.error?.message ?? `Ошибка ${res.status}`);
  return res.body;
}

export function roleName(r) { return { admin: 'администратор', operator: 'оператор', auditor: 'наблюдатель' }[r] ?? r; }

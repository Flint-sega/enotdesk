// Общие DOM-хелперы рендерера: поиск элементов, статусы, списки, роли, i18n-разметка.

import { t } from '../lib/i18n.mjs';

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
  if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('common.httpError', { status: res.status }));
  return res.body;
}

export function roleName(r) {
  const label = t(`role.${r}`);
  return label === `role.${r}` ? r : label; // неизвестная роль — код как есть
}

// Перевод статической разметки: data-i18n (текст), -html, -placeholder, -aria-label, -title.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'));
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.getAttribute('data-i18n-title'));
}

// CSV для Excel-RU: разделитель «;», BOM в начале, экранирование по RFC 4180.
// Чистый модуль — только строки, без DOM и сети.

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  const lines = [header, ...(rows ?? [])].map((row) => row.map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}`;
}

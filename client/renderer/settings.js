// Настройки: адрес сервера, допуск HTTP, честный отчёт о разрешениях платформы.

import { $, enot, text, show, hide, setBusy } from './dom.js';
import { isNewerVersion, latestVersionFrom } from '../lib/version-check.mjs';

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', () => hide($('settings-overlay')));

async function openSettings() {
  const s = await enot.getSettings();
  $('settings-url').value = s.serverUrl;
  $('settings-insecure').checked = !!s.allowInsecureHttp;
  text($('settings-status'), s.firstRun ? 'Первый запуск: укажите адрес сервера ЕнотDesk.' : '');
  text($('settings-error'), '');
  text($('perm-report'), '');
  show($('settings-overlay'));
  $('settings-url').focus();
}

$('btn-settings-save').addEventListener('click', async () => {
  const btn = $('btn-settings-save');
  setBusy(btn, true, 'Проверяем…');
  text($('settings-error'), ''); text($('settings-status'), '');
  try {
    const r = await enot.setServerUrl($('settings-url').value.trim(), { allowInsecureHttp: $('settings-insecure').checked });
    if (!r.ok) throw new Error(r.error ?? 'Не удалось сохранить');
    const health = await enot.request('health', {});
    if (health.status !== 200) throw new Error('Сервер ответил ошибкой — проверьте адрес');
    text($('settings-status'), `Сервер доступен, версия ${health.body?.version ?? '—'}`);
    const perms = await enot.permissions();
    const notes = [];
    if (perms.platform === 'darwin' && perms.screenCapture !== 'granted') notes.push('Запись экрана на macOS не разрешена — разрешите в Системных настройках.');
    if (perms.wayland) notes.push(perms.controlNote);
    // nativeInput проверяется лениво: «не проверено» — не повод заявлять недоступность
    if (perms.nativeInput?.checked && !perms.nativeInput.available) notes.push('Нативный ввод недоступен: управление мышью/клавиатурой работать не будет.');
    text($('perm-report'), notes.join(' '));
    enot.getSettings().then((s2) => checkForUpdate(s2.version)).catch(() => { /* не критично */ });
  } catch (e) {
    text($('settings-error'), `Сервер недоступен: ${e.message}`);
  } finally {
    setBusy(btn, false);
  }
});

// Баннер «доступна новая версия»: сравниваем свою версию со сборками на сервере.
// Сетевые сбои молча игнорируются — баннер не критичен.
export async function checkForUpdate(currentVersion) {
  try {
    const res = await enot.request('downloads', {});
    if (res.status !== 200 || !Array.isArray(res.body?.items)) return;
    const latest = latestVersionFrom(res.body.items.map((f) => f.name));
    if (latest && currentVersion && isNewerVersion(currentVersion, latest)) {
      text($('update-banner'), `Доступна версия ${latest} — обновите клиент со страницы загрузок вашего сервера EnotDesk.`);
      show($('update-banner'));
    }
  } catch { /* не критично */ }
}

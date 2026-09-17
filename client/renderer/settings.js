// Настройки: язык, адрес сервера, допуск HTTP, честный отчёт о разрешениях платформы.
// Здесь же — статус сервера: чип на главном экране и экран первого запуска (B3).

import { $, enot, text, show, hide, setBusy, applyI18n } from './dom.js';
import { t, setLocale, getLocale } from '../lib/i18n.mjs';
import { isNewerVersion, latestVersionFrom } from '../lib/version-check.mjs';

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-close').addEventListener('click', () => hide($('settings-overlay')));

function setChip(cls, key, vars) {
  const chip = $('server-chip');
  chip.className = `server-chip ${cls}`;
  text(chip, t(key, vars));
}

// Health-проверка через существующий мост; чип синхронизируется с результатом.
async function checkHealth() {
  try {
    const health = await enot.request('health', {});
    const ok = health?.status === 200;
    const version = ok ? (health.body?.version ?? '—') : '—';
    setChip(ok ? 'server-chip--ok' : 'server-chip--down', ok ? 'server.statusOk' : 'server.statusDown', { version });
    return { ok, version, error: ok ? null : t('settings.serverBad') };
  } catch (e) {
    setChip('server-chip--down', 'server.statusDown');
    return { ok: false, version: null, error: e.message };
  }
}

// Фоновое обновление чипа при старте приложения.
export async function updateServerChip() {
  await checkHealth();
}

export async function openSettings() {
  const s = await enot.getSettings();
  $('settings-locale').value = getLocale();
  $('settings-url').value = s.serverUrl;
  $('settings-insecure').checked = !!s.allowInsecureHttp;
  text($('settings-status'), s.firstRun ? t('settings.firstRun') : '');
  text($('settings-error'), '');
  text($('perm-report'), '');
  show($('settings-overlay'));
  $('settings-url').focus();
}

// Переключатель языка (R08.2): выбор сохраняется в settings.json, разметка
// переводится сразу; динамические тексты обновляются при следующей отрисовке.
$('settings-locale').addEventListener('change', async (e) => {
  const next = e.target.value;
  const saved = await enot.setLocale(next).catch(() => null);
  setLocale(saved?.ok ? saved.locale : next);
  document.documentElement.lang = getLocale();
  applyI18n();
});

$('btn-settings-save').addEventListener('click', async () => {
  const btn = $('btn-settings-save');
  setBusy(btn, true, t('settings.checkBusy'));
  text($('settings-error'), ''); text($('settings-status'), '');
  try {
    const r = await enot.setServerUrl($('settings-url').value.trim(), { allowInsecureHttp: $('settings-insecure').checked });
    if (!r.ok) throw new Error(r.error ?? t('settings.saveFail'));
    const health = await checkHealth();
    if (!health.ok) throw new Error(health.error ?? t('settings.serverBad'));
    text($('settings-status'), t('settings.serverOk', { version: health.version }));
    const perms = await enot.permissions();
    const notes = [];
    if (perms.platform === 'darwin' && perms.screenCapture !== 'granted') notes.push(t('settings.macosScreen'));
    if (perms.wayland) notes.push(perms.controlNote);
    // nativeInput проверяется лениво: «не проверено» — не повод заявлять недоступность
    if (perms.nativeInput?.checked && !perms.nativeInput.available) notes.push(t('settings.nativeInput'));
    text($('perm-report'), notes.join(' '));
    enot.getSettings().then((s2) => checkForUpdate(s2.version)).catch(() => { /* не критично */ });
  } catch (e) {
    text($('settings-error'), t('settings.unreachable', { message: e.message }));
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
      text($('update-banner'), t('settings.updateBanner', { version: latest }));
      show($('update-banner'));
    }
  } catch { /* не критично */ }
}

// Автообновление через GitHub Releases (история 34): main решает сам и сообщает
// сюда. auto=true — сборка скачается и применится при перезапуске; auto=false —
// платформа не умеет автоустановку (портативный .exe Windows), только уведомление.
// Тот же баннер, что у серверных сборок, — нового UI нет.
enot.onUpdate?.(({ version, auto }) => {
  if (!version) return;
  text($('update-banner'), t(auto ? 'update.autoBanner' : 'update.manualBanner', { version }));
  show($('update-banner'));
});

// ---------- первый запуск (B3): честный статус соединения ----------

async function runFirstRunCheck() {
  const btn = $('btn-firstrun-check');
  setBusy(btn, true, t('server.checking'));
  text($('firstrun-status'), t('server.checking'));
  $('firstrun-status').className = 'note';
  const { ok, version } = await checkHealth();
  text($('firstrun-status'), ok ? t('server.statusOk', { version }) : t('server.statusDown'));
  $('firstrun-status').className = ok ? 'note ok-text' : 'note err-text';
  setBusy(btn, false);
}

// Первый запуск: показываем резолвленный адрес и результат health-проверки.
// Проверка заодно обновляет чип статуса на главном экране.
export async function openFirstRun() {
  const s = await enot.getSettings();
  text($('firstrun-url'), s.serverUrl);
  show($('firstrun-overlay'));
  await runFirstRunCheck();
}

$('btn-firstrun-check').addEventListener('click', runFirstRunCheck);
$('btn-firstrun-settings').addEventListener('click', async () => {
  hide($('firstrun-overlay'));
  await openSettings();
});

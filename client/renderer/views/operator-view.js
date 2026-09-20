// Представление «Оператор»: вход, смена пароля, приглашения, подключение к клиенту.

import { $, enot, text, show, hide, setBusy, roleName } from '../dom.js';
import { state } from '../state.js';
import { t } from '../../lib/i18n.mjs';
import { cleanupSession } from '../session-media.js';
import { resetOperatorClip } from '../session-services.js';
import { loadContactsIntoSelect } from './contacts.js';
import { parseCredentials } from '../../lib/credentials.mjs';

function handleCredentialPaste(e) {
  const parsed = parseCredentials(e.clipboardData?.getData('text') ?? '');
  if (!parsed) return; // обычная вставка — не мешаем
  e.preventDefault();
  if (parsed.sessionId) $('conn-session-id').value = parsed.sessionId;
  if (parsed.password) $('conn-password').value = parsed.password;
  text($('conn-error'), '');
  text($('conn-paste-hint'), parsed.sessionId && parsed.password ? t('op.pasteHintDone') : t('op.pasteHint'));
  show($('conn-paste-hint'));
}
$('conn-session-id').addEventListener('paste', handleCredentialPaste);
$('conn-password').addEventListener('paste', handleCredentialPaste);

export function showConnectForm() {
  show($('op-connect-form')); hide($('op-waiting')); hide($('op-remote'));
  resetOperatorClip(); // SEC-002: ожидающий «Вставить из сеанса» не переживает сеанс
  text($('conn-paste-hint'), t('op.pasteHint'));
  hide($('conn-paste-hint'));
}

$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-login');
  setBusy(btn, true, t('op.loginBusy'));
  text($('login-error'), '');
  try {
    const res = await enot.request('login', {
      login: $('login-name').value.trim(),
      password: $('login-password').value,
      totp: $('login-totp').value.trim() || undefined,
    });
    if (res.status === 401 && res.body?.error?.code === 'totp_required') {
      // второй фактор нужен: показываем поле кода, пользователь входит ещё раз
      show($('field-login-totp'));
      $('login-totp').focus();
      text($('login-error'), t('op.totpRequired'));
      return;
    }
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('op.loginFail'));
    state.me = res.body.user;
    hide($('field-login-totp')); // чистое поле для следующего входа
    $('login-totp').value = '';
    text($('op-who'), `${state.me.name} (${roleName(state.me.role)})`);
    hide($('op-login'));
    show($('op-work'));
    loadContactsIntoSelect();
  } catch (err) {
    text($('login-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

$('btn-logout').addEventListener('click', async () => {
  await enot.request('logout', {}).catch(() => {});
  state.me = null;
  hide($('op-work'));
  show($('op-login'));
});

// Смена пароля: старый обязателен; прочие сеансы сервер завершает сам.
$('btn-password').addEventListener('click', () => {
  $('password-old').value = '';
  $('password-new').value = '';
  text($('password-error'), '');
  text($('password-status'), '');
  show($('password-overlay'));
  $('password-old').focus();
});
$('btn-password-close').addEventListener('click', () => hide($('password-overlay')));
$('form-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-password-save');
  setBusy(btn, true, t('password.busy'));
  text($('password-error'), '');
  text($('password-status'), '');
  try {
    const res = await enot.request('password.change', {
      oldPassword: $('password-old').value,
      newPassword: $('password-new').value,
    });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('password.fail'));
    text($('password-status'), t('password.changed'));
    setTimeout(() => hide($('password-overlay')), 1500);
  } catch (err) {
    text($('password-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

$('form-invite-accept').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-accept-invite');
  setBusy(btn, true, t('op.acceptBusy'));
  text($('invite-accept-error'), ''); text($('invite-accept-status'), '');
  try {
    // из ссылки берём фрагмент #token=…, иначе считаем, что введён сам код
    let code = $('invite-code').value.trim();
    if (code.includes('#token=')) code = code.split('#token=')[1].split('&')[0];
    if (code.includes('/invite')) code = '';
    const res = await enot.request('invite.accept', {
      token: code,
      login: $('invite-login').value.trim(),
      name: $('invite-name').value.trim(),
      password: $('invite-password').value,
    });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('op.inviteFail'));
    text($('invite-accept-status'), t('op.inviteDone'));
  } catch (err) {
    text($('invite-accept-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

$('btn-connect').addEventListener('click', async () => {
  const btn = $('btn-connect');
  setBusy(btn, true, t('op.connectBusy'));
  text($('conn-error'), '');
  try {
    const idEl = $('conn-session-id');
    const passEl = $('conn-password');
    // запасной путь: вставленные целиком данные, метки или нецифровой мусор
    if (/\D/.test(idEl.value) || !passEl.value) {
      const parsed = parseCredentials(`${idEl.value}\n${passEl.value}`);
      if (parsed?.sessionId) idEl.value = parsed.sessionId;
      if (parsed?.password) passEl.value = parsed.password;
    }
    const res = await enot.request('session.claim', {
      sessionId: idEl.value.replace(/\D/g, ''),
      password: passEl.value.trim(),
      contactId: $('conn-contact').value || undefined,
    });
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? t('op.connectFail'));
    state.connect = { sessionId: res.body.sessionId, claimId: res.body.claimId };
    await enot.openSignal({ role: 'operator', sessionId: res.body.sessionId, claimId: res.body.claimId });
    hide($('op-connect-form'));
    show($('op-waiting'));
  } catch (err) {
    text($('conn-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

$('btn-cancel-connect').addEventListener('click', async () => {
  await enot.request('session.end', { sessionId: state.connect?.sessionId }).catch(() => {});
  cleanupSession();
  showConnectForm();
});

// ---------- 2FA (TOTP, R11): настройка по паролю, подтверждение первым кодом,
// отключение по паролю. otpauth-ссылка, секрет и резервные коды показываются
// один раз — их больше сервер не отдаст. ----------

// Пароль между «настроить» и «подтвердить»: живёт до закрытия оверлея.
let totpSetupPassword = null;

// Код ошибки → словарный текст; серверный message — запасной вариант.
const TOTP_ERR_KEYS = {
  wrong_password: 'totp.wrongPassword',
  bad_code: 'totp.badCode',
  secret_key_missing: 'totp.keyMissing',
  totp_already: 'totp.already',
  totp_not_enabled: 'totp.notEnabled',
};

function totpErrorText(res, fallbackKey) {
  return t(TOTP_ERR_KEYS[res.body?.error?.code] ?? fallbackKey);
}

function resetTotpForm() {
  totpSetupPassword = null;
  $('totp-enable-password').value = '';
  $('totp-confirm-code').value = '';
  $('totp-disable-password').value = '';
  $('totp-uri').value = '';
  $('totp-secret').value = '';
  $('totp-backup-codes').textContent = '';
  text($('totp-enable-error'), '');
  text($('totp-confirm-error'), '');
  text($('totp-disable-error'), '');
  text($('totp-status'), '');
  show($('totp-off'));
  hide($('totp-setup'));
  hide($('totp-on'));
}

function openTotp() {
  resetTotpForm();
  const enabled = !!state.me?.totpEnabled;
  text($('totp-status'), enabled ? t('totp.statusOn') : t('totp.statusOff'));
  (enabled ? show : hide)($('totp-on'));
  (enabled ? hide : show)($('totp-off'));
  show($('totp-overlay'));
}

$('btn-totp').addEventListener('click', openTotp);
$('btn-totp-close').addEventListener('click', () => {
  resetTotpForm();
  hide($('totp-overlay'));
});

// Шаг 1: сервер генерирует секрет (шифрует его ключом ENOT_SECRET_KEY) и
// возвращает otpauth-ссылку и резервные коды — ровно один раз.
$('form-totp-enable').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-totp-enable');
  setBusy(btn, true, t('totp.enableBusy'));
  text($('totp-enable-error'), '');
  try {
    const password = $('totp-enable-password').value;
    const res = await enot.request('totp.enable', { password });
    if (res.status !== 200) throw new Error(totpErrorText(res, 'totp.fail'));
    totpSetupPassword = password;
    $('totp-enable-password').value = '';
    $('totp-uri').value = res.body?.otpauth ?? '';
    $('totp-secret').value = res.body?.secret ?? '';
    $('totp-backup-codes').textContent = (res.body?.backupCodes ?? []).join(' · ');
    hide($('totp-off'));
    show($('totp-setup'));
    $('totp-confirm-code').focus();
  } catch (err) {
    text($('totp-enable-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

// Шаг 2: включение подтверждается первым успешным кодом из аутентификатора.
$('form-totp-confirm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-totp-confirm');
  setBusy(btn, true, t('totp.confirmBusy'));
  text($('totp-confirm-error'), '');
  try {
    const res = await enot.request('totp.enable', {
      password: totpSetupPassword,
      code: $('totp-confirm-code').value.trim(),
    });
    if (res.status !== 200) throw new Error(totpErrorText(res, 'totp.fail'));
    if (state.me) state.me.totpEnabled = true;
    resetTotpForm();
    text($('totp-status'), t('totp.enabledDone'));
    hide($('totp-off'));
    show($('totp-on'));
  } catch (err) {
    text($('totp-confirm-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

// Отключение — только с текущим паролем; прочие сеансы сервер завершает сам.
$('form-totp-disable').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-totp-disable');
  setBusy(btn, true, t('totp.disableBusy'));
  text($('totp-disable-error'), '');
  try {
    const res = await enot.request('totp.disable', { password: $('totp-disable-password').value });
    if (res.status !== 200) throw new Error(totpErrorText(res, 'totp.fail'));
    if (state.me) state.me.totpEnabled = false;
    resetTotpForm();
    text($('totp-status'), t('totp.disabledDone'));
    show($('totp-off'));
  } catch (err) {
    text($('totp-disable-error'), err.message);
  } finally {
    setBusy(btn, false);
  }
});

// Представление «Оператор»: вход, смена пароля, приглашения, подключение к клиенту.

import { $, enot, text, show, hide, setBusy, roleName } from '../dom.js';
import { state } from '../state.js';
import { t } from '../../lib/i18n.mjs';
import { cleanupSession } from '../session-media.js';
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
    });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('op.loginFail'));
    state.me = res.body.user;
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

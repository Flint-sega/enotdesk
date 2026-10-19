// Веб-UI аккаунта оператора (ADR 0033, этап 3 — перенос из удалённого
// desktop-оператора): смена пароля и 2FA (TOTP). Контракт сервера тот же:
// PATCH /auth/password {oldPassword, newPassword}; POST /auth/totp/enable
// {password} → otpauth/секрет/резервные коды (один раз), затем {password, code}
// подтверждает включение; POST /auth/totp/disable {password}. Прочие сеансы
// пользователя сервер завершает сам, текущий токен остаётся.
// Модуль изолирован, как team.js/records.js: api/t/showOnly приходят параметрами.

// Известные коды ошибок 2FA → словарные ключи err.<код>; незнакомый код —
// запасной текст по ключу вызывающего.
const TOTP_ERR_CODES = new Set(['wrong_password', 'bad_code', 'secret_key_missing', 'totp_already', 'totp_not_enabled']);

export function bindAccount({ api, t, showOnly, $, onBack }) {
  let totpEnabled = false;
  // Пароль между «настроить» и «подтвердить»: живёт, пока открыт раздел.
  let totpSetupPassword = null;

  const say = (id, value) => { $(id).textContent = value; };
  const totpErrorText = (res, fallbackKey) => {
    const code = res.body?.error?.code;
    return code && TOTP_ERR_CODES.has(code) ? t(`err.${code}`) : (res.body?.error?.message ?? t(fallbackKey));
  };
  async function withBusy(btn, fn) {
    btn.disabled = true; // без двойной отправки
    try { await fn(); } finally { btn.disabled = false; }
  }

  function resetPassword() {
    $('password-old').value = '';
    $('password-new').value = '';
    say('password-error', '');
    say('password-status', '');
  }

  function resetTotp() {
    totpSetupPassword = null;
    for (const id of ['totp-enable-password', 'totp-confirm-code', 'totp-disable-password', 'totp-uri', 'totp-secret']) $(id).value = '';
    for (const id of ['totp-backup-codes', 'totp-enable-error', 'totp-confirm-error', 'totp-disable-error', 'totp-status']) say(id, '');
    $('totp-setup').classList.add('hidden');
    renderTotpState();
  }

  function renderTotpState() {
    $('totp-on').classList.toggle('hidden', !totpEnabled);
    $('totp-off').classList.toggle('hidden', totpEnabled);
  }

  // ---- смена пароля ----
  $('form-password').addEventListener('submit', (e) => {
    e.preventDefault();
    void withBusy($('btn-password-save'), async () => {
      say('password-error', '');
      say('password-status', '');
      const res = await api('PATCH', '/auth/password', { oldPassword: $('password-old').value, newPassword: $('password-new').value });
      if (res.status !== 200) { say('password-error', res.body?.error?.message ?? t('password.fail')); return; }
      resetPassword();
      say('password-status', t('password.changed'));
    });
  });

  // ---- 2FA: шаг 1 — сервер выдаёт секрет (шифрует его ENOT_SECRET_KEY) ----
  $('form-totp-enable').addEventListener('submit', (e) => {
    e.preventDefault();
    void withBusy($('btn-totp-enable'), async () => {
      say('totp-enable-error', '');
      const password = $('totp-enable-password').value;
      const res = await api('POST', '/auth/totp/enable', { password });
      if (res.status !== 200) { say('totp-enable-error', totpErrorText(res, 'totp.fail')); return; }
      totpSetupPassword = password;
      $('totp-enable-password').value = '';
      $('totp-uri').value = res.body?.otpauth ?? '';
      $('totp-secret').value = res.body?.secret ?? '';
      say('totp-backup-codes', (res.body?.backupCodes ?? []).join(' · '));
      $('totp-setup').classList.remove('hidden');
      $('totp-confirm-code').focus();
    });
  });

  // ---- 2FA: шаг 2 — включение подтверждается первым кодом ----
  $('form-totp-confirm').addEventListener('submit', (e) => {
    e.preventDefault();
    void withBusy($('btn-totp-confirm'), async () => {
      say('totp-confirm-error', '');
      const res = await api('POST', '/auth/totp/enable', { password: totpSetupPassword, code: $('totp-confirm-code').value.trim() });
      if (res.status !== 200) { say('totp-confirm-error', totpErrorText(res, 'totp.fail')); return; }
      totpEnabled = true;
      resetTotp();
      say('totp-status', t('totp.enabledDone'));
    });
  });

  // ---- 2FA: отключение — только с текущим паролем ----
  $('form-totp-disable').addEventListener('submit', (e) => {
    e.preventDefault();
    void withBusy($('btn-totp-disable'), async () => {
      say('totp-disable-error', '');
      const res = await api('POST', '/auth/totp/disable', { password: $('totp-disable-password').value });
      if (res.status !== 200) { say('totp-disable-error', totpErrorText(res, 'totp.fail')); return; }
      totpEnabled = false;
      resetTotp();
      say('totp-status', t('totp.disabledDone'));
    });
  });

  $('btn-account-back').addEventListener('click', () => {
    resetPassword();
    resetTotp(); // пароль настройки и секрет не переживают уход из раздела
    onBack();
  });

  return {
    setUser(user) { totpEnabled = Boolean(user?.totpEnabled); },
    show() {
      resetPassword();
      resetTotp();
      say('totp-status', totpEnabled ? t('totp.statusOn') : t('totp.statusOff'));
      showOnly('view-account');
    },
  };
}

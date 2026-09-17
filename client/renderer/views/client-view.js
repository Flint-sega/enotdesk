// Представление «Помощь» (клиент): регистрация сеанса, согласие, завершение.

import { $, enot, text, show, hide, setBusy } from '../dom.js';
import { state } from '../state.js';
import { t } from '../../lib/i18n.mjs';
import { cleanupSession } from '../session-media.js';

export function clientShow(section) {
  for (const id of ['client-idle', 'client-registering', 'client-waiting', 'client-consent', 'client-connected', 'client-ended', 'client-error']) {
    hide($(id));
  }
  show($('client-' + section));
}

$('btn-start').addEventListener('click', startHelp);
$('btn-retry').addEventListener('click', startHelp);

async function startHelp() {
  if (state.session) return; // двойное начало не создаёт второй сеанс
  setBusy($('btn-start'), true, t('client.startBusy'));
  clientShow('registering');
  try {
    const res = await enot.request('session.create', {});
    if (res.status !== 201) throw new Error(res.body?.error?.message ?? t('client.serverAnswered', { status: res.status }));
    state.session = { sessionId: res.body.sessionId, password: res.body.password };
    text($('client-id'), res.body.sessionId);
    text($('client-password'), res.body.password);
    await enot.openSignal({ role: 'host', sessionId: res.body.sessionId });
    clientShow('waiting');
  } catch (e) {
    state.session = null;
    text($('client-error-text'), e.message);
    clientShow('error');
  } finally {
    setBusy($('btn-start'), false);
  }
}

$('btn-cancel-wait').addEventListener('click', async () => {
  await enot.request('session.end', { sessionId: state.session?.sessionId, asHost: true }).catch(() => {});
  cleanupSession();
  clientShow('idle');
});

async function copyText(btn, value, okMsg) {
  setBusy(btn, true);
  const r = await enot.copy(value);
  text($('copy-status'), r.ok ? okMsg : (r.error ?? t('common.copyFail')));
  setBusy(btn, false);
}
$('btn-copy-id').addEventListener('click', (e) => copyText(e.currentTarget, state.session?.sessionId ?? '', t('client.idCopied')));
$('btn-copy-password').addEventListener('click', (e) => copyText(e.currentTarget, state.session?.password ?? '', t('client.passCopied')));
$('btn-copy-both').addEventListener('click', (e) => copyText(e.currentTarget, `ID: ${state.session?.sessionId}\n${t('client.passLabel')}: ${state.session?.password}`, t('client.bothCopied')));

$('btn-allow').addEventListener('click', () => decide(true));
$('btn-deny').addEventListener('click', () => decide(false));

async function decide(allow) {
  const { sessionId, claimId } = state.pendingClaim ?? {};
  setBusy($('btn-allow'), true);
  try {
    const res = await enot.request('session.decision', { sessionId, claimId, allow });
    if (res.status !== 200) throw new Error(res.body?.error?.message ?? t('client.decideFail'));
    if (!allow) { cleanupSession(); clientShow('idle'); }
    // при allow ждём approved из сигналинга
  } catch (e) {
    text($('ended-reason'), e.message);
    cleanupSession();
    clientShow('ended');
  } finally {
    setBusy($('btn-allow'), false);
  }
}

$('btn-stop').addEventListener('click', endByHost);
$('btn-end-session').addEventListener('click', endByHost);

async function endByHost() {
  await enot.request('session.end', { sessionId: state.session?.sessionId, asHost: true }).catch(() => {});
  cleanupSession();
  text($('ended-reason'), t('client.endedByYou'));
  clientShow('ended');
}
$('btn-again').addEventListener('click', () => { cleanupSession(); clientShow('idle'); });

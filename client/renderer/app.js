// Рендерер ЕнотDesk: точка сборки. Табы ролей, роутер сигналов сервера, запуск.
// Сеть и нативный ввод — только через window.enot (context-isolated мост).

import { $, enot, text, show, hide, applyI18n } from './dom.js';
import { state, endReasonText } from './state.js';
import { initLocale, getLocale, t } from '../lib/i18n.mjs';
import { clientShow } from './views/client-view.js';
import { showConnectForm } from './views/operator-view.js';
import { renderContacts } from './views/contacts.js';
import { renderTeam } from './views/team.js';
import { renderHistory, renderAudit } from './views/history.js';
import { stopMedia, drainIce, startHostRtc, operatorAnswer } from './session-media.js';
import { resetUnreadChat } from './session-services.js';
import { checkForUpdate } from './settings.js';

function switchView(role) {
  state.role = role;
  for (const [id, active] of [['tab-client', role === 'client'], ['tab-operator', role === 'operator']]) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  $(role === 'client' ? 'view-client' : 'view-operator').classList.remove('hidden');
  hide($(role === 'client' ? 'view-operator' : 'view-client'));
}
$('tab-client').addEventListener('click', () => switchView('client'));
$('tab-operator').addEventListener('click', () => switchView('operator'));

// ---------- сигналинг: единая точка входа событий ----------

enot.onSignal(async (msg) => {
  switch (msg.type) {
    case 'ready':
      break;
    case 'claim':
      // Клиент подтверждает видимое имя авторизованного оператора (R15/R15.3)
      state.pendingClaim = { sessionId: state.session?.sessionId, claimId: msg.claimId };
      text($('consent-operator'), msg.operator?.name ?? t('client.noOperator'));
      clientShow('consent');
      break;
    case 'approved':
      if (state.role === 'client' && state.session) {
        if (state.pc) break; // replay после переподключения — RTC уже поднят, не собираем второй
        clientShow('connected');
        text($('connected-operator'), document.getElementById('consent-operator').textContent);
        try { await startHostRtc(); } catch (e) {
          text($('client-error-text'), e.message);
          clientShow('error');
        }
      } else if (state.role === 'operator') {
        if (state.pc) break; // уже отвечаем на оффер
        show($('op-waiting'));
        text($('remote-status'), t('op.waitingScreen'));
      }
      break;
    case 'signal':
      try {
        if (msg.data?.description) {
          if (state.role === 'operator' && msg.data.description.type === 'offer') {
            await operatorAnswer(msg.data.description.sdp);
            show($('op-remote'));
            hide($('op-waiting'));
            text($('remote-status'), t('status.connected'));
          } else if (state.role === 'client' && state.pc && msg.data.description.type === 'answer') {
            await state.pc.setRemoteDescription({ type: 'answer', sdp: msg.data.description.sdp });
            drainIce(state.pc);
          }
        } else if (msg.data?.candidate) {
          const c = msg.data.candidate;
          if (state.pc && state.pc.remoteDescription) await state.pc.addIceCandidate(c);
          else state.iceQueue.push(c); // кандидаты в очередь до remote description
        }
      } catch { /* некорректный сигнал игнорируется: транспорт не открывается */ }
      break;
    case 'peer-reconnecting':
      // второй участник потерял связь, сеанс ещё жив (грейс сервера, ADR 0013)
      if (state.role === 'client') text($('client-live-note'), msg.role === 'operator' ? t('op.operatorReconnecting') : t('op.genericReconnecting'));
      else text($('remote-status'), t('op.clientReconnecting'));
      break;
    case 'resumed':
      if (state.role === 'client') text($('client-live-note'), '');
      else text($('remote-status'), t('status.connected'));
      break;
    case 'ended': {
      stopMedia();
      enot.closeSignal().catch(() => {});
      const clientSide = state.role === 'client';
      state.session = null; state.pendingClaim = null; state.connect = null;
      if (clientSide) {
        text($('ended-reason'), endReasonText(msg.reason));
        clientShow('ended');
      } else {
        showConnectForm();
        text($('conn-error'), endReasonText(msg.reason));
      }
      break;
    }
    case 'error':
      if (state.role === 'client' && state.session) { text($('client-error-text'), msg.message ?? t('common.serverError')); clientShow('error'); }
      else if (state.role === 'operator') {
        // транзиентные ошибки сигналинга (rate_limited, bad_signal) видимы оператору
        text($('remote-status'), msg.message ?? t('common.serverError'));
        setTimeout(() => text($('remote-status'), t('status.connected')), 3000);
      }
      break;
    default:
      break;
  }
});

// ---------- боковые вкладки оператора ----------

for (const btn of document.querySelectorAll('.side-tab')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.side-tab')) { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); }
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
    for (const pane of document.querySelectorAll('.pane')) hide(pane);
    show($('pane-' + btn.dataset.pane));
    state.activePane = btn.dataset.pane;
    if (btn.dataset.pane === 'connect') {
      resetUnreadChat(); // вкладка открыта — непрочитанное прочитано
      text(btn, t('op.paneConnect'));
    }
    if (btn.dataset.pane === 'contacts') renderContacts();
    if (btn.dataset.pane === 'team') renderTeam();
    if (btn.dataset.pane === 'history') renderHistory();
    if (btn.dataset.pane === 'audit') renderAudit();
  });
}

// ---------- запуск ----------

(async function boot() {
  const s = await enot.getSettings();
  initLocale(s.locale); // сохранённый выбор, иначе системная локаль, фолбэк en
  document.documentElement.lang = getLocale();
  applyI18n(); // статическая разметка переводится после выбора языка
  if (s.version) { // футер только с фактической версией — без выдуманных чисел
    text($('app-version'), s.version);
    show($('app-footer'));
    checkForUpdate(s.version);
  }
  if (s.firstRun) { // первый запуск: экран адреса сервера
    const { openSettings } = await import('./settings.js');
    openSettings();
  }
})();

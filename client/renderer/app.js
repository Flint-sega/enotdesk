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
import { cleanupSession, startHostRtc, operatorAnswer, resetHostRtcState, holdRtcLink, attachOperator, dropOperator, rehomeOperators, routeOperatorSignal } from './session-media.js';
import { resetUnreadChat, listenChatWidgetOut } from './session-services.js';
listenChatWidgetOut(); // маршрут ответов из чат-виджета в DC чата
import { checkForUpdate, openFirstRun, updateServerChip } from './settings.js';

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
      // graceMs от сервера — окно hold №15 у оператора (рвём видео не раньше,
      // чем сервер погасит сеанс)
      if (typeof msg.graceMs === 'number' && msg.graceMs >= 0) state.graceMs = msg.graceMs;
      break;
    case 'rtc-reset':
      // main переподключил сигналинг в грейсе (ADR 0013, только host-роль):
      // полный сброс host-RTC (эпоха/pc/захват/каналы/файловый приём/очередь/
      // adaptive/карточка ретрая) — без него реплей 'approved' упирается в
      // guard и видео не возобновляется (ретест 28.09 + ревью v0.4.3).
      resetHostRtcState();
      $('client-file-prompt').replaceChildren(); // карточка недопринятого файла мертва
      break;
    case 'claim':
      // Клиент подтверждает видимое имя авторизованного оператора (R15/R15.3)
      state.pendingClaim = { sessionId: state.session?.sessionId, claimId: msg.claimId };
      text($('consent-operator'), msg.operator?.name ?? t('client.noOperator'));
      clientShow('consent');
      break;
    case 'approved':
      // Критерий — сеанс, а не state.role (активная вкладка меняется кликом по
      // табу и не связан с ролью в живом сеансе, ревью v0.4.4)
      if (state.session) {
        // Мультиоператор: захват живёт через грейс-переподключение (pc операторов
        // — P2P, сигналинг их не убивает). Если захвата нет — стартуем; если есть
        // — пере-оффер тем операторам, чей pc не подключён (само-восстановление).
        if (state.localStream) { rehomeOperators(); break; }
        clientShow('connected');
        text($('connected-operator'), document.getElementById('consent-operator').textContent);
        try { await startHostRtc(); } catch (e) {
          // 'ended' мог прийти во время await: не затираем экран завершения
          if (state.session) {
            text($('client-error-text'), e.message);
            clientShow('error');
          }
        }
        // креды для других операторов: закреплённый ID ПК (hostId, не меняется
        // между сеансами — просьба владельца 02.10) + пароль этого запуска
        if (state.session) {
          text($('client-access-note'), t('client.accessNote', { id: state.session.hostId ?? state.session.sessionId, password: state.session.password }));
        }
      } else if (state.connect) {
        if (state.pc) break; // уже отвечаем на оффер
        show($('op-waiting'));
        text($('remote-status'), t('op.waitingScreen'));
      }
      break;
    case 'signal':
      try {
        if (msg.data?.description) {
        // Критерий — сеанс, а не state.role (активная вкладка меняется кликом
        // по табу в живом сеансе; привязка к роли роняла восстановление №15
        // и answer клиента, ревью v0.4.6). Оператор получает АДРЕСОВАННЫЙ offer
        // (мультиоператор: to=мой claimId, сервер маршрутизирует), клиент-хост —
        // answer с тегом from (роутинг в персональный pc оператора).
        if (state.connect && msg.data.description.type === 'offer') {
          // Гвард адресации (defense-in-depth: сервер уже фильтрует по claimId)
          if (msg.to && state.connect.claimId && msg.to !== state.connect.claimId) break;
          await operatorAnswer(msg.data.description.sdp);
          // 'ended'/rtcLinkLost могли прийти во время await — не показываем
          // экран живого сеанса поверх честной формы (ревью v0.4.3, паритет web)
          if (!state.connect) break;
          show($('op-remote'));
          hide($('op-waiting'));
          text($('remote-status'), t('status.connected'));
        } else if (state.session && msg.data.description.type === 'answer') {
          // Мультиоператор: answer тегирован claimId оператора (from) — роутится
          // в персональный pc; чужой/устаревший answer молча игнорируется
          routeOperatorSignal(msg.from, msg.data);
        }
        } else if (msg.data?.candidate) {
          const c = msg.data.candidate;
          if (state.connect) {
            // операторская роль: один pc, одна очередь
            if (state.pc && state.pc.remoteDescription) await state.pc.addIceCandidate(c);
            else state.iceQueue.push(c); // кандидаты в очередь до remote description
          } else if (state.session) {
            // хост: candidate тегирован claimId оператора — в его pc/очередь
            routeOperatorSignal(msg.from, msg.data);
          }
        }
      } catch { /* некорректный сигнал игнорируется: транспорт не открывается */ }
      break;
    case 'peer-reconnecting':
      // второй участник потерял связь, сеанс ещё жив (грейс сервера, ADR 0013).
      // Критерий — сеанс, а не активная вкладка (ревью v0.4.4)
      if (state.session) text($('client-live-note'), msg.role === 'operator' ? t('op.operatorReconnecting') : t('op.genericReconnecting'));
      else if (state.connect) {
        // №15: видео-сеанс оператора держим до server-grace + запас — вернувшийся
        // клиент пришлёт новый оффер в живой operatorAnswer. graceMs=0 — сервер
        // fail-closed: грейса не будет, hold не берём (паритет web, ревью v0.4.6)
        const graceMs = typeof state.graceMs === 'number' ? state.graceMs : 0;
        if (graceMs > 0) holdRtcLink(graceMs + 10_000);
        text($('remote-status'), t('op.clientReconnecting'));
      }
      break;
    case 'resumed':
      if (state.session) text($('client-live-note'), '');
      else if (state.connect) {
        // «Подключено» — только при живом pc: сигналинг вернулся раньше медиа,
        // заявлять успех при мёртвом pc — фейк (ревью v0.4.6)
        text($('remote-status'), state.pc?.connectionState === 'connected' ? t('status.connected') : t('op.clientReconnecting'));
      }
      break;
    case 'ended': {
      // cleanupSession (не просто stopMedia): гасит карточку ретрая и streamPaused —
      // они не должны переживать сеанс (ревью GLM-5.3 #3)
      cleanupSession();
      hide($('op-idle-note')); // баннер простоя не протекает в следующий сеанс
      // Критерий — сеанс, а не активная вкладка: симметрично rtcLinkLost
      // (ревью v0.4.6 — клиент на чужой вкладке видел операторскую форму)
      const clientSide = state.role === 'client' || !!state.session;
      if (clientSide) {
        text($('ended-reason'), endReasonText(msg.reason));
        clientShow('ended');
      } else {
        showConnectForm();
        text($('conn-error'), endReasonText(msg.reason));
      }
      break;
    }
    case 'operator-joined': {
      // Мультиоператор: хост поднимает ПЕРСОНАЛЬНЫЙ pc этому оператору
      const op = msg.operator ?? {};
      attachOperator(msg.claimId, op.name ?? '').catch(() => {});
      text($('client-operators'), t('client.operatorJoined', { name: op.name ?? '', login: op.login ?? '' }));
      break;
    }
    case 'operator-left': {
      // Оператор ушёл (WS закрыт): персональный pc снимается, сеанс живёт,
      // пока подключён хотя бы один оператор
      if (msg.claimId) dropOperator(msg.claimId);
      break;
    }
    case 'idle-warning': {
      // Критерий — сеанс, а не state.role (конвенция файла, ревью v0.5: вкладка
      // меняется кликом, сеанс — нет). Хост-клиент видит свой live-note, у
      // оператора предупреждение живёт в ОТДЕЛЬНОМ баннере: remote-status
      // перезаписывается таймером качества каждые 2 с.
      const isClientSide = state.role === 'client' || !!state.session;
      if (isClientSide) {
        text($('client-live-note'), t('client.idleWarning', { sec: msg.remainingSec ?? 60 }));
      } else {
        show($('op-idle-note'));
        text($('op-idle-note'), t('op.idleWarning', { sec: msg.remainingSec ?? 60 }));
      }
      break;
    }
    case 'idle-clear': {
      const isClientSide = state.role === 'client' || !!state.session;
      if (isClientSide) text($('client-live-note'), '');
      else { hide($('op-idle-note')); text($('op-idle-note'), ''); }
      break;
    }
    case 'file-link':
      // резервный релей: ссылка на файл (TTL 3 суток) — показать получателю
      if (msg.url && msg.name) {
        const box = state.role === 'client' ? $('client-file-prompt') : null;
        if (box) {
          const a = document.createElement('a');
          a.href = msg.url;
          a.download = msg.name;
          a.className = 'note';
          a.textContent = t('files.relayLink', { name: msg.name });
          box.textContent = '';
          box.appendChild(a);
        }
      }
      break;
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
  if (s.firstRun) { // первый запуск: экран проверки соединения (проверка обновит и чип)
    await openFirstRun();
  } else {
    updateServerChip(); // чип статуса сервера на главном экране
  }
})();

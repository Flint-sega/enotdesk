// Рендерер ЕнотDesk: точка сборки. Табы ролей, роутер сигналов сервера, запуск.
// Сеть и нативный ввод — только через window.enot (context-isolated мост).
// Сигналинг этого окна — только host-роль клиента помощи: программа оператора
// живёт в отдельном окне со страницей сервера (ADR 0033, этап 3).

import { $, enot, text, show, hide, applyI18n, errorText } from './dom.js';
import { state, endReasonText } from './state.js';
import { initLocale, getLocale, t } from '../lib/i18n.mjs';
import { clientShow } from './views/client-view.js';
import { cleanupSession, startHostRtc, resetHostRtcState, attachOperator, dropOperator, rehomeOperators, routeOperatorSignal, updateSeenStatus } from './session-media.js';
import { listenChatWidgetOut } from './session-services.js';
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
$('tab-operator').addEventListener('click', () => { switchView('operator'); void openOperatorWindow(); });

// ---------- программа оператора (ADR 0033, этап 2) ----------
// Оператор работает в отдельном окне со страницей сервера <сервер>/operator;
// здесь — только кнопка и честный статус: проверка сервера, сервер не отвечает,
// сервер старый («обновите сервер»), окно открыто/закрыто.
async function showOperatorWindowState(st) {
  text($('op-window-error'), '');
  text($('op-window-status'), '');
  if (st.state === 'checking') text($('op-window-status'), t('opwin.checking'));
  else if (st.state === 'open') text($('op-window-status'), t('opwin.opened'));
  else if (st.state === 'closed') text($('op-window-status'), t('opwin.closed'));
  else if (st.state === 'error') {
    const server = (await enot.getSettings().catch(() => null))?.serverUrl ?? '';
    text($('op-window-error'), st.reason === 'server-outdated'
      ? t('opwin.outdated', { server, version: st.version ?? '?' })
      : t('opwin.unreachable', { server }));
  }
}
enot.onOperatorWindow((st) => { if (st && typeof st === 'object') void showOperatorWindowState(st); });
async function openOperatorWindow() {
  const btn = $('btn-op-window');
  btn.disabled = true;
  try { await enot.openOperatorWindow(); } catch { /* статус уже пришёл событием */ } finally { btn.disabled = false; }
}
$('btn-op-window').addEventListener('click', () => { void openOperatorWindow(); });
// deep-link enotdesk://invite#…: main открывает /invite в окне оператора, мы — вкладку
enot.onInvitePrefill?.(() => switchView('operator'));

// ---------- сигналинг: единая точка входа событий (host-роль) ----------

enot.onSignal(async (msg) => {
  switch (msg.type) {
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
      if (!state.session) break;
      // Мультиоператор: захват живёт через грейс-переподключение (pc операторов
      // — P2P, сигналинг их не убивает). Если захвата нет — стартуем; если есть
      // — пере-оффер тем операторам, чей pc не подключён (само-восстановление).
      if (state.localStream) { rehomeOperators(); break; }
      clientShow('connected');
      text($('connected-operator'), document.getElementById('consent-operator').textContent);
      // «оператор видит ваш экран» — только когда захват пошёл и оператор на связи
      // (updateSeenStatus); на Wayland захват ещё ждёт системное окно GNOME (стенд 22.10)
      updateSeenStatus();
      try { await startHostRtc(); } catch (e) {
        // 'ended' мог прийти во время await: не затираем экран завершения
        if (state.session) {
          text($('client-error-text'), errorText(e));
          clientShow('error');
        }
      }
      // креды для других операторов: закреплённый ID ПК (hostId, не меняется
      // между сеансами — просьба владельца 02.10) + пароль этого запуска
      if (state.session) {
        text($('client-access-note'), t('client.accessNote', { id: state.session.hostId ?? state.session.sessionId, password: state.session.password }));
      }
      break;
    case 'signal':
      // Мультиоператор: answer и ICE операторов тегированы сервером claimId
      // (from) — роутятся в персональный pc; чужие/устаревшие молча игнорируются
      try {
        if (!state.session) break;
        if (msg.data?.description?.type === 'answer' || msg.data?.candidate) routeOperatorSignal(msg.from, msg.data);
      } catch { /* некорректный сигнал игнорируется: транспорт не открывается */ }
      break;
    case 'peer-reconnecting':
      // оператор потерял связь, сеанс ещё жив (грейс сервера, ADR 0013)
      if (state.session) text($('client-live-note'), msg.role === 'operator' ? t('op.operatorReconnecting') : t('op.genericReconnecting'));
      break;
    case 'resumed':
      if (state.session) text($('client-live-note'), '');
      break;
    case 'ended':
      // cleanupSession (не просто stopMedia): гасит карточку ретрая и streamPaused —
      // они не должны переживать сеанс (ревью GLM-5.3 #3)
      cleanupSession();
      text($('ended-reason'), endReasonText(msg.reason));
      clientShow('ended');
      break;
    case 'operator-joined': {
      // Мультиоператор: хост поднимает ПЕРСОНАЛЬНЫЙ pc этому оператору
      const op = msg.operator ?? {};
      attachOperator(msg.claimId, op.name ?? '', { rejoin: true }).catch(() => {});
      text($('client-operators'), t('client.operatorJoined', { name: op.name ?? '', login: op.login ?? '' }));
      break;
    }
    case 'operator-left':
      // Оператор ушёл (WS закрыт): персональный pc снимается, сеанс живёт,
      // пока подключён хотя бы один оператор
      if (msg.claimId) dropOperator(msg.claimId);
      break;
    case 'idle-warning':
      text($('client-live-note'), t('client.idleWarning', { sec: msg.remainingSec ?? 60 }));
      break;
    case 'idle-clear':
      text($('client-live-note'), '');
      break;
    case 'file-link':
      // резервный релей: ссылка на файл (TTL 3 суток) — показать получателю
      if (msg.url && msg.name) {
        const box = $('client-file-prompt');
        const a = document.createElement('a');
        a.href = msg.url;
        a.download = msg.name;
        a.className = 'note';
        a.textContent = t('files.relayLink', { name: msg.name });
        box.textContent = '';
        box.appendChild(a);
      }
      break;
    case 'error':
      // Ранний join второго оператора (pending-consent): его offer честно
      // отвергнут сервером (not_approved) — это не ошибка СЕАНСА клиента,
      // экран ошибки ронял живой UI (W-C0). Тихий ignore: scheduleReattach
      // пере-офферит после approved.
      if (msg.code === 'not_approved' && state.session) break;
      if (state.session) { text($('client-error-text'), msg.message ?? t('common.serverError')); clientShow('error'); }
      break;
    default:
      break;
  }
});

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

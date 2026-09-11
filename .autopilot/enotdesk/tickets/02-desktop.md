# 02 — Настольная поддержка и интерфейс
Требования: R01,R02,R03,R04,R05,R07,R08,R09,R10,R11,R12,R14,R15,R16,R17,R19i. Blocked by: 01. Волна: 2. Зона: desktop/.

Из брифа: «делаю настроки у клиента»; «программа закрывается меняется логин и пароль»; «она не устанавливается просто запускается у клиента».

Создать Electron клиент и полный русский тёмный UI, используя существующий backend по interfaces.md. На main/preload boundary strict allowlists and sender checks. Main хранит auth/host tokens, IPC input gate определяется реальными WS consent state. WebRTC capture/offerer host/answerer operator, datachannel input Koffi native adapters Windows/macOS/X11. Нельзя заменять управлением DOM или видеозаглушкой. UI оператора: connect, contacts CRUD с conflict, team invite/roles/disable, history, audit; клиент: помощь/реальные ID-password/copy/consent/stop. Settings server URL. Accept invite form. Missing backend honest error. Медиатрэки и native input сразу прекращаются при любом shutdown/disconnect; кнопка окна реально quit. macOS permissions и Wayland unsupported explicit.

Приёмка:
- настоящий capture stream и полный WebRTC путь по backend, queued ICE;
- no unauthorized input, bounded enums, native coordinates/keys held released; native error clear;
- все UI состояния и team forms/API реально работают, no fabricated content;
- first run/empty/error/retry/busy/focus/keyboard/360px;
- закрытие процесса/сокета останавливает media/input/auth, no background helper;
- тесты lifecycle/input trust-boundary через публичный шов + actual Electron start smoke; no fake E2E claims;
- assets от параллельного T03 по контракту, не редактировать assets/root package/server;
- вернуть CONTRACT/results/blockers; no commit.

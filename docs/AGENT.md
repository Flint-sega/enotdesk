# EnotDesk — агент-служба (unattended)

Агент — это **тот же клиент EnotDesk в headless-режиме** (`EDESK_AGENT=1`): без окна и рендерера,
с отдельным профилем. Он регистрируется на сервере по одноразовому onboarding-коду, обменивая его на
токен машины, затем живёт как служба: auto-reconnect с backoff, heartbeat каждые 5с, переживает ребут
и обрывы связи, принимает claim оператора (причина обязательна, PIN-политика сервера — на сервере).

Конфиги служб и install/remove-скрипты: `client/agent-service/` (windows.md, linux.md, macos.md).
Свой инсталлятор ОС в v1 не пишется — установка по этой доке (spec §службы). Живая установка —
ручная приёмка по `docs/MANUAL-QA.md`.

## Где что лежит (профиль агента)

Профиль агента отделён от профиля обычного клиента: `<userData>/agent/`. Так как служба обычно
работает от служебной учётки, фактические пути:

| ОС | Профиль агента | Токен машины |
|---|---|---|
| Windows (служба от LocalSystem) | `C:\Windows\System32\config\systemprofile\AppData\Roaming\EnotDesk\agent` | `...\agent\agent-token.json` |
| Linux (user `enotdesk-agent`) | `/var/lib/enotdesk-agent/.config/EnotDesk/agent` | `...\agent\agent-token.json` |
| macOS (LaunchDaemon от root) | `/var/root/Library/Application Support/EnotDesk/agent` | `...\agent\agent-token.json` |

В профиле: `settings.json` (адрес сервера; если запускаете агент вручную в своей сессии —
`%APPDATA%\EnotDesk\agent` / `~/.config/EnotDesk/agent` / `~/Library/Application Support/EnotDesk/agent`).

**Токен машины** — секрет, дающий право занимать слот машины. Файл 0600. «Забыть» машину на этой
железке: удалить `agent-token.json` (или весь `agent/`) — при следующем старте понадобится новый
onboarding-код. Отзыв на стороне сервера: список машин → отозвать/удалить (старый токен перестаёт
приниматься, даже если файл остался).

## Переменные окружения агента

| Переменная | Значение |
|---|---|
| `EDESK_AGENT=1` | включает headless-режим (обязательно) |
| `EDESK_AGENT_NAME` | имя машины в списке; по умолчанию hostname |
| `EDESK_AGENT_CODE` | одноразовый onboarding-код — **только для первой регистрации**, в конфиге службы не хранить |

## Установка по ОС

- **Windows (приоритет)**: `sc.exe create` (start= auto, description, автоперезапуск при сбоях,
  переменные через `AppEnvironment`). См. `client/agent-service/windows.md`, скрипты
  `windows-install.bat` / `windows-remove.bat`.
- **Linux**: systemd unit с хардненингом как у сервера (`NoNewPrivileges`, `ProtectSystem=strict`,
  `ReadWritePaths` на профиль, `Restart=always`). См. `client/agent-service/linux.md`,
  скрипты `install-linux.sh` / `remove-linux.sh`.
- **macOS**: LaunchDaemon (`RunAtLoad`, `KeepAlive`). См. `client/agent-service/macos.md`,
  скрипты `install-macos.sh` / `remove-macos.sh`.

Порядок на любой ОС один: (1) распаковать сборку; (2) первая регистрация вручную с
`EDESK_AGENT_CODE` (код одноразовый и остаётся только на сервере); (3) поставить службу — она
стартует уже с токеном; (4) проверить на сервере, что машина online.

## Обновление

Токен живёт в профиле агента и переживает замену файлов сборки:

1. Остановить службу: `sc stop EnotDeskAgent` / `systemctl stop enotdesk-agent` /
   `launchctl bootout system/com.enotdesk.agent`.
2. Заменить файлы сборки (exe / каталог сборки / `.app`).
3. Запустить службу обратно.

Версию машины видно на сервере в списке машин (агент отчитывается `version` при регистрации).
Если машина не поднялась после обновления — логи (ниже), там честная причина.

## Логи

| ОС | Где логи |
|---|---|
| Windows | **в v1 файлов логов нет** — у процесса службы нет консоли, stdout теряется. Диагностика: остановить службу и запустить exe в консоли с `EDESK_AGENT=1` (подробности в windows.md). SCM-ошибки запуска — в Event Viewer (System). |
| Linux | `journalctl -u enotdesk-agent -f` |
| macOS | `/var/log/enotdesk-agent.log` (StandardOutPath/StandardErrorPath), плюс Console.app |

## Ограничение session 0 (Windows) — честно

Служба Windows исполняется в session 0 и **не имеет доступа к интерактивному рабочему столу
пользователя**. В v1 это осознанное ограничение (история 31):

- работает: регистрация, online/heartbeat, claim с причиной, PIN-политика, чат, буфер, файлы,
  автоперезапуск и переживание ребутов;
- не работает: захват экрана консольной сессии и инъекция ввода в неё (пустые источники/чёрный кадр,
  `SendInput` не доходит до сессии пользователя). Unattended-поддержка активной консоли Windows
  требует helper-процесса в пользовательской сессии — отложено за рамки v1.

Аналогичные честные ограничения других ОС: Wayland на Linux — управление вводом не поддерживается
(`wayland-unsupported-control`); macOS LaunchDaemon — выдача TCC-разрешений (Screen Recording,
Accessibility) службе от root без MDM ограничена, до их выдачи захват/ввод честно сообщают
об отсутствии разрешения. Детали — в соответствующих `client/agent-service/*.md`.

## Ручная приёмка

Чек-лист живой проверки (attended + unattended, приоритет Windows): `docs/MANUAL-QA.md`.
Живую установку служб выполняет владелец по этому чек-листу; автотестами служебные конфиги не
проверяются (только синтаксис доступными средствами).

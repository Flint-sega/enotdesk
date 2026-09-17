# Агент-служба macOS (LaunchDaemon)

LaunchDaemon стартует от root **до логина пользователя** (`RunAtLoad`) и перезапускается при падении
(`KeepAlive`, `ThrottleInterval=10`). Файлы: `com.enotdesk.agent.plist`, `install-macos.sh`,
`remove-macos.sh` (запуск через sudo).

## Установка

1. Положите сборку в `/Applications/EnotDesk.app` (или задайте `APP_PATH`).
2. Запустите установщик:

```bash
sudo SERVER_URL="https://enotdesk.example.com" \
     APP_PATH="/Applications/EnotDesk.app" \
     AGENT_NAME="mac-mini" \
     ./install-macos.sh
```

Скрипт: пишет `settings.json` (адрес сервера) в профиль агента, копирует plist в
`/Library/LaunchDaemons/com.enotdesk.agent.plist` (root:wheel, 0644, подставив ваш путь и имя),
создаёт лог-файл и делает `launchctl bootstrap system`.

Так как LaunchDaemon исполняется от **root**, профиль Electron агента —
`/var/root/Library/Application Support/EnotDesk/agent/` (там же `agent-token.json`, 0600),
а не в профиле обычного пользователя.

## Первый запуск с onboarding-кодом

Код одноразовый и не должен попадать в plist. Рекомендуемый порядок — зарегистрировать вручную,
затем ставить службу:

```bash
sudo env EDESK_AGENT=1 EDESK_AGENT_NAME=mac-mini EDESK_AGENT_CODE=123456789 \
  /Applications/EnotDesk.app/Contents/MacOS/EnotDesk
```

После «запущен» прервите (Ctrl+C) — токен останется в `/var/root/Library/.../agent/agent-token.json`,
служба стартует уже с ним.

## Диагностика и логи

```bash
tail -f /var/log/enotdesk-agent.log     # stdout/stderr агента (StandardOutPath/StandardErrorPath)
launchctl print system/com.enotdesk.agent
log show --predicate 'process == "EnotDesk"' --last 10m
```

## TCC-разрешения (Screen Recording / Accessibility) — честно

macOS требует разрешения **Screen Recording** (захват экрана) и **Accessibility** (инъекция ввода).
Для LaunchDaemon, работающего от root до логина, выдача этих разрешений через Системные настройки
не всегда возможна — штатно они выдаются процессам пользователя; на немодерированной машине может
понадобиться MDM-профиль (например, через платформенные SSR/TTU-механизмы). До тех пор агент
работает (регистрация, чат, файлы, heartbeat), а захват/ввод честно сообщают об отсутствии
разрешения. Проверка этого — обязательный пункт ручной приёмки: `docs/MANUAL-QA.md`, macOS-M3.

## Обновление

```bash
sudo launchctl bootout system/com.enotdesk.agent
# замените /Applications/EnotDesk.app на новую сборку
sudo launchctl bootstrap system /Library/LaunchDaemons/com.enotdesk.agent.plist
```

## Удаление

```bash
sudo ./remove-macos.sh              # служба остаётся с токеном
sudo ./remove-macos.sh --purge-data # + профиль агента и логи
```

Запись машины на сервере удаляется отдельно (список машин → удалить/отозвать).

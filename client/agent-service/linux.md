# Агент-служба Linux (systemd)

Unit с тем же хардненингом, что у серверного (`scripts/install-server.sh`): `Type=simple`,
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths` только на
профиль агента, `Restart=always` + `RestartSec=5` (история 24: переживание ребута и падений).

Файлы: `enotdesk-agent.service`, `install-linux.sh`, `remove-linux.sh` (запуск от root).

## Установка

1. Распакуйте сборку клиента, например в `/opt/enotdesk-agent/EnotDesk` (бинарник `enotdesk` внутри).
2. Запустите установщик с адресом сервера:

```bash
sudo SERVER_URL="https://enotdesk.example.com" \
     APP_DIR="/opt/enotdesk-agent/EnotDesk" \
     AGENT_NAME="nas-office" \
     ./install-linux.sh
```

Скрипт: создаёт системного пользователя `enotdesk-agent` (home `/var/lib/enotdesk-agent`), пишет
`settings.json` (адрес сервера) в профиль `~/.config/EnotDesk/agent` (0600), пишет
`/etc/enotdesk-agent/agent.env` (0600: `EDESK_AGENT_NAME`, опционально `DISPLAY`/`XAUTHORITY`),
копирует unit (подставляя ваш `APP_DIR`), делает `daemon-reload` + `enable --now`.

## Первый запуск с onboarding-кодом

Как и на Windows, рекомендуемый порядок — код используется один раз и не хранится: перед установкой
службы выполните вручную под будущим пользователем:

```bash
sudo -u enotdesk-agent \
  env HOME=/var/lib/enotdesk-agent EDESK_AGENT=1 EDESK_AGENT_NAME=nas-office \
      EDESK_AGENT_CODE=123456789 /opt/enotdesk-agent/EnotDesk/enotdesk
```

После «запущен» прервите (Ctrl+C) и ставьте службу — она стартует уже с токеном.

## Ввод в консольную сессию: X11 vs Wayland — честно

- **X11**: для инъекции ввода (XTest) агенту нужны `DISPLAY` и `XAUTHORITY` сессии пользователя.
  Раскомментируйте их в `/etc/enotdesk-agent/agent.env`. Так как `ProtectHome=true` скрывает `/home`,
  положите xauth-файл вне `/home` (например `/etc/enotdesk-agent/xauth`, 0600, владелец
  `enotdesk-agent`) или смените `ProtectHome=true` на `ProtectHome=read-only`. Нужны системные
  библиотеки X11/Xtst (`libx11`, `libxtst`).
- **Wayland**: управление вводом в v1 не поддерживается — нативный адаптер честно сообщает
  `wayland-unsupported-control`; агент при этом работает (регистрация, чат, файлы), но ввод/захват
  недоступны. Это честный статус, не ошибка установки.

## Диагностика и логи

```bash
systemctl status enotdesk-agent
journalctl -u enotdesk-agent -f
```

Логи агента идут в stdout → journald (rotate настраивается штатно через journald.conf).

## Обновление

```bash
sudo systemctl stop enotdesk-agent
# замените файлы сборки в APP_DIR
sudo systemctl start enotdesk-agent
```

## Удаление

```bash
sudo ./remove-linux.sh              # служба остаётся с токеном
sudo ./remove-linux.sh --purge-data # + профиль, пользователь, /etc/enotdesk-agent
```

Запись машины на сервере удаляется отдельно (список машин → удалить/отозвать).

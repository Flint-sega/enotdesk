# Агент-служба Linux (systemd)

Unit с тем же хардненингом, что у серверного (`scripts/install-server.sh`): `Type=simple`,
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths` только на
профиль агента, `Restart=always` + `RestartSec=5` (история 24: переживание ребута и падений).

Файлы: `enotdesk-agent.service`, `install-linux.sh`, `remove-linux.sh` (запуск от root).

## Установка

1. Распакуйте AppImage в каталог службы:

```bash
chmod +x EnotDesk-<версия>-linux-x86_64.AppImage
./EnotDesk-<версия>-linux-x86_64.AppImage --appimage-extract
sudo mv squashfs-root /opt/enotdesk-agent/EnotDesk
sudo chown -R root:root /opt/enotdesk-agent/EnotDesk && sudo chmod -R a+rX /opt/enotdesk-agent/EnotDesk
sudo chmod 4755 /opt/enotdesk-agent/EnotDesk/chrome-sandbox
```

2. Получите одноразовый код машины (программа оператора → «Машины» → «Добавить машину») и сохраните
   его в файл, например `/root/code.txt` (первая строка).
3. Запустите установщик:

```bash
sudo SERVER_URL="https://enotdesk.example.com" \
     APP_DIR="/opt/enotdesk-agent/EnotDesk" \
     AGENT_NAME="nas-office" \
     AGENT_CODE_FILE=/root/code.txt \
     ./install-linux.sh
```

Скрипт: создаёт системного пользователя `enotdesk-agent` (home `/var/lib/enotdesk-agent`), пишет
`settings.json` (адрес сервера) в профиль `~/.config/enotdesk/agent` (0600; весь `.config`
отдаётся агенту — Electron именует userData строчным именем пакета, регистр обязан совпадать),
пишет `/etc/enotdesk-agent/agent.env` (0600: `EDESK_AGENT_NAME`, опционально `DISPLAY`/`XAUTHORITY`),
**регистрирует машину по коду** (код передаётся только окружением процесса, не в командной строке;
после регистрации файл кода удаляется, токен — `agent-token.json`, 0600; журнал регистрации —
`/var/lib/enotdesk-agent/register.log`), копирует unit (подставляя ваш `APP_DIR`), делает
`daemon-reload` + `enable` + `restart`. Повторный запуск без кода (машина уже зарегистрирована) обновляет
настройки и перезапускает службу с прежним токеном; с новым кодом (машину отозвали и создали заново)
регистрирует её и перезапускает работающую службу уже с новым токеном. Свои строки в `agent.env`
(`DISPLAY`, `XAUTHORITY`) при повторном запуске сохраняются — меняется только имя машины.

Адрес `http://…` (без HTTPS) скрипт принимает с предупреждением и записывает согласие на HTTP
(`allowInsecureHttp`) — только для тестового сервера. Без этого агент отбросил бы такой адрес.

**Без графического сеанса** (сервер, NAS, служба без `DISPLAY`) агент запускается в безэкранном режиме
(`--ozone-platform=headless`, проверено 22.10 на Debian 13): регистрация, «онлайн», терминал,
сообщения и файлы работают, видео и управление — нет (честный статус). Для экрана и управления
нужен сеанс X11 (ниже).

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

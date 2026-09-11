# EnotDesk: установка и эксплуатация сервера

Инструкция для владельца: как поставить control-plane EnotDesk на сервер (Ubuntu/Debian), запустить его как systemd-сервис, обновить, удалить, сделать бэкап, посмотреть логи и включить HTTPS с доменом.

## Требования

- Ubuntu 22.04+/24.04 или Debian 12+ с `systemd`, `curl`, `tar` и `xz` (apt установщику не нужен).
- Доступ root (или sudo) на сервере.
- Исходящий интернет: nodejs.org (tarball Node 24) и npm registry (зависимости).
- Порт сервера: `8080` по умолчанию для тестового HTTP-режима, либо `80`/`443` при TLS через Caddy.
- Свободное место: ~300 МБ на Node.js + релиз + `node_modules`.
- Архитектура x86_64 (установщик ставит tarball `linux-x64`; на arm64 Node ставится вручную).

Фиксированные пути (совпадают с тем, что создаёт установщик):

| Что | Путь |
|---|---|
| Релизы приложения | `/opt/enotdesk/releases/<UTC-штамп>` |
| Действующий релиз (symlink) | `/opt/enotdesk/current` |
| База данных | `/var/lib/enotdesk/enotdesk.db` |
| Переменные окружения | `/etc/enotdesk/enotdesk.env` (0600) |
| systemd-юнит | `/etc/systemd/system/enotdesk.service` |
| Пользователь сервиса | `enotdesk` (system, без login) |

## 1. Быстрый старт (скриптом, с локальной машины)

Понадобится SSH-доступ root на сервер: по ключу (рекомендуется) или по паролю — тогда дополнительно нужен локальный `sshpass`.

Экспортируйте переменные (имена — как в `.env.example`; подставьте свой хост; пароль лучше не задавать, он попадёт в окружение):

```bash
export ENOT_DEPLOY_HOST=<server-ip>
export ENOT_DEPLOY_USER=root
export ENOT_DEPLOY_PASSWORD=      # пусто = вход по SSH-ключу
export ENOT_DEPLOY_PORT=22
export ENOT_PORT=8080
export ENOT_DEPLOY_PROTO=http
```

Запустите деплойер из корня репозитория:

```bash
./scripts/deploy-server.sh
```

Скрипт собирает tar.gz (`server/`, `package.json`, `package-lock.json`, `scripts/install-server.sh`), копирует его в `/tmp/enotdesk-install/` на сервере и запускает установку под `nohup` (лог — `/tmp/enotdesk-install/install.log` на сервере): обрыв SSH установку не прерывает. Локально скрипт опрашивает лог каждые 5 секунд (до 10 минут) и ждёт health. В конце печатает health-URL и следующую команду — создание администратора (шаг 4).

Тот же скрипт, запущенный повторно, ставит свежий релиз и переключает symlink `current`: это и есть обновление. База данных лежит вне релиза и не теряется.

## 2. Ручная установка

### 2.1. Node.js 24

Node ставится официальным tarball-ом с nodejs.org — без apt и NodeSource. Это важно на серверах, где `apt update` зависает (зеркала отвечают `Ign`): нужны только `curl`, `tar` и `xz`.

```bash
NODE_VERSION=24.12.0
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
install -d /opt/node-24
tar -xJf "node-v$NODE_VERSION-linux-x64.tar.xz" -C /opt/node-24 --strip-components=1
ln -sfn /opt/node-24/bin/node /usr/local/bin/node
ln -sfn /opt/node-24/bin/npm  /usr/local/bin/npm
ln -sfn /opt/node-24/bin/npx  /usr/local/bin/npx
node -v    # ожидается v24.12.0
```

Если `node -v` уже равен нужной версии, шаг можно пропустить. Установщик `install-server.sh` делает то же самое идемпотентно (версия переопределяется `NODE_VERSION`). На arm64 скачайте tarball `linux-arm64` и повторите распаковку/симлинки — автоматически поддерживается только x86_64.

### 2.2. Пользователь и каталоги

```bash
useradd --system --create-home --home-dir /var/lib/enotdesk --shell /usr/sbin/nologin enotdesk
install -d -o enotdesk -g enotdesk /opt/enotdesk/releases
install -d -o enotdesk -g enotdesk /var/lib/enotdesk
install -d -m 0755 /etc/enotdesk
```

### 2.3. Релиз

На локальной машине из корня репозитория:

```bash
tar czf /tmp/enotdesk-app.tar.gz server package.json package-lock.json
scp /tmp/enotdesk-app.tar.gz root@<server-ip>:/tmp/
```

На сервере:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
install -d -o enotdesk -g enotdesk "/opt/enotdesk/releases/$STAMP"
tar -xzf /tmp/enotdesk-app.tar.gz -C "/opt/enotdesk/releases/$STAMP" --owner enotdesk --group enotdesk
ln -sfn "/opt/enotdesk/releases/$STAMP" /opt/enotdesk/current
```

### 2.4. Зависимости

```bash
cd /opt/enotdesk/current
sudo -u enotdesk npm ci --omit=dev --cache /tmp/enotdesk-npm-cache
```

### 2.5. Переменные окружения

```bash
cat >/etc/enotdesk/enotdesk.env <<'EOF'
ENOT_HOST=0.0.0.0
ENOT_PORT=8080
ENOT_DB=/var/lib/enotdesk/enotdesk.db
ENOT_PUBLIC_URL=http://<server-ip>:8080
EOF
chmod 0600 /etc/enotdesk/enotdesk.env
```

`ENOT_PUBLIC_URL` подставляется в ссылки на страницах `/invite` и `/downloads`. Если нужен STUN/TURN, допишите `ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD` (имена — в `.env.example`) и перезапустите сервис.

Сборки для `/downloads` лежат в каталоге `ENOT_DIST_DIR` (рекомендуется `ENOT_DIST_DIR=/var/lib/enotdesk/dist`; по умолчанию `<рабочий каталог>/dist`) — загрузите их, например: `scp dist/EnotDesk-* root@<server>:/var/lib/enotdesk/dist/`. Страница и API показывают только реально загруженные файлы из allowlist (`EnotDesk*.exe`, `EnotDesk*.zip`, `EnotDesk*.AppImage`); отсутствующие платформы отмечаются как «сборка ещё не готова».

### 2.6. systemd

```bash
cat >/etc/systemd/system/enotdesk.service <<'EOF'
[Unit]
Description=EnotDesk server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=enotdesk
Group=enotdesk
WorkingDirectory=/opt/enotdesk/current
EnvironmentFile=/etc/enotdesk/enotdesk.env
ExecStart=/usr/local/bin/node server/main.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

```bash
systemctl daemon-reload
systemctl enable --now enotdesk
```

### 2.7. Проверка

```bash
curl -fsS http://127.0.0.1:8080/api/v1/health
# {"ok":true,...}
```

Снаружи (если открыт порт):

```bash
curl -fsS http://<server-ip>:8080/api/v1/health
```

Если включён ufw и нужен внешний доступ:

```bash
ufw allow 8080/tcp
```

Установщик умеет открыть порт сам флагом `--open-firewall` (если ufw неактивен — честно сообщает и ничего не меняет).

## 3. Управление сервисом

```bash
systemctl status enotdesk
systemctl restart enotdesk
systemctl stop enotdesk
systemctl start enotdesk
systemctl is-enabled enotdesk
journalctl -u enotdesk -n 100 --no-pager
journalctl -u enotdesk -f          # следить в реальном времени
```

Сервис включён в автозапуск (`enable`) и переживает перезагрузку. При падении процесса systemd поднимает его (`Restart=on-failure`).

## 4. Первый администратор

Создаётся только вручную, интерактивно, уже на сервере — после установки и до первого входа. Пароль вводится скрыто и не должен передаваться через аргументы, скрипты или агентов:

```bash
cd /opt/enotdesk/current
sudo -u enotdesk ENOT_DB=/var/lib/enotdesk/enotdesk.db npm run bootstrap
```

CLI спросит логин (от 3 символов), отображаемое имя и пароль (от 8 символов, ввод не отображается) с повтором. Если администратор уже существует, команда сообщит об этом и не изменит базу. После создания входите оператором из приложения EnotDesk, указав адрес сервера.

## 5. Обновление

С локальной машины — просто повторный запуск деплойера (собирает новый релиз, переключает `current`, БД не затрагивается):

```bash
ENOT_DEPLOY_HOST=<server-ip> ./scripts/deploy-server.sh
```

На сервере то же делает флаг `--update` установщика:

```bash
bash /tmp/enotdesk-install/install-server.sh --update /tmp/enotdesk-install/app.tar.gz
```

Откат: в `/opt/enotdesk/releases/` остаются прежние релизы. Переключите symlink на нужный и перезапустите сервис:

```bash
ln -sfn /opt/enotdesk/releases/<старый-штамп> /opt/enotdesk/current
systemctl restart enotdesk
```

## 6. Удаление

```bash
bash /tmp/enotdesk-install/install-server.sh --uninstall            # сервис удалён, БД на месте
bash /tmp/enotdesk-install/install-server.sh --uninstall --purge-data   # + удалить /var/lib/enotdesk и /etc/enotdesk
```

Вручную (если установщика под рукой нет):

```bash
systemctl disable --now enotdesk
rm -f /etc/systemd/system/enotdesk.service
systemctl daemon-reload
rm -rf /opt/enotdesk          # данные НЕ трогаются: /var/lib/enotdesk остаётся
```

`--purge-data` необратим — сначала сделайте бэкап.

## 7. Бэкап и восстановление

База — SQLite в режиме WAL: `/var/lib/enotdesk/enotdesk.db` (+ файлы `-wal` и `-shm`). Копировать «живой» файл `cp` нельзя — получите несогласованный снимок. Используйте онлайн-бэкап (сервис можно не останавливать):

```bash
apt-get install -y sqlite3
install -d -m 0700 /var/backups/enotdesk
sqlite3 /var/lib/enotdesk/enotdesk.db ".backup '/var/backups/enotdesk/enotdesk-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Если `sqlite3` ставить не хочется — остановите сервис и скопируйте каталог целиком (включая `-wal`/`-shm`):

```bash
systemctl stop enotdesk
tar -czf "/var/backups/enotdesk/enotdesk-data-$(date -u +%Y%m%dT%H%M%SZ).tgz" -C /var/lib/enotdesk .
systemctl start enotdesk
```

Восстановление:

```bash
systemctl stop enotdesk
rm -f /var/lib/enotdesk/enotdesk.db /var/lib/enotdesk/enotdesk.db-wal /var/lib/enotdesk/enotdesk.db-shm
cp /var/backups/enotdesk/enotdesk-<штамп>.db /var/lib/enotdesk/enotdesk.db
chown enotdesk:enotdesk /var/lib/enotdesk/enotdesk.db
systemctl start enotdesk
curl -fsS http://127.0.0.1:8080/api/v1/health
```

В env-файле секретов нет, кроме пароля TURN (если задан), — его тоже стоит сохранить, но не вместе с бэкапами на публичном диске.

## 8. Логи

Сервис пишет в journald:

```bash
journalctl -u enotdesk -n 100 --no-pager   # последние 100 строк
journalctl -u enotdesk -f                  # поток
journalctl -u enotdesk --since "1 hour ago"
journalctl -u enotdesk -p err              # только ошибки
```

Секреты (пароли, токены, TURN-креды) в логи не попадают.

## 9. TLS с доменом (Caddy)

Тестовый режим `http://<server-ip>:8080` передаёт пароли, токены и сигналинг по сети открытым текстом — он годится только для локальной проверки. В интернет сервер выставляйте за HTTPS-прокси.

Нужно: домен (в примерах — `example.com`) с A-записью на `<server-ip>` и открытые порты 80/443.

Установка Caddy (официальный репозиторий):

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
```

Конфигурация `/etc/caddy/Caddyfile`:

```bash
cat >/etc/caddy/Caddyfile <<'EOF'
example.com {
    reverse_proxy 127.0.0.1:8080
}
EOF
systemctl reload caddy
```

Caddy сам получит сертификат Let's Encrypt и сам проксирует WebSocket-сигналинг.

Переведите сервер в режим за прокси — в `/etc/enotdesk/enotdesk.env` замените адрес и публичный URL:

```ini
ENOT_HOST=127.0.0.1
ENOT_PORT=8080
ENOT_DB=/var/lib/enotdesk/enotdesk.db
ENOT_PUBLIC_URL=https://example.com
```

```bash
systemctl restart enotdesk
ufw allow 80/tcp
ufw allow 443/tcp
ufw delete allow 8080/tcp   # если открывали тестовый порт
```

Проверка:

```bash
curl -fsS https://example.com/api/v1/health
```

## 10. Диагностика

```bash
systemctl is-active enotdesk                 # active?
curl -fsS http://127.0.0.1:8080/api/v1/health # {"ok":true,...}
ss -ltnp | grep 8080                          # кто слушает порт
journalctl -u enotdesk -n 100 --no-pager      # почему не поднялся
```

Частые причины: порт занят (`ss -ltnp | grep :8080` покажет процесс), нет доступа к БД (владелец `/var/lib/enotdesk` должен быть `enotdesk`), ошибка в env-файле (systemd не раскрывает подстановки — только литеральные значения).

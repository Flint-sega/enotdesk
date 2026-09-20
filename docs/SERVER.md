# EnotDesk: установка и эксплуатация сервера

Инструкция для владельца: как поставить control-plane EnotDesk на сервер (Ubuntu/Debian), запустить его как systemd-сервис, обновить, удалить, сделать бэкап, посмотреть логи и включить HTTPS с доменом.

## Требования

- Ubuntu 22.04+/24.04 или Debian 12+ с `systemd`, `curl`, `tar` и `xz` (apt установщику не нужен).
- Доступ root (или sudo) на сервере.
- Исходящий интернет: nodejs.org (tarball Node 24) и npm registry (зависимости).
- Порт сервера: `8080` по умолчанию для тестового HTTP-режима, либо `80`/`443` при TLS через Caddy.
- Для TURN (coturn) и TLS (Caddy), которые установщик ставит по умолчанию, нужен работающий `apt` и исходящий доступ к репозиториям Debian/Ubuntu и Caddy; флаги `--no-turn` / `--no-tls` отключают их.
- Порты TURN: `3478` tcp/udp (сигналинг) и `49160–49200`/udp (relay) — откройте их в файрволе или группе безопасности облака (установщик умеет сам, см. `--open-firewall`).
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

Скрипт собирает tar.gz (`server/`, `client/lib/i18n.mjs`, `client/locales/`, `assets/`, `package.json`, `package-lock.json`, `scripts/install-server.sh`), копирует его в `/tmp/enotdesk-install/` на сервере и запускает установку под `nohup` (лог — `/tmp/enotdesk-install/install.log` на сервере): обрыв SSH установку не прерывает. Локально скрипт опрашивает лог каждые 5 секунд (до 10 минут) и ждёт health. В конце печатает health-URL и следующую команду — создание администратора (шаг 4).

Установщик по умолчанию сам ставит TURN (coturn) и TLS (Caddy, авто-HTTPS) — раздел 9. Отключить: `--no-turn` / `--no-tls`; посмотреть план без изменений: `--dry-run`.

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

`ENOT_PUBLIC_URL` подставляется в ссылки на страницах `/invite` и `/downloads`. TURN обычно настраивает установщик (раздел 9); если TURN внешний, допишите `ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD` (имена — в `.env.example`) и перезапустите сервис.

Сборки для `/downloads` лежат в каталоге `ENOT_DIST_DIR` (установщик по умолчанию задаёт `/var/lib/enotdesk/dist` и сохраняет это значение при обновлениях; при ручном запуске `<рабочий каталог>/dist`) — загрузите их, например: `scp dist/EnotDesk-* root@<server>:/var/lib/enotdesk/dist/`. Страница и API показывают только реально загруженные файлы из allowlist (`EnotDesk*.exe`, `EnotDesk*.zip`, `EnotDesk*.AppImage`); отсутствующие платформы отмечаются как «сборка ещё не готова».

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

### 7.1. Встроенный бэкап без sqlite3 (рекомендуется)

Установщик умеет сам: `VACUUM INTO` штатным Node (sqlite3-CLI не нужен), дампы в `/var/lib/enotdesk/backups`, ретенция последних 10 (меняется через `BACKUP_KEEP`):

```bash
sudo bash /tmp/enotdesk-install/install-server.sh --backup
```

Расписание — системный cron, например каждый день в 03:15 (`crontab -e` под root):

```cron
15 3 * * * sudo bash /tmp/enotdesk-install/install-server.sh --backup >> /var/log/enotdesk-backup.log 2>&1
```

Скрипт лежит на сервере вместе с релизом (`/opt/enotdesk/current/server/backup.mjs`), его можно вызывать и напрямую:

```bash
sudo -u enotdesk /opt/node-24/bin/node /opt/enotdesk/current/server/backup.mjs \
  /var/lib/enotdesk/enotdesk.db /var/lib/enotdesk/backups 10
```

## 8. Логи

Сервис пишет в journald:

```bash
journalctl -u enotdesk -n 100 --no-pager   # последние 100 строк
journalctl -u enotdesk -f                  # поток
journalctl -u enotdesk --since "1 hour ago"
journalctl -u enotdesk -p err              # только ошибки
```

Секреты (пароли, токены, TURN-креды) в логи не попадают.

## 9. TURN и TLS: из коробки

Установщик `install-server.sh` по умолчанию сам разворачивает TURN и TLS — вручную ставить ничего не нужно:

- **TURN (coturn)**: apt-пакет; `/etc/turnserver.conf` с `use-auth-secret` и `static-auth-secret` (секрет генерируется один раз и хранится в env-файле `/etc/enotdesk/enotdesk.env`, 0600, как `ENOT_TURN_SECRET` — повторные запуски дают те же креды); realm и `external-ip` берутся из `ENOT_PUBLIC_URL`; креды для клиентов (`ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD`) пишутся в тот же env-файл. Порты: `3478` tcp/udp, relay `49160–49200`/udp. Существующий `/etc/turnserver.conf` без пометки EnotDesk сохраняется как `*.bak-<штамп>`. Повторные запуски и `--update` уже настроенный стек не пересоздают (только обновляют env-файл), внешний TURN с `ENOT_TURN_URLS` в env не трогают; принудительная перенастройка — `--reset-turn`.
- **TLS (Caddy)**: apt-пакет из официального репозитория; `/etc/caddy/Caddyfile` — `домен → reverse_proxy 127.0.0.1:PORT`, сертификат Let's Encrypt автоматически; сервер переводится на `ENOT_HOST=127.0.0.1`, публичный URL — `https://<домен>`. Существующий `Caddyfile` без пометки EnotDesk сохраняется как `*.bak-<штамп>`.
- Домен берётся из `ENOT_PUBLIC_URL` (например, `ENOT_PUBLIC_URL=https://example.com`). Если домена нет — TLS честно пропускается с предупреждением в логе установки (незащищённый локальный http-режим), TURN при этом ставится (realm = IP).
- Отказ: `--no-turn` и/или `--no-tls`; план без изменений: `--dry-run`.

Безопасность значений: `ENOT_PUBLIC_URL` проверяется на формат `[https?://]host[:port][/]` (только буквы, цифры, точка, дефис) до любой записи в `Caddyfile`/`turnserver.conf` — значения с посторонними символами установщик честно отклоняет. Значения env-файла пишутся в одинарных кавычках с экранированием (`KEY='value'`, `'` → `'\''`): содержимое переменной не может «выехать» за пределы своей строки (systemd раскрывает кавычки сам). Tarball перед распаковкой валидируется: допускаются только пути из сборки `deploy-server.sh` (`server/`, `assets/`, `client/lib/i18n.mjs`, `client/locales/`, `package.json`, `package-lock.json`, `scripts/install-server.sh`); абсолютные пути, `..` и symlink/hardlink-записи отклоняются с честной ошибкой. Дампы `--backup` складываются в `/var/lib/enotdesk/backups` с правами 0700.

Проверка после установки:

```bash
curl -fsS https://example.com/api/v1/health
systemctl status coturn caddy
ss -ulnp | grep -E ':3478|4916'   # слушает coturn
```

### 9.1. Caddy вручную (fallback)

Тестовый режим `http://<server-ip>:8080` передаёт пароли, токены и сигналинг по сети открытым текстом — он годится только для локальной проверки. В интернет сервер выставляйте за HTTPS-прокси. Ниже — тот же путь, что автоматизирует установщик.

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
ufw allow 443/udp   # HTTP/3
ufw delete allow 8080/tcp   # если открывали тестовый порт
```

Проверка:

```bash
curl -fsS https://example.com/api/v1/health
```

### 9.2. coturn вручную (fallback)

Если установщик запущен с `--no-turn` или coturn нужен на отдельной машине:

```bash
apt-get install -y coturn
TURN_SECRET="$(openssl rand -hex 32)"
cat >/etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=example.com
server-name=example.com
min-port=49160
max-port=49200
no-cli
no-multicast-peers
external-ip=<публичный-IP>
EOF
chmod 0600 /etc/turnserver.conf
systemctl enable --now coturn
```

Креды для env-файла сервера (username — метка «годен до», password — base64(HMAC-SHA1(username, secret)), тот же формат, что генерирует установщик):

```bash
TURN_USERNAME=2000000000
TURN_PASSWORD="$(printf '%s' "$TURN_USERNAME" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)"
# ENOT_TURN_SECRET=$TURN_SECRET
# ENOT_TURN_URLS=stun:example.com:3478,turn:example.com:3478?transport=udp,turn:example.com:3478?transport=tcp
# ENOT_TURN_USERNAME=$TURN_USERNAME
# ENOT_TURN_PASSWORD=$TURN_PASSWORD
```

Порты в файрволе: `ufw allow 3478/tcp`, `ufw allow 3478/udp`, `ufw allow 49160:49200/udp`.

Если TLS не настроен и сервер работает по http без домена, установщик предупреждает об этом в логе и в итоговом сообщении установки, а страницы `/downloads` и `/invite` дополнительно показывают предупреждающую плашку о небезопасном режиме (её рисует сервер при http без домена).

## 10. Диагностика

```bash
systemctl is-active enotdesk                 # active?
curl -fsS http://127.0.0.1:8080/api/v1/health # {"ok":true,...}
ss -ltnp | grep 8080                          # кто слушает порт
journalctl -u enotdesk -n 100 --no-pager      # почему не поднялся
```

Частые причины: порт занят (`ss -ltnp | grep :8080` покажет процесс), нет доступа к БД (владелец `/var/lib/enotdesk` должен быть `enotdesk`), ошибка в env-файле (systemd не раскрывает подстановки — только литеральные значения).

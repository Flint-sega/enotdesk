# EnotDesk: установка и эксплуатация сервера

Инструкция для владельца: как поставить control-plane EnotDesk на сервер (Ubuntu/Debian), запустить его как systemd-сервис, обновить, удалить, сделать бэкап, посмотреть логи и включить HTTPS с доменом.

## Требования

- Ubuntu 22.04+/24.04 или Debian 12+ с `systemd`, `curl`, `tar` и `xz` (apt установщику не нужен).
- Доступ root (или sudo) на сервере.
- Исходящий интернет: nodejs.org (tarball Node 24) и npm registry (зависимости).
- Порт сервера: `8080` по умолчанию для тестового HTTP-режима, либо `80`/`443` при TLS через Caddy.
- Для TURN (coturn) и TLS (Caddy), которые установщик ставит по умолчанию, нужен работающий `apt` и исходящий доступ к репозиториям Debian/Ubuntu и Caddy; флаги `--no-turn` / `--no-tls` отключают их.
- Порты TURN: `3478` tcp/udp (сигналинг) и `49160–49999`/udp (relay) — откройте их в файрволе или группе безопасности облака (установщик умеет сам, см. `--open-firewall`). Один сеанс с одним оператором занимает около 5 портов ретрансляции (замер 22.10.2026), так что диапазон рассчитан примерно на 165 одновременных сеансов. Установки до 0.6.29 имели диапазон 49160–49200 (около 7 сеансов) — расширьте его: `install-server.sh --update <архив сервера> --reset-turn` и откройте новые порты в файрволе.
- Свободное место: ~300 МБ на Node.js + релиз + `node_modules`.
- Ресурсы: 2 vCPU и 2 ГБ памяти хватает с запасом — на такой ВМ сервер держал 1000 агентов и 60 одновременных сеансов с p95 API ≤121 мс, ~230 МБ памяти и ~34% одного ядра (нагрузочный прогон 23.10.2026, `npm run load`; без TLS и Caddy). Свою площадку можно проверить тем же скриптом: `LOAD_AGENTS=… LOAD_SESSIONS=… npm run load`.
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

## 0. Быстрый старт (мастер установки)

Одна команда на чистом Ubuntu/Debian-хосте — мастер сам скачает релиз, сверит его с `checksums-sha256.txt` (файла чексумм или строки для релиза нет — честный отказ; не сошлось — тем более), поставит сервер (Node, coturn, Caddy — тем же `install-server.sh`), дождётся health и создаст первого администратора:

```bash
curl -fsSL https://raw.githubusercontent.com/Flint-sega/enotdesk/main/scripts/quick-setup.sh | sudo bash
```

Мастер спрашивает (ru/en по локали):

1. **Домен** — пусто = HTTP по IP (незащищённый режим, в финале будет предупреждение и подсказка про `--update`); домен = TLS через Caddy с авто-сертификатом. Значение без точки доменом не считается.
2. **Логин администратора** — по умолчанию `admin`, от 3 символов.
3. **Отображаемое имя** — по умолчанию = логину.
4. **Пароль** — ввод скрыт; пустой ввод = автогенерация 20 символов, пароль показывается в финале один раз.
5. **Порт** — по умолчанию 8080 (только для bare-metal; в docker фиксирован compose).
6. **Firewall (ufw)** — открыть порт или не трогать (по умолчанию не трогать).

Секреты TURN и `ENOT_SECRET_KEY` генерируются мастером автоматически, никогда не показываются и передаются установщику только окружением процесса (env-файл 0600); пароль администратора передаётся bootstrap'у через stdin-пайп — в argv и логах их нет.

Полезные режимы:

- `--docker` — вместо bare-metal поднимает compose-стек (сервер + coturn + Caddy) в `./enotdesk-docker`: мастер скачивает raw-файлы стека, пишет `.env` (0600) с автоген-секретами и запускает `docker compose up -d --build` (нужны Docker + compose v2, вопросы те же без порта и firewall).
- `--tarball <path>` — установить из локального tarball, не скачивая релиз.
- `--update` — обновление: умолчания для вопросов берутся из существующей установки (`/etc/enotdesk/enotdesk.env`: порт/URL/прокси), прежние секреты сохраняются (их ротация сломала бы TOTP и coturn). Существующая установка без `--update` — честный отказ с подсказкой.
- `--dry-run` — показать план и выйти, ничего не делая (root и docker не нужны; секреты в плане — только маски «(автогенерация)» или «(сохранён из существующей установки)» при `--update`, пароль не отображается никогда).
- Неинтерактивно (CI): `--domain <d> --admin-login <l> --admin-name <n> --port <p> --no-firewall --admin-password-stdin` — пароль одной строкой из stdin. В этом режиме stdin занят паролём, поэтому вопросы не задаются вовсе: все остальные значения обязаны прийти флагами (`--domain ''` — явное «домена нет»); недостающее — честный отказ до чтения stdin, пароль никуда не печатается.
- Источник переопределяется переменными `ENOT_SETUP_REPO` (по умолчанию `Flint-sega/enotdesk`) и `ENOT_SETUP_VERSION` (тег или `latest`).

В конце мастер печатает адреса `/downloads` и `/operator`, логин (и автоген-пароль — один раз), предупреждение про HTTP без домена с подсказкой «A-запись → перезапуск с `--update`», команды обновления/удаления и подсказку проверки `scripts/smoke-remote.mjs`. Если health не поднялся за 90 секунд, показывается хвост `journalctl -u enotdesk -n 20`. Ответ «администратор уже существует» при bootstrap — не ошибка установки.

Дальше — управление, бэкапы и диагностика в разделах ниже (всё относится и к установке мастером).

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
NODE_VERSION=24.22.1
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
install -d /opt/node-24
tar -xJf "node-v$NODE_VERSION-linux-x64.tar.xz" -C /opt/node-24 --strip-components=1
ln -sfn /opt/node-24/bin/node /usr/local/bin/node
ln -sfn /opt/node-24/bin/npm  /usr/local/bin/npm
ln -sfn /opt/node-24/bin/npx  /usr/local/bin/npx
node -v    # ожидается v24.22.1
```

Если `node -v` уже равен нужной версии, шаг можно пропустить. Исправления безопасности Node 24 ставьте в течение двух недель после выхода (ADR 0037): `install-server.sh --update` сам заменит Node, если версия в установщике новее установленной. Установщик `install-server.sh` делает то же самое идемпотентно (версия переопределяется `NODE_VERSION`). На arm64 скачайте tarball `linux-arm64` и повторите распаковку/симлинки — автоматически поддерживается только x86_64.

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

**Env-файл `/etc/enotdesk/enotdesk.env` — секретный и без него бэкап неполон.** В нём `ENOT_SECRET_KEY` (им зашифрованы секреты 2FA: база, восстановленная без этого ключа, не пустит пользователей с включённой 2FA — см. `reset-2fa` ниже), `ENOT_TURN_SECRET` (общий секрет с coturn) и остальные настройки. Храните его копию отдельно от бэкапов базы — например, в менеджере паролей владельца сервера, — а не рядом с ними на том же диске.

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
# база хаба — с префиксом hub-, как у таймера (иначе дамп получит имя enotdesk-… и смешается с основным)
sudo -u enotdesk /opt/node-24/bin/node /opt/enotdesk/current/server/backup.mjs \
  /var/lib/enotdesk/hub.db /var/lib/enotdesk/backups 10 hub-
```

### 7.2. Что хранить вне сервера и как восстановиться на новом

Ежедневный таймер установщика (`enotdesk-backup.timer`, 04:30) кладёт дампы **обеих** баз — `enotdesk.db` и `hub.db` (префикс `hub-`) — в `/var/lib/enotdesk/backups`, то есть на тот же диск. Если пропадёт сам сервер, пропадут и они. Минимум, который должен жить вне сервера:

1. свежий дамп `enotdesk-*.db` и `hub-*.db` — раз в сутки и зашифрованным (готовая схема с наблюдателем — §7.3);
2. копия `/etc/enotdesk/enotdesk.env` (отдельно от дампов, см. выше);
3. при своём домене — ничего больше: Caddy заново получит сертификат, coturn конфиг пересоздаст установщик из env-файла.

Восстановление на чистом сервере:

```bash
# 0) на минимальной системе установщику нужны curl и xz
sudo apt-get install -y curl xz-utils ca-certificates
# 1) поставить ту же или более новую версию тем же установщиком (без bootstrap):
#    архив сервера enotdesk-server.tar.gz — из GitHub Releases (SHA256 сверить по checksums-sha256.txt)
sudo ENOT_PUBLIC_URL=https://ваш.домен ENOT_HUB=1 bash install-server.sh enotdesk-server.tar.gz
# 2) вернуть env-файл со старыми секретами и базы
sudo systemctl stop enotdesk enotdesk-hub 2>/dev/null || true
sudo install -m 0600 -o root -g root enotdesk.env /etc/enotdesk/enotdesk.env
sudo install -m 0640 -o enotdesk -g enotdesk enotdesk-<штамп>.db /var/lib/enotdesk/enotdesk.db
sudo install -m 0640 -o enotdesk -g enotdesk hub-<штамп>.db /var/lib/enotdesk/hub.db   # если был хаб
sudo rm -f /var/lib/enotdesk/*.db-wal /var/lib/enotdesk/*.db-shm
# 3) пересоздать конфиг coturn из секрета env-файла и запустить всё (архив — тот же, что на шаге 1)
sudo bash install-server.sh --update enotdesk-server.tar.gz --reset-turn
curl -fsS http://127.0.0.1:8080/api/v1/health
```

Миграции схемы применятся сами при старте. Машины переподключатся сами (их токены в базе), если адрес сервера не изменился. Хаб поднимется, если в восстановленном env-файле есть `ENOT_HUB='1'` (так его записывает установщик). Учения 24.10.2026 на чистом контейнере Debian 13: от пустой машины до работающего сервера с базами — 2,5 минуты; вход по 2FA, вход администратора, машины (агент вышел online по старому токену) и данные хаба — на месте.

**Аварийное снятие 2FA.** Если администратор потерял телефон и резервные коды или база восстановлена без прежнего `ENOT_SECRET_KEY`, снимите 2FA с консоли сервера:

```bash
sudo -u enotdesk env ENOT_DB=/var/lib/enotdesk/enotdesk.db /opt/node-24/bin/node /opt/enotdesk/current/server/main.mjs reset-2fa <логин>
```

Команда выключает 2FA, удаляет резервные коды, завершает все входы пользователя и пишет запись «2FA снята с консоли сервера» в журнал безопасности (пишется всегда). Через веб-панель снять чужую 2FA нельзя — только с консоли сервера.

### 7.3. Копия вне сервера и наблюдение

Нужна вторая, постоянно включённая Linux-машина в другом месте: второй сервер, домашний сервер. Назовём её наблюдателем. Она делает две вещи:

- **раз в 5 минут проверяет сервер снаружи** (`scripts/watch-server.sh check`): health сервера и хаба, срок сертификата TLS, порт TURN, а по ssh — занятость диска и возраст свежих дампов;
- **раз в сутки забирает копию** (`scripts/watch-server.sh pull`): свежие дампы обеих баз и `SHA256SUMS` одним архивом.

Безопасность:
- Копию шифрует сам сервер открытым ключом [age](https://age-encryption.org). Закрытый ключ хранится только у владельца, в менеджере паролей. Его нет ни на сервере, ни на наблюдателе.
- Ssh-ключ наблюдателя на сервере ограничен принудительной командой (`scripts/offsite-serve.sh`). Он умеет только `status` и `fetch`, без оболочки и пробросов.
- Без age или без файла получателей `fetch` отказывает: открытую копию сервер не отдаёт.
- Env-файл в копию не входит. Его копия — отдельно, в менеджере паролей (§7).

Оповещения идут через [Healthchecks](https://healthchecks.io) (облачный или свой экземпляр):
- При успехе наблюдатель пингует свою проверку, при сбое — `/fail` с причиной. Канал (почта, Telegram, push) настраивается в Healthchecks.
- Если наблюдатель замолчал (упал сам или его сеть), Healthchecks поднимет тревогу по пропущенному пингу.
- Секрет проверки (URL пинга) не попадает в аргументы процессов: curl получает его через stdin.
- Перед тревогой каждая проверка повторяется через 20 секунд. Поэтому один сбой сети тревогу не поднимет.

**Ключ копий** — на своём компьютере:

```bash
age-keygen -o enotdesk-offsite.key   # закрытый ключ — в менеджер паролей; на сервер и наблюдатель не класть
# строка «Public key: age1…» — открытый ключ, он нужен серверу
```

**На сервере:**

```bash
sudo apt-get install -y age
sudo install -m 0755 scripts/offsite-serve.sh /usr/local/sbin/enotdesk-offsite
echo 'age1…' | sudo tee /etc/enotdesk/offsite-recipients.txt
# ключ наблюдателя — только эта команда; from= — адрес наблюдателя, если он постоянный
echo 'restrict,from="203.0.113.7",command="/usr/local/sbin/enotdesk-offsite" ssh-ed25519 AAAA… enotdesk-watch' \
  | sudo tee -a /root/.ssh/authorized_keys
sudo /usr/local/sbin/enotdesk-offsite status
```

Дамп моложе минуты `status` и `fetch` не берут: `VACUUM INTO` пишет прямо в итоговый файл, и такой дамп может быть ещё недописан.

**На наблюдателе:**

```bash
sudo apt-get install -y curl openssl
sudo install -m 0755 scripts/watch-server.sh /usr/local/sbin/enotdesk-watch
sudo ssh-keygen -t ed25519 -N '' -C enotdesk-watch -f /root/.ssh/enotdesk-watch
# ключ сервера — в отдельный known_hosts (проверка строгая); отпечаток сверить на сервере:
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
sudo sh -c 'ssh-keyscan -t ed25519 support.example.com > /etc/enotdesk-watch.known_hosts'
```

Конфиг `/etc/enotdesk-watch.conf` (root, 0600). Формат — строки `КЛЮЧ=значение`, неизвестный ключ — ошибка:

```ini
WATCH_URL=https://support.example.com
WATCH_HUB_URL=https://support.example.com/api/hub/health
WATCH_TCP=support.example.com:3478
WATCH_SSH=root@support.example.com
WATCH_SSH_KEY=/root/.ssh/enotdesk-watch
WATCH_KNOWN_HOSTS=/etc/enotdesk-watch.known_hosts
WATCH_PING_CHECK=https://hc-ping.com/<uuid проверки «сервер»>
WATCH_PING_BACKUP=https://hc-ping.com/<uuid проверки «копия»>
WATCH_DIR=/var/lib/enotdesk-offsite
WATCH_KEEP=30
```

Пороги по умолчанию:
- занятость диска — до 90 %;
- дамп — не старше 26 часов;
- сертификат — ещё не меньше 14 дней.

Остальные ключи и пороги — в начале `scripts/watch-server.sh`.

В Healthchecks заведите две проверки:
- «сервер»: период 5 минут, запас 5 минут — тревога о падении приходит не позже чем через 10 минут;
- «копия»: период 1 сутки, запас 2 часа.

Таймеры наблюдателя (systemd):

```ini
# /etc/systemd/system/enotdesk-watch.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/enotdesk-watch check
TimeoutStartSec=4min

# /etc/systemd/system/enotdesk-watch.timer
[Timer]
OnCalendar=*:0/5
AccuracySec=10s
[Install]
WantedBy=timers.target

# /etc/systemd/system/enotdesk-offsite.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/enotdesk-watch pull
TimeoutStartSec=30min

# /etc/systemd/system/enotdesk-offsite.timer — через час после бэкапа сервера (04:30 + до 30 мин по его часам);
# пояс сервера указан явно: у наблюдателя он может быть другим
[Timer]
OnCalendar=*-*-* 05:30:00 UTC
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now enotdesk-watch.timer enotdesk-offsite.timer
sudo /usr/local/sbin/enotdesk-watch check   # вручную: «OK» и строка по каждой проверке
sudo /usr/local/sbin/enotdesk-watch pull
```

**Восстановление из копии:**

```bash
mkdir restore
age -d -i enotdesk-offsite.key enotdesk-offsite-<штамп>.tar.age | tar -x -C restore
(cd restore && sha256sum -c SHA256SUMS)
```

Дальше — шаг 2 из §7.2. Env-файл берите из менеджера паролей.

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

- **TURN (coturn)**: apt-пакет; `/etc/turnserver.conf` с `use-auth-secret` и `static-auth-secret` (секрет генерируется один раз и хранится в env-файле `/etc/enotdesk/enotdesk.env`, 0600, как `ENOT_TURN_SECRET` — повторные запуски дают те же креды); realm и `external-ip` берутся из `ENOT_PUBLIC_URL`; креды для клиентов (`ENOT_TURN_URLS`, `ENOT_TURN_USERNAME`, `ENOT_TURN_PASSWORD`) пишутся в тот же env-файл. Порты: `3478` tcp/udp, relay `49160–49999`/udp. Существующий `/etc/turnserver.conf` без пометки EnotDesk сохраняется как `*.bak-<штамп>`. Повторные запуски и `--update` уже настроенный стек не пересоздают (только обновляют env-файл), внешний TURN с `ENOT_TURN_URLS` в env не трогают; принудительная перенастройка — `--reset-turn`.
- **TLS (Caddy)**: apt-пакет из официального репозитория; `/etc/caddy/Caddyfile` — `домен → reverse_proxy 127.0.0.1:PORT`, сертификат Let's Encrypt автоматически; сервер переводится на `ENOT_HOST=127.0.0.1`, публичный URL — `https://<домен>`. Существующий `Caddyfile` без пометки EnotDesk сохраняется как `*.bak-<штамп>`. Управляемый `Caddyfile` перезаписывается при каждом `--update`/деплое, поэтому другие сайты на этом же Caddy кладите отдельными файлами `/etc/caddy/sites.d/<имя>.caddy` — последней строкой он делает `import /etc/caddy/sites.d/*.caddy`, и они переживают деплой.
- Домен берётся из `ENOT_PUBLIC_URL` (например, `ENOT_PUBLIC_URL=https://example.com`). Если домена нет — TLS честно пропускается с предупреждением в логе установки (незащищённый локальный http-режим), TURN при этом ставится (realm = IP).
- Отказ: `--no-turn` и/или `--no-tls`; план без изменений: `--dry-run`.

Безопасность значений: `ENOT_PUBLIC_URL` проверяется на формат `[https?://]host[:port][/]` (только буквы, цифры, точка, дефис) до любой записи в `Caddyfile`/`turnserver.conf` — значения с посторонними символами установщик честно отклоняет. Значения env-файла пишутся в одинарных кавычках с экранированием (`KEY='value'`, `'` → `'\''`): содержимое переменной не может «выехать» за пределы своей строки (systemd раскрывает кавычки сам). Tarball перед распаковкой валидируется: допускаются только пути из сборки `deploy-server.sh` (`server/`, `assets/`, `client/lib/i18n.mjs`, `client/locales/`, `package.json`, `package-lock.json`, `scripts/install-server.sh`); абсолютные пути, `..` и symlink/hardlink-записи отклоняются с честной ошибкой. Дампы `--backup` складываются в `/var/lib/enotdesk/backups` с правами 0700.

Проверка после установки:

```bash
curl -fsS https://example.com/api/v1/health
systemctl status coturn caddy
ss -ulnp | grep -E ':3478|4916'   # слушает coturn
journalctl -u coturn -b | grep -i 'config file'   # пусто — конфиг прочитан
```

Если в журнале coturn есть «Cannot find config file», служба (пользователь `turnserver`) не может прочитать `/etc/turnserver.conf` и работает на настройках по умолчанию — без секрета и realm, ретрансляция не выдаётся. Так было у установок до 0.6.29: файл получал права `root:root 0600`. Исправление: `sudo chgrp turnserver /etc/turnserver.conf && sudo chmod 0640 /etc/turnserver.conf && sudo systemctl restart coturn` (или повторный `install-server.sh --update <архив сервера> --reset-turn`). В строках этого файла не пишите комментарии после значения (`опция  # текст`) — coturn их не понимает.

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
max-port=49999
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

Порты в файрволе: `ufw allow 3478/tcp`, `ufw allow 3478/udp`, `ufw allow 49160:49999/udp`.

Если TLS не настроен и сервер работает по http без домена, установщик предупреждает об этом в логе и в итоговом сообщении установки, а страницы `/downloads` и `/invite` дополнительно показывают предупреждающую плашку о небезопасном режиме (её рисует сервер при http без домена).

## 10. Диагностика

```bash
systemctl is-active enotdesk                 # active?
curl -fsS http://127.0.0.1:8080/api/v1/health # {"ok":true,...}
ss -ltnp | grep 8080                          # кто слушает порт
journalctl -u enotdesk -n 100 --no-pager      # почему не поднялся
```

Частые причины: порт занят (`ss -ltnp | grep :8080` покажет процесс), нет доступа к БД (владелец `/var/lib/enotdesk` должен быть `enotdesk`), ошибка в env-файле (systemd не раскрывает подстановки — только литеральные значения).

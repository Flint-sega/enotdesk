# Docker: EnotDesk одним стеком

Самостоятельный хостинг EnotDesk одной командой: сервер, TURN (coturn) и авто-HTTPS (Caddy) поднимаются вместе, данные живут в Docker-томах и переживают пересоздание контейнеров.

## Состав

| Сервис | Что делает | Порты |
|---|---|---|
| `enotdesk` | сервер (control plane + сигналинг), собирается из этого репозитория (`Dockerfile`, node:24-alpine) | `127.0.0.1:8080` (только loopback) |
| `coturn` | TURN/STUN-релей для видео, `use-auth-secret` из `TURN_SECRET`, realm из `DOMAIN` | `3478/tcp+udp`, релей `49160-49999/udp` (host-сеть) |
| `caddy` | обратный прокси + сертификат Let's Encrypt при заданном `DOMAIN`; без домена — HTTP `:80` с предупреждением в логах | `80`, `443` (tcp+udp) |

Все три контейнера захарднены: корневая ФС только для чтения (`read_only`), `cap_drop: ALL` (caddy и coturn добавляют только `NET_BIND_SERVICE` — 80/443 у caddy и file-capability бинарника turnserver), `no-new-privileges`. `TURN_SECRET` нигде не попадает в argv: entrypoint coturn (`docker/coturn/entrypoint.sh`) генерирует конфиг `/run/turnserver.conf` (tmpfs, 0600) и запускает `turnserver -c`, а серверу секрет уходит переменной `ENOT_TURN_SECRET` (эфемерные TURN-креды). `DOMAIN`/`ENOT_PUBLIC_URL` проверяются на формат хостнейма до интерполяции в конфиги — посторонние символы честно отклоняются.

Данные: том `enotdesk-data` (БД `/data/enotdesk.db`) и `enotdesk-dist` (сборки `/data/dist`). `docker compose down` их сохраняет; удаляются только `docker compose down -v` — не делай этого на живом сервере.

## Требования

- Docker + compose v2.
- Домен, указывающий на сервер (для HTTPS и TURN), и открытые порты: `80/tcp`, `443/tcp+udp`, `3478/tcp+udp`, `49160-49999/udp`.
- coturn работает в `network_mode: host` (релейным кандидатам нужен внешний адрес машины) — это Linux-хост, то есть обычный VPS. На Docker Desktop (mac/win) стек поднимется и health ответит, но TURN-релей может не заработать — для боевого использования берите Linux VPS (2 vCPU / 2–4 ГБ RAM / 20 ГБ SSD достаточно).

## Быстрый старт (~5 минут)

```sh
git clone <repo> enotdesk && cd enotdesk
cp .env.example .env
# в .env заполни: DOMAIN=enotdesk.example.com, TURN_SECRET=<длинная случайная строка>
docker compose up -d
```

Первый админ (интерактивно, перезапись существующего отказана):

```sh
docker compose exec enotdesk node server/main.mjs bootstrap
```

Проверка:

```sh
curl -s https://$DOMAIN/api/v1/health   # {"ok":true,...}
```

Дальше: оператор заходит браузером на `https://$DOMAIN/operator` или ставит desktop-клиент со страницы `/downloads`; клиент помощи открывает `/invite` и получает ID/пароль.

## Без домена (честный локальный режим)

Оставь `DOMAIN` пустым — Caddy отдаст HTTP на `:80`, а в логах (`docker compose logs caddy`) появится предупреждение, что HTTPS выключен. TURN при этом клиенту не отдан (релею нужен публичный адрес) — `docker compose logs enotdesk` скажет об этом честно. Для локальных проверок health: `curl -s http://127.0.0.1:8080/api/v1/health`.

## Обновление и обслуживание

```sh
git pull
docker compose build
docker compose up -d
```

Смена пароля админа — тем же `bootstrap` (перезапись отклоняется; см. `docs/SERVER.md` для остальных операций). Бэкап БД: `docker compose exec enotdesk node -e "..."` не нужен — достаточно остановить запись и скопировать том, либо использовать `server/backup.mjs` (`VACUUM INTO`) по `docs/SERVER.md`.

## TURN over TLS и сеть «только 443»

Для сети, где наружу разрешён только TCP 443, включите TURN/TLS:

```sh
mkdir -p turn-certs
# положите сюда сертификат и ключ для TURN_TLS_HOST
TURN_TLS_PORT=443 TURN_TLS_HOST=turn.example.com docker compose up -d
```

`TURN_TLS_CERT` и `TURN_TLS_KEY` по умолчанию указывают на
`/run/turn-certs/fullchain.pem` и `/run/turn-certs/privkey.pem`; каталог
`./turn-certs` монтируется в coturn только для чтения. Сервер добавляет URL
`turns:<host>:<port>?transport=tcp` в `/rtc-config`, а coturn проверяет наличие
сертификата до запуска. `TURN_TLS_LISTEN_IP` позволяет привязать TLS к отдельному
публичному IP.

В стандартном compose Caddy уже занимает TCP 443. Поэтому для `443` на том же
IP нужен внешний TCP/SNI edge, который отправляет отдельное имя TURN на coturn,
либо отдельный публичный IP для TURN; конфликт намеренно не скрывается.

## Известные границы v1

- TURN over TLS включается явно через `TURN_TLS_PORT` и сертификат; по умолчанию видео
  идёт через `turn:$DOMAIN:3478` (udp/tcp).
- coturn в host-сети: порты 3478 и 49160-49999 заняты на хосте напрямую.
- Сборки клиента для `/downloads` кладутся в том `enotdesk-dist`: `docker cp путь/к/файлу enotdesk-enotdesk-1:/data/dist/` (имена файлов — по allowlist сервера).

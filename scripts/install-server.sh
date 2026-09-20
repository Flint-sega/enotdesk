#!/usr/bin/env bash
# EnotDesk — установщик сервера (Debian/Ubuntu, от root).
# Идемпотентен: повторный запуск с тем же tarball переиспользует релиз.
#
# Использование:
#   bash scripts/install-server.sh <app.tar.gz> [--dry-run] [--no-turn] [--no-tls] [--open-firewall]
#   bash scripts/install-server.sh --update <app.tar.gz>
#   bash scripts/install-server.sh --uninstall [--purge-data]
#   bash scripts/install-server.sh --help
#
# Env (имена, значения задаются снаружи): ENOT_PORT, ENOT_BIND, ENOT_PUBLIC_URL,
# ENOT_DB, ENOT_TURN_URLS, ENOT_TURN_USERNAME, ENOT_TURN_PASSWORD, NODE_VERSION.
# ENOT_TURN_SECRET управляется установщиком (secret coturn, хранится в env-файле 0600).
set -euo pipefail

ENOT_USER="enotdesk"
OPT_DIR="/opt/enotdesk"
RELEASES_DIR="$OPT_DIR/releases"
CURRENT_LINK="$OPT_DIR/current"
DATA_DIR="/var/lib/enotdesk"
ENV_DIR="/etc/enotdesk"
ENV_FILE="$ENV_DIR/enotdesk.env"
UNIT_FILE="/etc/systemd/system/enotdesk.service"
SERVICE_NAME="enotdesk"
NODE_PREFIX="/opt/node-24"

NODE_VERSION="${NODE_VERSION:-24.12.0}"
PORT="${ENOT_PORT:-8080}"
BIND="${ENOT_BIND:-0.0.0.0}"
DB_PATH="${ENOT_DB:-$DATA_DIR/enotdesk.db}"
DIST_DIR="${ENOT_DIST_DIR:-}"
PUBLIC_URL=""
TURN_URLS="${ENOT_TURN_URLS:-}"
TURN_USERNAME="${ENOT_TURN_USERNAME:-}"
TURN_PASSWORD="${ENOT_TURN_PASSWORD:-}"
TURN_SECRET=""
TURN_CONF="/etc/turnserver.conf"
CADDYFILE="/etc/caddy/Caddyfile"
SETUP_TURN=1
SETUP_TLS=1
RESET_TURN=0
EDGE_HOST=""
REALM=""
DOMAIN=""
TLS_ACTIVE=0

MODE="install"
TARBALL=""
RELEASE=""
DRY_RUN=0
OPEN_FIREWALL=0
PURGE_DATA=0

usage() {
  cat <<'EOF'
EnotDesk — установщик сервера.

Использование:
  install-server.sh <app.tar.gz> [опции]   установить или обновить сервер
  install-server.sh --update <app.tar.gz>  поставить новый релиз и переключить current
  install-server.sh --backup               консистентный дамп БД в /var/lib/enotdesk/backups
  install-server.sh --uninstall [--purge-data]
  install-server.sh --help

Опции:
  <app.tar.gz>       tarball приложения (server/, client/lib/i18n.mjs, client/locales/, package.json, package-lock.json)
  --dry-run          показать план и выйти, ничего не меняя
  --update <tar>     то же, что установка с явным tarball (атомарная смена symlink)
  --backup           дамп БД (VACUUM INTO, безопасно на живом сервере); BACKUP_KEEP — сколько дампов хранить (по умолчанию 10)
  --uninstall        остановить и удалить unit и релизы; БД сохраняется
  --purge-data       вместе с --uninstall удалить и /var/lib/enotdesk
  --open-firewall    открыть порт в ufw, если ufw активен (иначе только сообщить)
  --no-turn          не ставить coturn; TURN настраивается снаружи (ENOT_TURN_* в env)
  --no-tls           не ставить Caddy; сервер останется в локальном http-режиме
  --reset-turn       перенастроить встроенный coturn, даже если в env уже есть ENOT_TURN_URLS
  --help             эта справка

Переменные окружения:
  ENOT_PORT          порт сервера (по умолчанию 8080)
  ENOT_BIND          адрес привязки (по умолчанию 0.0.0.0; при TLS принудительно 127.0.0.1)
  ENOT_PUBLIC_URL    публичный URL (по умолчанию http://<первый IP>:<порт>; https://<домен> включает TLS)
  ENOT_DB            путь к БД (по умолчанию /var/lib/enotdesk/enotdesk.db)
  NODE_VERSION       версия Node.js из tarball nodejs.org (по умолчанию 24.12.0)
  ENOT_TURN_URLS, ENOT_TURN_USERNAME, ENOT_TURN_PASSWORD — внешний TURN (--no-turn)

По умолчанию установщик сам ставит TURN (coturn: порт 3478 tcp/udp, relay 49160–49200/udp,
static-auth-secret генерируется в env-файл 0600, realm — из ENOT_PUBLIC_URL) и TLS
(Caddy из официального репозитория: авто-HTTPS на 80/443 tcp+udp, домен из ENOT_PUBLIC_URL
→ 127.0.0.1:PORT). Уже настроенный внешний TURN из env-файла не перезаписывается;
принудительная перенастройка встроенного coturn — --reset-turn. Для Caddy и coturn нужен
работающий apt; без домена в ENOT_PUBLIC_URL TLS честно пропускается с предупреждением
(локальный http-режим).
EOF
}

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# P2-15: хостнейм ^[A-Za-z0-9.-]+$ — только буквы/цифры/точки/дефисы; всё, что
# в него не помещается (пробелы, ;, `, $, переводы строк), честно отклоняется
# до интерполяции в Caddyfile/turnserver.conf/env-файл.
valid_host() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*) return 1 ;;
  esac
  return 0
}

# ENOT_PUBLIC_URL: [https?://]host[:port][/]. Схема опциональна, хост — valid_host.
valid_public_url() {
  local u="$1" hostpart h p
  case "$u" in
    http://*|https://*) hostpart="${u#*://}" ;;
    *) hostpart="$u" ;;
  esac
  hostpart="${hostpart%/}"  # один хвостовой слэш разрешён
  case "$hostpart" in
    *:*)
      h="${hostpart%:*}"; p="${hostpart##*:}"
      case "$p" in ''|*[!0-9]*) return 1 ;; esac
      valid_host "$h"
      ;;
    *) valid_host "$hostpart" ;;
  esac
}

# Значение env-файла в одинарных кавычках с экранированием (тот же паттерн, что
# в scripts/deploy-server.sh): systemd EnvironmentFile раскрывает кавычки, а
# содержимое значения не может вырваться за пределы своей переменной.
env_kv() {
  local key="$1" val="$2" esc
  esc="$(printf '%s' "$val" | sed "s/'/'\\\\''/g")"
  printf "%s='%s'\n" "$key" "$esc"
}

NODE_TMP=""
node_tmp_cleanup() { [ -n "$NODE_TMP" ] && rm -rf "$NODE_TMP"; return 0; }
trap node_tmp_cleanup EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    --update)
      MODE="update"
      shift
      [ $# -gt 0 ] || die "--update требует путь к tarball"
      TARBALL="$1"
      ;;
    --uninstall) MODE="uninstall" ;;
    --backup) MODE="backup" ;;
    --purge-data) PURGE_DATA=1 ;;
    --open-firewall) OPEN_FIREWALL=1 ;;
    --no-turn) SETUP_TURN=0 ;;
    --no-tls) SETUP_TLS=0 ;;
    --reset-turn) RESET_TURN=1 ;;
    -*) die "неизвестный аргумент: $1 (справка: --help)" ;;
    *) TARBALL="$1" ;;
  esac
  shift
done

if [ "$PURGE_DATA" = "1" ] && [ "$MODE" != "uninstall" ]; then
  die "--purge-data работает только вместе с --uninstall"
fi

preflight() {
  if [ "$(id -u)" != "0" ]; then
    die "нужны права root — запустите через sudo (например: sudo bash $0 <app.tar.gz>)"
  fi
  if [ ! -r /etc/os-release ]; then
    die "не удалось определить ОС (нет /etc/os-release); поддерживаются Debian и Ubuntu"
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    debian:*|ubuntu:*|*:debian*|*:ubuntu*) ;;
    *) die "поддерживаются только Debian/Ubuntu, обнаружено: ${PRETTY_NAME:-неизвестная ОС}" ;;
  esac
  command -v systemctl >/dev/null 2>&1 || die "systemd не найден — нужна Ubuntu/Debian с systemd"
  command -v curl >/dev/null 2>&1 || die "не найден curl — он нужен для скачивания Node tarball (пакет curl)"
  command -v tar >/dev/null 2>&1 || die "не найден tar — он нужен для распаковки (пакет tar)"
  command -v xz >/dev/null 2>&1 || die "не найден xz — он нужен для распаковки Node .tar.xz (пакет xz-utils)"
}

check_tarball() {
  [ -n "$TARBALL" ] || die "не указан tarball приложения. Пример: sudo bash $0 /tmp/enotdesk-install/app.tar.gz"
  [ -f "$TARBALL" ] || die "tarball не найден: $TARBALL"
  local list
  list="$(tar -tzf "$TARBALL" 2>/dev/null)" || die "tarball повреждён или это не tar.gz: $TARBALL"
  printf '%s\n' "$list" | grep -qE '(^|\./)server/main\.mjs$' || die "в tarball нет server/main.mjs — это не сборка EnotDesk"
  printf '%s\n' "$list" | grep -qE '(^|\./)client/lib/i18n\.mjs$' || die "в tarball нет client/lib/i18n.mjs (нужен для страниц /downloads и /invite) — соберите tarball свежим scripts/deploy-server.sh"
  # P2-14: распаковке подлежат только пути из allowlist deploy-server.sh
  # (server/, assets/, client/lib/i18n.mjs, client/locales/, package.json,
  # package-lock.json, scripts/install-server.sh). Абсолютные пути, «..»
  # в компонентах пути и ссылки (symlink/hardlink) запрещены — отказ до распаковки.
  # Ссылки ищутся в ПОДРОБНОМ листинге (строка «l…» и « -> цель»): GNU tar и bsdtar
  # печатают цель ссылки только с -v, а symlink на разрешённом пути — реальный вектор.
  local reason
  reason="$(tar -tvzf "$TARBALL" 2>/dev/null | grep -E ' -> | link to ' | head -n 1 || true)"
  if [ -n "$reason" ]; then
    die "tarball отклонён, распаковка отменена: ссылка в tarball: $reason — внутри сборки не должно быть symlink/hardlink"
  fi
  reason="$(printf '%s\n' "$list" | awk '
    / -> / || / link to / { print "ссылка в tarball: " $0; exit 1 }
    /^\//                 { print "абсолютный путь: " $0; exit 1 }
    {
      p = $0; sub(/^\.\//, "", p)
      n = split(p, parts, "/")
      for (i = 1; i <= n; i++)
        if (parts[i] == "..") { print "переход выше корня (..): " $0; exit 1 }
      ok = (index(p, "server/") == 1 || index(p, "assets/") == 1 \
         || index(p, "client/locales/") == 1 \
         || p == "client/lib/i18n.mjs" || p == "scripts/install-server.sh" \
         || p == "package.json" || p == "package-lock.json")
      if (!ok) { print "путь вне allowlist: " $0; exit 1 }
    }
  ' 2>/dev/null)" || true
  if [ -n "$reason" ]; then
    die "tarball отклонён, распаковка отменена: $reason (ожидается сборка scripts/deploy-server.sh: server/, assets/, client/lib/i18n.mjs, client/locales/, package.json, package-lock.json, scripts/install-server.sh)"
  fi
}

# SHA256 (12 символов); shasum — запасной путь, чтобы --dry-run показывал план на любой машине.
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -c1-12
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -c1-12
  else
    die "не найден sha256sum — он нужен для именования релизов"
  fi
}

check_port() {
  command -v ss >/dev/null 2>&1 || return 0
  if ss -ltnH 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; then
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      info "порт $PORT занят сервисом $SERVICE_NAME — он будет перезапущен"
    else
      die "порт $PORT уже занят другим процессом — освободите порт или задайте ENOT_PORT"
    fi
  fi
}

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -v 2>/dev/null)" = "v$NODE_VERSION" ]
}

ensure_node() {
  if node_version_ok; then
    info "Node.js $(node -v) уже установлен — шаг пропущен"
    return 0
  fi

  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="linux-x64" ;;
    *) die "tarball ставится только на x86_64 (amd64); обнаружено: $(uname -m). Установите Node $NODE_VERSION вручную и повторите." ;;
  esac

  local base="https://nodejs.org/dist/v$NODE_VERSION"
  local file="node-v$NODE_VERSION-$arch.tar.xz"
  NODE_TMP="$(mktemp -d)"

  info "скачиваю $base/$file"
  curl -fsSL "$base/$file" -o "$NODE_TMP/$file" || die "не удалось скачать $base/$file — проверьте доступ к nodejs.org"
  curl -fsSL "$base/SHASUMS256.txt" -o "$NODE_TMP/SHASUMS256.txt" || die "не удалось скачать $base/SHASUMS256.txt"

  local sum
  sum="$(grep " $file\$" "$NODE_TMP/SHASUMS256.txt" || true)"
  [ -n "$sum" ] || die "в SHASUMS256.txt нет строки для $file"
  info "проверяю SHA256"
  ( cd "$NODE_TMP" && printf '%s\n' "$sum" | sha256sum -c - ) || die "SHA256 не совпал — скачанный tarball повреждён"

  info "распаковываю новый Node ($NODE_PREFIX.tmp)"
  if [ ! -e "$NODE_PREFIX" ] && [ -e "$NODE_PREFIX.bak" ]; then
    mv "$NODE_PREFIX.bak" "$NODE_PREFIX" || die "не удалось вернуть прежний $NODE_PREFIX из .bak"
  fi
  rm -rf "$NODE_PREFIX.tmp"
  install -d -m 0755 "$NODE_PREFIX.tmp"
  tar -xJf "$NODE_TMP/$file" -C "$NODE_PREFIX.tmp" --strip-components=1 || die "не удалось распаковать $file — прежний $NODE_PREFIX не тронут"
  rm -rf "$NODE_PREFIX.bak"
  if [ -e "$NODE_PREFIX" ]; then
    mv "$NODE_PREFIX" "$NODE_PREFIX.bak" || die "не удалось отодвинуть прежний $NODE_PREFIX"
  fi
  if ! mv "$NODE_PREFIX.tmp" "$NODE_PREFIX"; then
    if [ -e "$NODE_PREFIX.bak" ]; then mv "$NODE_PREFIX.bak" "$NODE_PREFIX" || true; fi
    die "не удалось установить $NODE_PREFIX — прежний Node возвращён из .bak"
  fi
  rm -rf "$NODE_PREFIX.bak"
  ln -sfn "$NODE_PREFIX/bin/node" /usr/local/bin/node
  ln -sfn "$NODE_PREFIX/bin/npm" /usr/local/bin/npm
  ln -sfn "$NODE_PREFIX/bin/npx" /usr/local/bin/npx
  hash -r 2>/dev/null || true
  node_version_ok || die "Node.js распакован, но node -v не равен v$NODE_VERSION — проверьте /usr/local/bin в PATH"
  info "установлен Node.js $(node -v) в $NODE_PREFIX"
}

resolve_public_url() {
  if [ -n "${ENOT_PUBLIC_URL:-}" ]; then
    PUBLIC_URL="$ENOT_PUBLIC_URL"
    return 0
  fi
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$ip" ]; then
    ip="$(hostname -f 2>/dev/null || echo 127.0.0.1)"
  fi
  PUBLIC_URL="http://${ip}:${PORT}"
}

# Хост из ENOT_PUBLIC_URL без схемы/порта; домен для TLS и realm для coturn.
# P2-15: URL и порт валидируются до любой интерполяции в конфиги.
derive_edge() {
  valid_public_url "$PUBLIC_URL" || die "ENOT_PUBLIC_URL не похож на [https?://]host[:port][/]: '$PUBLIC_URL' — допустимы только буквы, цифры, точка, дефис, опционально порт и хвостовой / (инъекция в конфиги отклонена)"
  case "$PORT" in
    ''|*[!0-9]*) die "ENOT_PORT не число: '$PORT' — укажите числовой порт" ;;
  esac
  local host="$PUBLIC_URL"
  host="${host#*://}"
  host="${host%%/*}"
  host="${host%%:*}"
  host="${host#[}"
  host="${host%]}"
  EDGE_HOST="$host"
  DOMAIN=""
  case "$host" in
    ''|localhost|*.local) ;;         # пусто, localhost, mDNS — домена нет
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;  # IPv4-литерал — домена нет
    *:*) ;;                          # IPv6-литерал
    *.*) DOMAIN="$host" ;;
  esac
  REALM="${DOMAIN:-$EDGE_HOST}"
  [ -n "$REALM" ] || REALM="enotdesk"
  if [ "$SETUP_TLS" = "1" ] && [ -n "$DOMAIN" ]; then
    TLS_ACTIVE=1
  else
    TLS_ACTIVE=0
  fi
}

apt_ready() {
  command -v apt-get >/dev/null 2>&1 || die "apt-get не найден — $1 ставится через apt (или запустите с $2)"
}

# Креды TURN для клиентов: username — метка «годен до», password — HMAC от секрета.
# Секрет/username прокидываются через окружение: значения ENOT_* не попадают в argv.
compute_turn_creds() {
  TURN_USERNAME="2000000000"
  TURN_PASSWORD="$(TURN_USERNAME="$TURN_USERNAME" TURN_SECRET="$TURN_SECRET" "$NODE_BIN" \
    -e 'const c=require("crypto");const u=process.env.TURN_USERNAME,s=process.env.TURN_SECRET;console.log(c.createHmac("sha1",s).update(u).digest("base64"))')"
  TURN_URLS="stun:$REALM:3478,turn:$REALM:3478?transport=udp,turn:$REALM:3478?transport=tcp"
}

# coturn: apt-пакет + static-auth-secret (секрет живёт в env-файле 0600, чтобы
# повторные запуски давали те же креды TURN), realm из ENOT_PUBLIC_URL.
# Уже настроенный стек (конфиг с маркером) — только обновление env-файла; внешний
# TURN из env (ENOT_TURN_URLS) не трогается; принудительно — только --reset-turn.
setup_turn() {
  local managed=0
  if [ -f "$TURN_CONF" ] && grep -q ENOTDESK_MANAGED "$TURN_CONF"; then managed=1; fi
  if [ "$RESET_TURN" != "1" ]; then
    if [ "$managed" = "1" ]; then
      info "coturn уже настроен (ENOTDESK_MANAGED в $TURN_CONF) — apt и рестарт не нужны"
      if [ -z "$TURN_SECRET" ]; then
        TURN_SECRET="$(sed -n 's/^static-auth-secret=//p' "$TURN_CONF" | tail -n 1)"
      fi
      if [ -z "$TURN_SECRET" ]; then
        die "секрет TURN не найден ни в env-файле, ни в $TURN_CONF — перенастройте: --reset-turn"
      fi
      compute_turn_creds
      return 0
    fi
    if [ -n "$TURN_URLS" ]; then
      info "в env-файле уже есть ENOT_TURN_URLS — TURN-переменные не трогаю (внешний TURN)"
      info "  перенастроить встроенный coturn: перезапустите установщик с --reset-turn"
      return 0
    fi
  fi
  info "настраиваю TURN (coturn), realm $REALM"
  apt_ready "coturn" "--no-turn"
  if ! command -v turnserver >/dev/null 2>&1; then
    apt-get update -qq || die "apt-get update не удался — apt нужен для установки coturn (или запустите с --no-turn)"
    DEBIAN_FRONTEND=noninteractive apt-get install -y coturn >/dev/null || die "не удалось установить пакет coturn"
  fi
  if [ -z "$TURN_SECRET" ]; then
    TURN_SECRET="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    info "сгенерирован static-auth-secret (сохранён в env-файл, 0600)"
  fi
  compute_turn_creds
  local external_ip=""
  case "$EDGE_HOST" in
    ''|localhost) ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) external_ip="$EDGE_HOST" ;;
    *) external_ip="$(getent ahostsv4 "$EDGE_HOST" 2>/dev/null | awk '{print $1; exit}')" ;;
  esac
  if [ -f "$TURN_CONF" ] && ! grep -q ENOTDESK_MANAGED "$TURN_CONF"; then
    local bak="$TURN_CONF.bak-$(date -u +%Y%m%d%H%M%S)"
    cp -a "$TURN_CONF" "$bak"
    info "существующий $TURN_CONF сохранён как $bak"
  fi
  {
    echo "# EnotDesk managed (ENOTDESK_MANAGED) — перезаписывается install-server.sh"
    echo "listening-port=3478"
    echo "fingerprint"
    echo "use-auth-secret"
    echo "static-auth-secret=$TURN_SECRET"
    echo "realm=$REALM"
    echo "server-name=$REALM"
    echo "min-port=49160"
    echo "max-port=49200"
    echo "no-cli"
    echo "no-multicast-peers"
    [ -n "$external_ip" ] && echo "external-ip=$external_ip"
  } > "$TURN_CONF"
  chmod 0600 "$TURN_CONF"
  systemctl enable --now coturn >/dev/null 2>&1 || die "не удалось включить службу coturn (journalctl -u coturn)"
  systemctl restart coturn || die "coturn не запустился — смотрите journalctl -u coturn"
  info "coturn настроен: 3478 tcp/udp, relay 49160–49200/udp, креды TURN — в env-файле"
}

# Caddy из официального репозитория (как в docs/SERVER.md): авто-HTTPS для домена,
# обратный прокси на 127.0.0.1:PORT. Вызывается только при домене в ENOT_PUBLIC_URL.
ensure_caddy() {
  info "настраиваю TLS (Caddy): $DOMAIN → 127.0.0.1:$PORT"
  apt_ready "Caddy" "--no-tls"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get update -qq || die "apt-get update не удался — apt нужен для Caddy (или запустите с --no-tls)"
    DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg curl >/dev/null \
      || die "не удалось установить зависимости репозитория Caddy"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
      || die "не удалось получить ключ репозитория Caddy (dl.cloudsmith.io)"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
      || die "не удалось подключить репозиторий Caddy"
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq || die "apt-get update не удался после подключения репозитория Caddy"
    DEBIAN_FRONTEND=noninteractive apt-get install -y caddy >/dev/null || die "не удалось установить пакет caddy"
  fi
  if [ -f "$CADDYFILE" ] && ! grep -q ENOTDESK_MANAGED "$CADDYFILE"; then
    local bak="$CADDYFILE.bak-$(date -u +%Y%m%d%H%M%S)"
    cp -a "$CADDYFILE" "$bak"
    info "существующий $CADDYFILE сохранён как $bak"
  fi
  {
    echo "# EnotDesk managed (ENOTDESK_MANAGED) — перезаписывается install-server.sh"
    echo "$DOMAIN {"
    echo "    reverse_proxy 127.0.0.1:$PORT"
    echo "}"
  } > "$CADDYFILE"
  caddy validate --config "$CADDYFILE" >/dev/null 2>&1 || die "Caddyfile не прошёл проверку (caddy validate --config $CADDYFILE)"
  systemctl enable --now caddy >/dev/null 2>&1 || die "не удалось включить службу caddy"
  systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy || die "caddy не запустился — смотрите journalctl -u caddy"
  info "Caddy настроен: авто-HTTPS для $DOMAIN (порты 80/443)"
}

find_or_name_release() {
  local hash="$1" d=""
  for d in "$RELEASES_DIR"/*-"$hash"; do
    [ -d "$d" ] && RELEASE="$d"
  done
  if [ -z "$RELEASE" ]; then
    RELEASE="$RELEASES_DIR/$(date -u +%Y%m%d%H%M%S)-$hash"
  fi
}

read_env_value() {
  local key="$1" v=""
  [ -f "$ENV_FILE" ] || { echo ""; return 0; }
  v="$(sed -n "s/^${key}=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  case "$v" in
    # значения пишутся в одинарных кавычках, ' экранируется как '\'' (см. env_kv);
    # читаются и старые незакавыченные env-файлы — обратная совместимость
    \'*\')
      v="${v#\'}"; v="${v%\'}"
      v="$(printf '%s' "$v" | sed "s/'\\\\''/'/g")"
      ;;
  esac
  printf '%s' "$v"
}

# merge: переменные, не заданные в текущем прогоне, сохраняют прежние значения
# из env-файла (иначе повторный --update без TURN затирал бы настройки).
merge_env_file() {
  local old
  if [ -z "${ENOT_PORT:-}" ]; then
    old="$(read_env_value ENOT_PORT)"; if [ -n "$old" ]; then PORT="$old"; fi
  fi
  if [ -z "${ENOT_BIND:-}" ]; then
    old="$(read_env_value ENOT_HOST)"; if [ -n "$old" ]; then BIND="$old"; fi
  fi
  if [ -z "${ENOT_DB:-}" ]; then
    old="$(read_env_value ENOT_DB)"; if [ -n "$old" ]; then DB_PATH="$old"; fi
  fi
  if [ -z "${ENOT_DIST_DIR:-}" ]; then
    old="$(read_env_value ENOT_DIST_DIR)"; if [ -n "$old" ]; then DIST_DIR="$old"; fi
  fi
  if [ -z "$DIST_DIR" ]; then DIST_DIR="$DATA_DIR/dist"; fi
  if [ -z "${ENOT_PUBLIC_URL:-}" ]; then
    old="$(read_env_value ENOT_PUBLIC_URL)"; if [ -n "$old" ]; then PUBLIC_URL="$old"; fi
  fi
  if [ -z "$TURN_URLS" ]; then TURN_URLS="$(read_env_value ENOT_TURN_URLS)"; fi
  if [ -z "$TURN_USERNAME" ]; then TURN_USERNAME="$(read_env_value ENOT_TURN_USERNAME)"; fi
  if [ -z "$TURN_PASSWORD" ]; then TURN_PASSWORD="$(read_env_value ENOT_TURN_PASSWORD)"; fi
  if [ -z "$TURN_SECRET" ]; then TURN_SECRET="$(read_env_value ENOT_TURN_SECRET)"; fi
  if [ -z "${ENOT_GRACE_MS:-}" ]; then GRACE_MS="$(read_env_value ENOT_GRACE_MS)"; else GRACE_MS="$ENOT_GRACE_MS"; fi
  if [ -z "${ENOT_RETENTION_DAYS:-}" ]; then RETENTION_DAYS="$(read_env_value ENOT_RETENTION_DAYS)"; else RETENTION_DAYS="$ENOT_RETENTION_DAYS"; fi
  if [ -z "${ENOT_MAX_SESSIONS:-}" ]; then MAX_SESSIONS="$(read_env_value ENOT_MAX_SESSIONS)"; else MAX_SESSIONS="$ENOT_MAX_SESSIONS"; fi
}

print_plan() {
  echo "EnotDesk — план ($MODE, dry-run: изменения не вносятся)"
  if [ "$MODE" = "uninstall" ]; then
    echo "  остановить/disable: $SERVICE_NAME"
    echo "  удалить unit:       $UNIT_FILE"
    echo "  удалить каталоги:   $OPT_DIR, $ENV_DIR"
    if [ "$PURGE_DATA" = "1" ]; then
      echo "  удалить данные:     $DATA_DIR"
    else
      echo "  данные сохранить:   $DB_PATH"
    fi
    return 0
  fi
  local node_state="Node.js не найден — будет установлен $NODE_VERSION из tarball nodejs.org в $NODE_PREFIX"
  if node_version_ok; then
    node_state="$(node -v) — уже подходит (шаг пропускается)"
  elif command -v node >/dev/null 2>&1; then
    node_state="$(node -v) — будет заменён на v$NODE_VERSION (tarball nodejs.org, $NODE_PREFIX)"
  fi
  local release_state="будет создан"
  if [ -f "$RELEASE/server/main.mjs" ]; then
    release_state="будет переиспользован"
  fi
  echo "  tarball:            $TARBALL"
  echo "  релиз:              $RELEASE ($release_state)"
  echo "  current:            $CURRENT_LINK"
  echo "  пользователь:       $ENOT_USER (system, nologin)"
  echo "  БД:                 $DB_PATH"
  echo "  артефакты:          $DIST_DIR"
  echo "  env-файл:           $ENV_FILE (0600)"
  echo "  unit:               $UNIT_FILE (Restart=on-failure, EnvironmentFile)"
  echo "  bind/port:          $BIND:$PORT"
  echo "  публичный URL:      $PUBLIC_URL"
  if [ "$SETUP_TURN" = "1" ]; then
    if [ -f "$TURN_CONF" ] && grep -q ENOTDESK_MANAGED "$TURN_CONF"; then
      echo "  TURN (coturn):      уже настроен — обновление только env-файла (без apt и рестарта)"
    elif [ -n "$TURN_URLS" ]; then
      echo "  TURN (coturn):      пропущен — в env уже есть ENOT_TURN_URLS (внешний TURN; перенастроить: --reset-turn)"
    else
      echo "  TURN (coturn):      поставить apt-пакет; realm $REALM; static-auth-secret — в env-файл (0600)"
      echo "                      порты: 3478 tcp/udp, relay 49160–49200/udp"
    fi
  else
    echo "  TURN (coturn):      пропущен (--no-turn)"
  fi
  if [ "$SETUP_TLS" = "0" ]; then
    echo "  TLS (Caddy):        пропущен (--no-tls) — локальный http-режим"
  elif [ "$TLS_ACTIVE" = "1" ]; then
    echo "  TLS (Caddy):        поставить apt-пакет (официальный репозиторий); $DOMAIN → reverse_proxy 127.0.0.1:$PORT, авто-HTTPS"
  else
    echo "  TLS (Caddy):        пропущен — в ENOT_PUBLIC_URL нет домена; локальный http-режим (незащищённый)"
  fi
  echo "  Node.js:            $node_state"
  echo "  health-poll:        http://127.0.0.1:$PORT/api/v1/health (до 30 с)"
  if [ "$OPEN_FIREWALL" = "1" ]; then
    local fw_ports=""
    if [ "$TLS_ACTIVE" = "1" ]; then fw_ports="80,443/tcp, 443/udp (HTTP/3)"; else fw_ports="$PORT/tcp"; fi
    if [ "$SETUP_TURN" = "1" ]; then fw_ports="$fw_ports, 3478 tcp/udp, 49160:49200/udp"; fi
    echo "  ufw:                открыть $fw_ports, если ufw активен"
  else
    echo "  ufw:                не трогать"
  fi
}

if [ "$MODE" = "backup" ]; then
  [ "$(id -u)" = "0" ] || die "--backup нужен root — запустите через sudo"
  [ -f "$CURRENT_LINK/server/backup.mjs" ] || die "сервер не установлен ($CURRENT_LINK/server/backup.mjs отсутствует) — сначала установите его"
  NODE_BIN="$NODE_PREFIX/bin/node"
  [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "Node.js не найден ($NODE_PREFIX/bin/node)"
  [ -r "$DB_PATH" ] || die "БД не найдена или не читается: $DB_PATH"
  BACKUP_DIR="$DATA_DIR/backups"
  info "бэкап БД $DB_PATH → $BACKUP_DIR (ретенция ${BACKUP_KEEP:-10})"
  mkdir -p "$BACKUP_DIR"
  # P2-19: дампы содержат пользовательские данные — каталог только для владельца.
  chmod 0700 "$BACKUP_DIR"
  chown "$ENOT_USER:$ENOT_USER" "$BACKUP_DIR"
  if id "$ENOT_USER" >/dev/null 2>&1; then
    runuser -u "$ENOT_USER" -- "$NODE_BIN" "$CURRENT_LINK/server/backup.mjs" "$DB_PATH" "$BACKUP_DIR" "${BACKUP_KEEP:-10}" || die "бэкап не удался"
  else
    "$NODE_BIN" "$CURRENT_LINK/server/backup.mjs" "$DB_PATH" "$BACKUP_DIR" "${BACKUP_KEEP:-10}" || die "бэкап не удался"
  fi
  info "расписание: см. docs/SERVER.md, раздел «Бэкап» (cron: sudo bash $0 --backup)"
  exit 0
fi

# --dry-run только показывает план и ничего не меняет — root/Debian для него не требуются.
if [ "$DRY_RUN" != "1" ]; then
  preflight
fi

if [ "$MODE" = "uninstall" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    print_plan
    exit 0
  fi
  info "останавливаю и удаляю сервис $SERVICE_NAME"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  rm -rf "$OPT_DIR" "$ENV_DIR"
  if [ "$PURGE_DATA" = "1" ]; then
    rm -rf "$DATA_DIR"
    info "данные удалены: $DATA_DIR"
  else
    info "unit и релизы удалены; БД сохранена: $DB_PATH"
    info "удалить и данные: sudo bash $0 --uninstall --purge-data"
  fi
  exit 0
fi

merge_env_file

check_tarball
check_port

HASH="$(hash_file "$TARBALL")"
find_or_name_release "$HASH"

if [ "$DRY_RUN" = "1" ]; then
  [ -n "$PUBLIC_URL" ] || resolve_public_url
  derive_edge
  print_plan
  exit 0
fi

info "устанавливаю EnotDesk ($MODE)"
ensure_node
NODE_BIN="$(command -v node)"

if ! id -u "$ENOT_USER" >/dev/null 2>&1; then
  info "создаю системного пользователя $ENOT_USER"
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --shell "$NOLOGIN" --home-dir "$DATA_DIR" --no-create-home "$ENOT_USER"
else
  info "пользователь $ENOT_USER уже существует"
fi

install -d -m 0755 "$OPT_DIR" "$RELEASES_DIR" "$ENV_DIR"
install -d -m 0750 "$DATA_DIR"
mkdir -p "$DIST_DIR"
chown "$ENOT_USER:$ENOT_USER" "$OPT_DIR" "$RELEASES_DIR" "$DATA_DIR"
chown "$ENOT_USER:$ENOT_USER" "$DIST_DIR"

if [ -f "$RELEASE/server/main.mjs" ]; then
  info "релиз уже распакован: $RELEASE"
else
  info "распаковываю релиз: $RELEASE"
  rm -rf "$RELEASE"
  install -d -m 0755 "$RELEASE"
  tar -xzf "$TARBALL" -C "$RELEASE"
fi

if [ ! -d "$RELEASE/node_modules" ]; then
  info "ставлю production-зависимости (npm ci --omit=dev)"
  ( cd "$RELEASE" && npm ci --omit=dev --no-audit --no-fund )
fi
chown -R "$ENOT_USER:$ENOT_USER" "$RELEASE"

rm -f "$CURRENT_LINK.tmp"
ln -s "$RELEASE" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
info "current -> $RELEASE"

[ -n "$PUBLIC_URL" ] || resolve_public_url
derive_edge

if [ "$TLS_ACTIVE" = "1" ]; then
  if [ "$BIND" != "127.0.0.1" ]; then
    info "TLS включён: сервер привязывается к 127.0.0.1:$PORT, наружу — только Caddy (80/443)"
    BIND="127.0.0.1"
  fi
  if [ "$PUBLIC_URL" != "https://$DOMAIN" ]; then
    info "публичный URL: https://$DOMAIN"
    PUBLIC_URL="https://$DOMAIN"
  fi
  ensure_caddy
elif [ "$SETUP_TLS" = "1" ]; then
  info "ВНИМАНИЕ: в ENOT_PUBLIC_URL нет домена — TLS не настроен, работает локальный http-режим"
  info "  пароли, токены и сигналинг идут по сети открытым текстом; для продакшена задайте"
  info "  ENOT_PUBLIC_URL=https://<домен> (A-запись на этот сервер) и перезапустите установщик"
fi

if [ "$SETUP_TURN" = "1" ]; then
  setup_turn
fi

info "пишу env-файл $ENV_FILE (0600)"
install -m 0600 /dev/null "$ENV_FILE"
{
  env_kv ENOT_HOST "$BIND"
  env_kv ENOT_PORT "$PORT"
  env_kv ENOT_DB "$DB_PATH"
  env_kv ENOT_DIST_DIR "$DIST_DIR"
  env_kv ENOT_PUBLIC_URL "$PUBLIC_URL"
  if [ -n "$TURN_SECRET" ]; then env_kv ENOT_TURN_SECRET "$TURN_SECRET"; fi
  if [ -n "$TURN_URLS" ]; then env_kv ENOT_TURN_URLS "$TURN_URLS"; fi
  if [ -n "$TURN_USERNAME" ]; then env_kv ENOT_TURN_USERNAME "$TURN_USERNAME"; fi
  if [ -n "$TURN_PASSWORD" ]; then env_kv ENOT_TURN_PASSWORD "$TURN_PASSWORD"; fi
  if [ -n "$GRACE_MS" ]; then env_kv ENOT_GRACE_MS "$GRACE_MS"; fi
  if [ -n "$RETENTION_DAYS" ]; then env_kv ENOT_RETENTION_DAYS "$RETENTION_DAYS"; fi
  if [ -n "$MAX_SESSIONS" ]; then env_kv ENOT_MAX_SESSIONS "$MAX_SESSIONS"; fi
} | tee "$ENV_FILE" >/dev/null
chmod 0600 "$ENV_FILE"

info "пишу unit $UNIT_FILE"
install -m 0644 /dev/null "$UNIT_FILE"
tee "$UNIT_FILE" >/dev/null <<EOF
[Unit]
Description=EnotDesk — remote support server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$ENOT_USER
Group=$ENOT_USER
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $CURRENT_LINK/server/main.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
# Если ENOT_DB или ENOT_DIST_DIR вынесены за $DATA_DIR — добавьте эти пути в ReadWritePaths.
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

info "включаю и запускаю сервис"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

if [ "$OPEN_FIREWALL" = "1" ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    if [ "$TLS_ACTIVE" = "1" ]; then
      ufw allow 80/tcp >/dev/null
      ufw allow 443/tcp >/dev/null
      ufw allow 443/udp >/dev/null
      info "ufw: открыты 80/tcp и 443/tcp+udp (Caddy, HTTP/3); порт $PORT отвечает только на 127.0.0.1"
    else
      ufw allow "$PORT/tcp" >/dev/null
      info "ufw: порт $PORT/tcp открыт"
    fi
    if [ "$SETUP_TURN" = "1" ]; then
      ufw allow 3478/tcp >/dev/null
      ufw allow 3478/udp >/dev/null
      ufw allow 49160:49200/udp >/dev/null
      info "ufw: открыты 3478 tcp/udp и 49160:49200/udp (TURN)"
    fi
  else
    info "ufw не установлен или неактивен — правила не добавлены; откройте порты вручную (см. docs/SERVER.md)"
  fi
fi

HEALTH_URL="http://127.0.0.1:$PORT/api/v1/health"
info "проверяю health: $HEALTH_URL"
healthy=0
deadline=$((SECONDS + 30))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl -fsS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" != "1" ]; then
  echo "--- последние строки журнала $SERVICE_NAME ---" >&2
  journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
  die "сервис не ответил на health за 30 секунд"
fi
info "health: ok"

if [ "$SETUP_TURN" = "1" ]; then
  TURN_SUMMARY="coturn, realm $REALM (3478 tcp/udp, relay 49160–49200/udp), секрет в $ENV_FILE"
else
  TURN_SUMMARY="пропущен (--no-turn)"
fi
if [ "$TLS_ACTIVE" = "1" ]; then
  TLS_SUMMARY="Caddy, https://$DOMAIN → 127.0.0.1:$PORT"
else
  TLS_SUMMARY="локальный http-режим без TLS — ВНИМАНИЕ: пароли, токены и сигналинг идут по сети открытым текстом"
fi

cat <<EOF

Установка завершена.
  релиз:     $RELEASE
  current:   $CURRENT_LINK -> $RELEASE
  сервис:    systemctl status $SERVICE_NAME (enabled, Restart=on-failure)
  health:    $PUBLIC_URL/api/v1/health
  БД:        $DB_PATH (вне релизов, переживает обновление и --uninstall)
  env:       $ENV_FILE (0600)
  TURN:      $TURN_SUMMARY
  TLS:       $TLS_SUMMARY

Первый администратор (интерактивно):
  sudo -u $ENOT_USER env ENOT_DB=$DB_PATH $NODE_BIN $CURRENT_LINK/server/main.mjs bootstrap
EOF

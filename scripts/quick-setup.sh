#!/usr/bin/env bash
# EnotDesk — однокомандный мастер установки сервера (bare-metal systemd или docker).
#
# Однострочник:
#   curl -fsSL https://raw.githubusercontent.com/Flint-sega/enotdesk/main/scripts/quick-setup.sh | sudo bash
#
# Использование:
#   quick-setup.sh [опции]
#
# Опции:
#   --docker                 стек compose (сервер + coturn + caddy) в ./enotdesk-docker
#                            вместо bare-metal (по умолчанию)
#   --tarball <path>         локальный tarball enotdesk-server.tar.gz вместо скачивания
#                            (в режиме --docker игнорируется)
#   --update                 обновление: значения по умолчанию берутся из существующей
#                            установки (/etc/enotdesk/enotdesk.env); секреты сохраняются
#   --dry-run                показать план и выйти, ничего не делая (без root и docker)
#   --domain <d>             домен (пусто/без точки = HTTP по IP, незащищённый режим)
#   --admin-login <l>        логин первого администратора (по умолчанию admin)
#   --admin-name <n>         отображаемое имя администратора
#   --port <p>               порт сервера, 1-65535 (по умолчанию 8080; в --docker фиксирован)
#   --no-firewall            не предлагать и не открывать ufw
#   --admin-password-stdin   пароль администратора — одной строкой из stdin (не argv);
#                            ВСЕ остальные значения задаются флагами (недостающее —
#                            честный отказ: stdin занят паролем, вопросы не задаются)
#   --help                   эта справка (ru/en по $LANG)
#
# Оверрайды источника:
#   ENOT_SETUP_REPO     репозиторий GitHub (по умолчанию Flint-sega/enotdesk)
#   ENOT_SETUP_VERSION  тег релиза или latest (по умолчанию latest)
#
# Безопасность: секреты (TURN, ENOT_SECRET_KEY) генерируются локально и уходят
# установщику только окружением процесса (env-файл 0600 — тот же паттерн, что в
# scripts/deploy-server.sh), пароль администратора — stdin-пайпом bootstrap'у.
# В argv, echo и логи секреты не попадают; автоген-пароль печатается в финале один раз.
set -euo pipefail

REPO="${ENOT_SETUP_REPO:-Flint-sega/enotdesk}"
VERSION="${ENOT_SETUP_VERSION:-latest}"

MODE="baremetal"          # baremetal | docker
UPDATE=0
DRY_RUN=0
TARBALL=""
DOMAIN=""
DOMAIN_SET=0              # флаг --domain задан (пустое значение = «домена нет»)
ADMIN_LOGIN=""
ADMIN_NAME=""
PORT=""
FIREWALL=0
FIREWALL_SET=0
PASS_STDIN=0

SETUP_TMP=""
DOCKER_DIR=""

die() { echo "ОШИБКА: $*" >&2; exit 1; }
info() { echo "==> $*" >&2; }
warn() { echo "ВНИМАНИЕ: $*" >&2; }

# Язык вопросов и итога: ru по $LANG=ru*, иначе en. Пары строк в вызовах M/Mp.
LOCALE=en
case "${LANG:-}" in ru*) LOCALE=ru ;; esac
M()  { if [ "$LOCALE" = ru ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
# Промпт без перевода строки — в stderr (stdout остаётся для плана/итога).
prompt_out() { printf '%s' "$1" >&2; }

cleanup() {
  if [ -n "$SETUP_TMP" ] && [ -d "$SETUP_TMP" ]; then
    rm -rf "$SETUP_TMP"
  fi
}
trap cleanup EXIT

usage() {
  if [ "$LOCALE" = ru ]; then
    cat <<EOF
EnotDesk — мастер установки сервера одной командой.

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash

Режимы:
  (по умолчанию)        bare-metal: systemd-сервис (Ubuntu/Debian; ставит Node, coturn, Caddy)
  --docker              стек compose (сервер + coturn + caddy) в ./enotdesk-docker
  --tarball <path>      локальный tarball вместо скачивания с GitHub Releases
  --update              обновление существующей установки (умолчания — из её env-файла)
  --dry-run             показать план, ничего не меняя (root и docker не нужны)

Флаги неинтерактивного режима (что не задано — спросится в TTY):
  --domain <d>             домен (пусто = HTTP по IP — незащищённо; без точки доменом не считается)
  --admin-login <l>        логин первого администратора (по умолчанию admin, от 3 символов)
  --admin-name <n>         отображаемое имя администратора
  --port <p>               порт сервера 1-65535 (по умолчанию 8080; в --docker фиксирован compose)
  --no-firewall            не открывать ufw
  --admin-password-stdin   пароль админа одной строкой из stdin (≥8 симв.; никогда не argv);
                           все остальные значения — только флагами (недостающее = отказ)

Источник: ENOT_SETUP_REPO (Flint-sega/enotdesk), ENOT_SETUP_VERSION (latest).

Пароль администратора: пустой ввод = автогенерация 20 символов (покажется один раз в финале).
Секреты TURN и ENOT_SECRET_KEY генерируются автоматически и в открытом виде не показываются.
EOF
  else
    cat <<EOF
EnotDesk — one-command server setup wizard.

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash

Modes:
  (default)             bare metal: systemd service (Ubuntu/Debian; installs Node, coturn, Caddy)
  --docker              compose stack (server + coturn + caddy) in ./enotdesk-docker
  --tarball <path>      local tarball instead of downloading from GitHub Releases
  --update              upgrade an existing installation (defaults from its env file)
  --dry-run             print the plan and exit, changing nothing (no root or docker needed)

Non-interactive flags (anything missing is asked in a TTY):
  --domain <d>             domain (empty = plain HTTP by IP — insecure; no dot means "no domain")
  --admin-login <l>        first admin login (default admin, 3+ chars)
  --admin-name <n>         admin display name
  --port <p>               server port 1-65535 (default 8080; fixed by compose in --docker)
  --no-firewall            do not open ufw
  --admin-password-stdin   admin password as a single stdin line (8+ chars; never argv);
                           every other value must come from flags (missing one = refusal)

Source overrides: ENOT_SETUP_REPO (Flint-sega/enotdesk), ENOT_SETUP_VERSION (latest).

Admin password: empty input = 20-char autogeneration (printed once at the end).
TURN and ENOT_SECRET_KEY secrets are generated automatically and never shown in plaintext.
EOF
  fi
}

# ── Разбор аргументов (оригиналы сохраняем для self-exec через sudo) ─────────
ORIG_ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --docker) MODE="docker" ;;
    --tarball)
      shift; [ $# -gt 0 ] || die "--tarball требует путь к файлу"
      TARBALL="$1" ;;
    --update) UPDATE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --domain)
      shift; [ $# -gt 0 ] || die "--domain требует значение"
      DOMAIN="$1"; DOMAIN_SET=1 ;;
    --admin-login)
      shift; [ $# -gt 0 ] || die "--admin-login требует значение"
      ADMIN_LOGIN="$1" ;;
    --admin-name)
      shift; [ $# -gt 0 ] || die "--admin-name требует значение"
      ADMIN_NAME="$1" ;;
    --port)
      shift; [ $# -gt 0 ] || die "--port требует значение"
      PORT="$1" ;;
    --no-firewall) FIREWALL=0; FIREWALL_SET=1 ;;
    --admin-password-stdin) PASS_STDIN=1 ;;
    -*) die "неизвестный аргумент: $1 (справка: --help)" ;;
    *) die "лишний аргумент: $1 (справка: --help)" ;;
  esac
  shift
done

# Оверрайды источника: формат строго ограничен (значения попадают в URL).
case "$REPO" in ''|-*|*[!A-Za-z0-9._/-]*) die "ENOT_SETUP_REPO не похож на owner/repo: '$REPO'" ;; esac
case "$VERSION" in ''|-*|*[!A-Za-z0-9._-]*) die "ENOT_SETUP_VERSION не похож на тег или latest: '$VERSION'" ;; esac

if [ "$MODE" = "docker" ] && [ -n "$TARBALL" ]; then
  warn "в режиме --docker флаг --tarball игнорируется (образ собирается из Dockerfile)"
  TARBALL=""
fi
if [ "$MODE" = "docker" ] && [ -n "$PORT" ]; then
  warn "$(M "в режиме --docker флаг --port игнорируется (порты фиксирует compose: 127.0.0.1:8080 + 80/443)" "in --docker mode the --port flag is ignored (compose fixes the ports: 127.0.0.1:8080 + 80/443)")"
  PORT=""
fi
if [ -n "$TARBALL" ] && [ ! -f "$TARBALL" ]; then
  die "$(M "tarball не найден: $TARBALL" "tarball not found: $TARBALL")"
fi

# ── Ввод: TTY / пайп ответов / /dev/tty (curl|bash) ──────────────────────────
# tty    — скрипт запущен из файла, stdin — терминал: читаем stdin (пароль read -s);
# pipe   — stdin не терминал, но скрипт — файл: ответы приходят построчно в stdin (CI);
# ttyfd  — stdin занят самим скриптом (curl | bash): вопросы/ответы идут через /dev/tty.
ANSWER_SRC=""
PIPE_EOF=0
if [ -t 0 ]; then
  ANSWER_SRC="tty"
elif [ -f "$0" ] && [ -r "$0" ]; then
  ANSWER_SRC="pipe"
else
  ANSWER_SRC="ttyfd"
fi

# Читает одну строку в ANSWER; PIPE_EOF=1, если ввод кончился.
no_tty_die() {
  die "$(M "нужен интерактивный ввод, а /dev/tty недоступен. Скачайте скрипт и запустите из файла:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh -o quick-setup.sh
  sudo bash quick-setup.sh" "interactive input is required but /dev/tty is unavailable. Download the script and run it from a file:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh -o quick-setup.sh
  sudo bash quick-setup.sh")"
}

read_answer() {
  ANSWER=""
  PIPE_EOF=0
  case "$ANSWER_SRC" in
    tty|pipe)
      IFS= read -r ANSWER || { [ -n "$ANSWER" ] || PIPE_EOF=1; }
      ;;
    ttyfd)
      # /dev/tty может существовать, но не открываться (нет управляющего терминала) —
      # проверяем именно открытие, а не существование узла.
      if ! exec 3</dev/tty 2>/dev/null; then
        no_tty_die
      fi
      IFS= read -r ANSWER <&3 || { [ -n "$ANSWER" ] || PIPE_EOF=1; }
      exec 3<&-
      ;;
  esac
}

# Вопрос с умолчанием: пустой ответ → $2. Промпт — в stderr (stdout остаётся для плана/итога).
ask() { # $1=текст вопроса, $2=умолчание
  prompt_out "$1"
  read_answer
  if [ "$PIPE_EOF" = "1" ]; then
    die "$(M "ввод закончился раньше ответов — дозаполните флагами или ответьте на все вопросы" "input ended before all answers — supply the rest via flags or answer every question")"
  fi
  if [ -n "${2:-}" ] && [ -z "$ANSWER" ]; then
    ANSWER="$2"
  fi
}

# Скрытый ввод (пароль): read -s в TTY, обычное чтение в пайпе.
ask_secret() { # $1=текст вопроса
  prompt_out "$1"
  case "$ANSWER_SRC" in
    tty)
      read -rs ANSWER || ANSWER=""
      ;;
    pipe)
      IFS= read -r ANSWER || { [ -n "$ANSWER" ] || PIPE_EOF=1; }
      ;;
    ttyfd)
      if ! exec 3</dev/tty 2>/dev/null; then
        no_tty_die
      fi
      read -rs ANSWER <&3 || ANSWER=""
      exec 3<&-
      ;;
  esac
  printf '\n' >&2
}

# ── Проверки значений ─────────────────────────────────────────────────────────
# Тот же класс символов, что valid_host в scripts/install-server.sh (P2-15):
# ^[A-Za-z0-9.-]+$ — всё прочее честно отклоняется до интерполяции в конфиги.
valid_host() {
  case "$1" in
    ''|*[!A-Za-z0-9.-]*) return 1 ;;
  esac
  return 0
}

valid_login() { case "$1" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac; [ "${#1}" -ge 3 ]; }
valid_port()  { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

# Имя уходит stdin-пайпом bootstrap'у построчно: управляющие символы (в т.ч. \n)
# сдвинули бы строки пайпа (пароль прочитался бы не то). Пробелы разрешены,
# пустое после трима — нет (bootstrap его всё равно отверг бы).
valid_name() {
  local clean
  clean="$(printf '%s' "$1" | tr -d '[:cntrl:]')"
  if [ "$clean" != "$1" ]; then return 1; fi
  [ -n "$(printf '%s' "$1" | tr -d '[:space:]')" ]
}

# Значение KEY из env-файла (значения пишутся в одинарных кавычках — env_kv
# install-server.sh; читаются и старые незакавыченные файлы). Это устойчивый
# вариант конвейера grep ^KEY= | cut -d= -f2- | tr -d "'\"" для значений с кавычками.
env_value() { # $1=KEY $2=file
  local v=""
  [ -r "$2" ] || { printf ''; return 0; }
  v="$(sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n 1 || true)"
  case "$v" in
    \'*\')
      v="${v#\'}"; v="${v%\'}"
      v="$(printf '%s' "$v" | sed "s/'\\\\''/'/g")"
      ;;
  esac
  printf '%s' "$v"
}

# Случайные байты в hex: openssl → фолбэк /dev/urandom|od.
rand_hex() { # $1=байты
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1" 2>/dev/null && return 0
  fi
  head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Пароль администратора: 20 символов A-Za-z0-9 (openssl → фолбэк /dev/urandom|tr).
rand_password() {
  local p=""
  if command -v openssl >/dev/null 2>&1; then
    p="$(openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 20 || true)"
  fi
  if [ "${#p}" -lt 20 ]; then
    p="$(head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 20 || true)"
  fi
  [ "${#p}" -ge 20 ] || die "$(M "не удалось сгенерировать пароль (нет openssl и /dev/urandom)" "could not generate a password (no openssl and no /dev/urandom)")"
  printf '%s' "$p"
}

# Первый адрес хоста (как resolve_public_url в install-server.sh).
detect_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$ip" ]; then
    ip="$(hostname 2>/dev/null || true)"
  fi
  [ -n "$ip" ] || ip="127.0.0.1"
  printf '%s' "$ip"
}

# Существующая bare-metal установка (systemd-юнит, symlink current или env-файл).
detect_existing_install() {
  if command -v systemctl >/dev/null 2>&1 && systemctl cat enotdesk >/dev/null 2>&1; then
    return 0
  fi
  if [ -d /opt/enotdesk/current ]; then return 0; fi
  if [ -f /etc/enotdesk/enotdesk.env ]; then return 0; fi
  return 1
}

# ── Preflight ────────────────────────────────────────────────────────────────
# Root: сам проверяем только sudo; Debian/Ubuntu+systemd делегируем install-server.sh.
require_root() {
  if [ "$(id -u)" = "0" ]; then
    return 0
  fi
  if [ -f "$0" ] && [ -r "$0" ] && command -v sudo >/dev/null 2>&1; then
    info "$(M "нужны права root — перезапускаю себя через sudo -E" "root is required — re-running myself via sudo -E")"
    exec sudo -E bash "$0" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  fi
  die "$(M "нужны права root. Запустите через sudo, например:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash" "root is required. Run via sudo, for example:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash")"
}

preflight_baremetal() {
  require_root
  command -v curl >/dev/null 2>&1 || die "$(M "не найден curl — он нужен для скачивания релиза (пакет curl)" "curl not found — it is needed to download the release (package curl)")"
  if [ "$UPDATE" = "1" ]; then
    if ! detect_existing_install; then
      die "$(M "--update: существующая установка не найдена (нет systemd-юнита enotdesk, /opt/enotdesk/current или /etc/enotdesk/enotdesk.env) — запустите без --update" "--update: no existing installation found (no enotdesk systemd unit, /opt/enotdesk/current or /etc/enotdesk/enotdesk.env) — run without --update")"
    fi
  else
    if detect_existing_install; then
      die "$(M "EnotDesk уже установлен на этом хосте. Для обновления запустите с --update:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash -s -- --update" "EnotDesk is already installed on this host. To upgrade, run with --update:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash -s -- --update")"
    fi
  fi
}

preflight_docker() {
  command -v docker >/dev/null 2>&1 || die "$(M "не найден docker — установите Docker с плагином compose (docker compose version)" "docker not found — install Docker with the compose plugin (docker compose version)")"
  if ! docker compose version >/dev/null 2>&1; then
    die "$(M "docker compose (v2) не найден — нужен плагин compose: docker compose version" "docker compose (v2) not found — the compose plugin is required: docker compose version")"
  fi
  if [ "$UPDATE" = "1" ]; then
    if [ ! -f "./enotdesk-docker/.env" ]; then
      die "$(M "--update: ./enotdesk-docker/.env не найден — в этом каталоге нет стека; запустите без --update" "--update: ./enotdesk-docker/.env not found — no stack in this directory; run without --update")"
    fi
  else
    if [ -e "./enotdesk-docker" ]; then
      die "$(M "каталог ./enotdesk-docker уже существует. Для обновления запустите с --update (или удалите каталог)" "./enotdesk-docker already exists. To upgrade run with --update (or remove the directory)")"
    fi
  fi
}

# ── Вопросы ──────────────────────────────────────────────────────────────────
collect_answers() {
  local env_file="/etc/enotdesk/enotdesk.env"
  local def_domain="" def_port="8080"

  # --admin-password-stdin: stdin занят паролем — вопросы не задаются, ВСЕ
  # остальные значения обязаны прийти флагами. Недостающее — отказ ДО чтения
  # stdin (иначе пароль был бы проглочен вопросом и утёк в план/die-сообщение).
  if [ "$PASS_STDIN" = "1" ]; then
    local missing=""
    if [ "$DOMAIN_SET" = "0" ]; then missing="$missing --domain"; fi
    if [ -z "$ADMIN_LOGIN" ]; then missing="$missing --admin-login"; fi
    if [ -z "$ADMIN_NAME" ]; then missing="$missing --admin-name"; fi
    if [ "$MODE" = "baremetal" ]; then
      if [ -z "$PORT" ]; then missing="$missing --port"; fi
      if [ "$FIREWALL_SET" = "0" ]; then missing="$missing --no-firewall"; fi
    fi
    if [ -n "$missing" ]; then
      die "$(M "--admin-password-stdin: stdin занят паролем, вопросы не задаются — задайте недостающее флагами:$missing" "--admin-password-stdin: stdin carries the password, so no questions are asked — supply the missing values via flags:$missing")"
    fi
  fi

  if [ "$UPDATE" = "1" ]; then
    # --update: умолчания из существующей установки (порт/URL/прокси); секреты не показываем.
    if [ "$MODE" = "baremetal" ] && [ -r "$env_file" ]; then
      def_port="$(env_value ENOT_PORT "$env_file")"
      [ -n "$def_port" ] || def_port="8080"
      def_domain="$(env_value ENOT_PUBLIC_URL "$env_file")"
      def_domain="${def_domain#*://}"; def_domain="${def_domain%%/*}"; def_domain="${def_domain%%:*}"
      case "$def_domain" in
        ''|localhost|*.local) def_domain="" ;;
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) def_domain="" ;;
        *.*) ;;
        *) def_domain="" ;;
      esac
    elif [ "$MODE" = "docker" ] && [ -f "./enotdesk-docker/.env" ]; then
      def_domain="$(env_value DOMAIN ./enotdesk-docker/.env)"
    fi
  fi

  # 1. Домен
  if [ "$DOMAIN_SET" = "1" ]; then
    if [ -n "$DOMAIN" ]; then
      valid_host "$DOMAIN" || die "--domain: недопустимые символы в '$DOMAIN' (разрешены буквы, цифры, точка, дефис)"
    fi
  else
    while :; do
      if [ "$LOCALE" = ru ]; then
        ask "Домен (пусто = HTTP по IP, незащищённо)${def_domain:+ [$def_domain]}: " "$def_domain"
      else
        ask "Domain (empty = plain HTTP by IP, insecure)${def_domain:+ [$def_domain]}: " "$def_domain"
      fi
      if [ -z "$ANSWER" ]; then DOMAIN=""; break; fi
      if ! valid_host "$ANSWER"; then
        if [ "$ANSWER_SRC" = "pipe" ]; then
          die "$(M "домен: недопустимые символы в '$ANSWER' (разрешены буквы, цифры, точка, дефис)" "domain: unsupported characters in '$ANSWER' (letters, digits, dot, dash only)")"
        fi
        warn "$(M "'$ANSWER' содержит недопустимые символы (разрешены буквы, цифры, точка, дефис)" "'$ANSWER' has unsupported characters (letters, digits, dot, dash only)")"
        continue
      fi
      case "$ANSWER" in
        *.*) DOMAIN="$ANSWER"; break ;;
        *)
          warn "$(M "'$ANSWER' без точки доменом не считаю — будет HTTP-режим" "'$ANSWER' has no dot — treating it as no domain (HTTP mode)")"
          DOMAIN=""
          break
          ;;
      esac
    done
  fi

  # 2. Логин администратора
  if [ -n "$ADMIN_LOGIN" ]; then
    valid_login "$ADMIN_LOGIN" || die "--admin-login: от 3 символов, буквы/цифры/._- (получено: '$ADMIN_LOGIN')"
  else
    while :; do
      if [ "$LOCALE" = ru ]; then
        ask "Логин администратора [admin]: " "admin"
      else
        ask "Admin login [admin]: " "admin"
      fi
      if valid_login "$ANSWER"; then ADMIN_LOGIN="$ANSWER"; break; fi
      if [ "$ANSWER_SRC" = "pipe" ]; then
        die "$(M "логин администратора: от 3 символов (буквы, цифры, . _ -), получено: '$ANSWER'" "admin login: 3+ chars (letters, digits, . _ -), got: '$ANSWER'")"
      fi
      warn "$(M "логин от 3 символов (буквы, цифры, . _ -)" "login needs 3+ chars (letters, digits, . _ -)")"
    done
  fi

  # 3. Имя (по умолчанию = логин; управляющие символы отвергаются — пайп bootstrap'а)
  if [ -n "$ADMIN_NAME" ]; then
    if ! valid_name "$ADMIN_NAME"; then
      die "--admin-name: имя пустое после трима или содержит управляющие символы (в т.ч. перевод строки)"
    fi
  else
    while :; do
      if [ "$LOCALE" = ru ]; then
        ask "Имя администратора (отображаемое) [$ADMIN_LOGIN]: " "$ADMIN_LOGIN"
      else
        ask "Admin display name [$ADMIN_LOGIN]: " "$ADMIN_LOGIN"
      fi
      if [ -n "$ANSWER" ] && valid_name "$ANSWER"; then ADMIN_NAME="$ANSWER"; break; fi
      if [ "$ANSWER_SRC" = "pipe" ]; then
        die "$(M "имя администратора не может быть пустым или содержать управляющие символы" "admin display name cannot be empty or contain control characters")"
      fi
      warn "$(M "имя не может быть пустым или содержать управляющие символы" "name cannot be empty or contain control characters")"
    done
  fi

  # 4. Пароль: пустой ввод = автогенерация; иначе ≥8 и повтор
  PASS_AUTO=0
  ADMIN_PASSWORD=""
  if [ "$PASS_STDIN" = "1" ]; then
    # Пароль одной строкой из stdin (CI). В режиме curl|bash stdin занят самим скриптом.
    if [ "$ANSWER_SRC" = "ttyfd" ]; then
      die "$(M "--admin-password-stdin: stdin занят самим скриптом (curl|bash). Скачайте скрипт и запустите из файла" "--admin-password-stdin: stdin is the piped script itself (curl|bash). Download the script and run it from a file")"
    fi
    IFS= read -r ADMIN_PASSWORD || ADMIN_PASSWORD=""
    [ -n "$ADMIN_PASSWORD" ] || die "--admin-password-stdin: пустая строка вместо пароля"
    [ "${#ADMIN_PASSWORD}" -ge 8 ] || die "--admin-password-stdin: пароль от 8 символов"
  else
    while :; do
      if [ "$LOCALE" = ru ]; then
        ask_secret "Пароль администратора (≥8 симв.; пустой ввод = автогенерация): "
      else
        ask_secret "Admin password (8+ chars; empty = autogenerate): "
      fi
      if [ "$PIPE_EOF" = "1" ]; then
        die "$(M "ввод закончился на пароле" "input ended at the password")"
      fi
      if [ -z "$ANSWER" ]; then
        ADMIN_PASSWORD="$(rand_password)"
        PASS_AUTO=1
        break
      fi
      if [ "${#ANSWER}" -lt 8 ]; then
        if [ "$ANSWER_SRC" = "pipe" ]; then
          die "$(M "пароль от 8 символов" "password needs 8+ characters")"
        fi
        warn "$(M "пароль от 8 символов" "password needs 8+ characters")"
        continue
      fi
      ADMIN_PASSWORD="$ANSWER"
      if [ "$LOCALE" = ru ]; then
        ask_secret "Повторите пароль: "
      else
        ask_secret "Repeat the password: "
      fi
      if [ "$ANSWER" = "$ADMIN_PASSWORD" ]; then break; fi
      if [ "$ANSWER_SRC" = "pipe" ]; then
        die "$(M "пароли не совпадают" "passwords do not match")"
      fi
      warn "$(M "пароли не совпадают — попробуйте ещё раз" "passwords do not match — try again")"
    done
  fi

  # 5. Порт (только bare-metal; в docker фиксирован compose)
  if [ "$MODE" = "baremetal" ]; then
    if [ -n "$PORT" ]; then
      valid_port "$PORT" || die "--port: число 1-65535 (получено: '$PORT')"
    else
      while :; do
        if [ "$LOCALE" = ru ]; then
          ask "Порт сервера [$def_port]: " "$def_port"
        else
          ask "Server port [$def_port]: " "$def_port"
        fi
        if valid_port "$ANSWER"; then PORT="$ANSWER"; break; fi
        if [ "$ANSWER_SRC" = "pipe" ]; then
          die "$(M "порт: число 1-65535, получено: '$ANSWER'" "port: number 1-65535, got: '$ANSWER'")"
        fi
        warn "$(M "порт: число 1-65535" "port: number 1-65535")"
      done
    fi
  fi

  # 6. Firewall (только bare-metal; --no-firewall фиксирует «нет»)
  if [ "$MODE" = "baremetal" ] && [ "$FIREWALL_SET" = "0" ]; then
    prompt_out "$(M "Открыть порт в ufw? [y/N]: " "Open the port in ufw? [y/N]: ")"
    read_answer
    if [ "$PIPE_EOF" = "1" ]; then
      die "$(M "ввод закончился на вопросе о firewall" "input ended at the firewall question")"
    fi
    case "$ANSWER" in
      y|Y|yes|YES|Yes|да|ДА|Да) FIREWALL=1 ;;
      *) FIREWALL=0 ;;
    esac
  fi
}

# ── Секреты (автоген всегда; не спрашиваем, не выводим) ──────────────────────
# В --update сохраняем прежние значения (ротация ENOT_SECRET_KEY сделала бы
# существующие TOTP-секреты нечитаемыми, ротация TURN-секрета рассинхронила бы
# coturn) — новое значение генерируется только если прежнего нет.
make_secrets() {
  local env_file="/etc/enotdesk/enotdesk.env"
  local prev_key="" prev_turn="" p=""
  KEY_PRESET=0
  TURN_PRESET=0
  if [ "$UPDATE" = "1" ] && [ "$MODE" = "baremetal" ] && [ -r "$env_file" ]; then
    prev_key="$(env_value ENOT_SECRET_KEY "$env_file")"
    prev_turn="$(env_value ENOT_TURN_SECRET "$env_file")"
  elif [ "$MODE" = "docker" ] && [ -f "./enotdesk-docker/.env" ]; then
    prev_key="$(env_value ENOT_SECRET_KEY ./enotdesk-docker/.env)"
    prev_turn="$(env_value TURN_SECRET ./enotdesk-docker/.env)"
  fi
  if [ -n "$prev_key" ]; then
    SECRET_KEY="$prev_key"
    KEY_PRESET=1
  else
    SECRET_KEY="$(rand_hex 32)"
    [ -n "$SECRET_KEY" ] || die "$(M "не удалось сгенерировать ENOT_SECRET_KEY" "could not generate ENOT_SECRET_KEY")"
  fi
  if [ -n "$prev_turn" ]; then
    TURN_SECRET="$prev_turn"
    TURN_PRESET=1
  else
    TURN_SECRET="$(rand_hex 32)"
    [ -n "$TURN_SECRET" ] || die "$(M "не удалось сгенерировать секрет TURN" "could not generate the TURN secret")"
  fi
  # Доверенный прокси: только bare-metal с доменом — 127.0.0.1 (локальный Caddy);
  # в --update по умолчанию — прежнее значение из env-файла. В docker сеть —
  # забота compose (прокси — caddy-контейнер в bridge-сети), v1 не трогаем.
  TRUSTED_PROXY=""
  if [ "$MODE" = "baremetal" ] && [ -n "$DOMAIN" ]; then
    TRUSTED_PROXY="127.0.0.1"
    if [ "$UPDATE" = "1" ] && [ -r "$env_file" ]; then
      p="$(env_value ENOT_TRUSTED_PROXY "$env_file")"
      if [ -n "$p" ]; then TRUSTED_PROXY="$p"; fi
    fi
  fi
}

# ── Публичный URL ────────────────────────────────────────────────────────────
compute_public_url() {
  if [ -n "$DOMAIN" ]; then
    PUBLIC_URL="https://$DOMAIN"
  elif [ "$MODE" = "docker" ]; then
    PUBLIC_URL="http://$(detect_ip)"
  else
    PUBLIC_URL="http://$(detect_ip):$PORT"
  fi
}

# ── План (dry-run) ───────────────────────────────────────────────────────────
print_plan() {
  local src mode_label fw_label pass_label
  if [ -n "$TARBALL" ]; then
    src="$TARBALL ($(M "локальный" "local"))"
  elif [ "$VERSION" = "latest" ]; then
    src="https://github.com/$REPO/releases/latest/download/enotdesk-server.tar.gz"
  else
    src="https://github.com/$REPO/releases/$VERSION/download/enotdesk-server.tar.gz"
  fi
  mode_label="bare-metal (systemd)"
  if [ "$MODE" = "docker" ]; then mode_label="docker (compose stack)"; fi
  if [ "$UPDATE" = "1" ]; then mode_label="$mode_label, update"; fi
  fw_label="$(M "не трогать" "leave alone")"
  if [ "$FIREWALL" = "1" ]; then fw_label="$(M "открыть порт" "open the port")"; fi
  pass_label="$(M "задан вручную — не отображается" "provided manually — never displayed")"
  if [ "${PASS_AUTO:-0}" = "1" ]; then
    pass_label="$(M "автогенерация, будет показан один раз в финале" "autogenerated, printed once at the end")"
  fi
  turn_label="$(M "(автогенерация)" "(autogenerated)")"
  if [ "${TURN_PRESET:-0}" = "1" ]; then
    turn_label="$(M "(сохранён из существующей установки)" "(kept from the existing installation)")"
  fi
  key_label="$(M "(автогенерация)" "(autogenerated)")"
  if [ "${KEY_PRESET:-0}" = "1" ]; then
    key_label="$(M "(сохранён из существующей установки)" "(kept from the existing installation)")"
  fi

  if [ "$LOCALE" = ru ]; then
    echo "EnotDesk — план установки (dry-run: ничего не меняется)"
    echo "  режим:           $mode_label"
    echo "  источник:        $src"
    if [ -n "$DOMAIN" ]; then
      echo "  домен:           $DOMAIN (TLS: Caddy, авто-HTTPS)"
    else
      echo "  домен:           нет — HTTP по IP (незащищённый режим)"
    fi
    echo "  публичный URL:   $PUBLIC_URL"
    if [ "$MODE" = "baremetal" ]; then
      echo "  порт:            $PORT"
      echo "  firewall (ufw):  $fw_label"
    else
      echo "  порты:           127.0.0.1:8080 (сервер), 80/443 (Caddy), 3478 + 49160-49200/udp (coturn)"
      echo "  каталог:         ./enotdesk-docker (compose.yaml, Dockerfile, docker/, .env 0600)"
    fi
    echo "  TURN secret:     $turn_label"
    echo "  ENOT_SECRET_KEY: $key_label"
    if [ "$MODE" = "baremetal" ]; then
      if [ -n "${TRUSTED_PROXY:-}" ]; then
        echo "  trusted proxy:   $TRUSTED_PROXY"
      else
        echo "  trusted proxy:   не задаётся (нет домена)"
      fi
    fi
    echo "  админ:           логин $ADMIN_LOGIN, имя $ADMIN_NAME"
    echo "  пароль админа:   $pass_label"
    echo "  админ-bootstrap: сразу после установки, пароль — stdin-пайпом (не argv)"
  else
    echo "EnotDesk — installation plan (dry-run: nothing is changed)"
    echo "  mode:            $mode_label"
    echo "  source:          $src"
    if [ -n "$DOMAIN" ]; then
      echo "  domain:          $DOMAIN (TLS: Caddy, automatic HTTPS)"
    else
      echo "  domain:          none — plain HTTP by IP (insecure mode)"
    fi
    echo "  public URL:      $PUBLIC_URL"
    if [ "$MODE" = "baremetal" ]; then
      echo "  port:            $PORT"
      echo "  firewall (ufw):  $fw_label"
    else
      echo "  ports:           127.0.0.1:8080 (server), 80/443 (Caddy), 3478 + 49160-49200/udp (coturn)"
      echo "  directory:       ./enotdesk-docker (compose.yaml, Dockerfile, docker/, .env 0600)"
    fi
    echo "  TURN secret:     $turn_label"
    echo "  ENOT_SECRET_KEY: $key_label"
    if [ "$MODE" = "baremetal" ]; then
      if [ -n "${TRUSTED_PROXY:-}" ]; then
        echo "  trusted proxy:   $TRUSTED_PROXY"
      else
        echo "  trusted proxy:   not set (no domain)"
      fi
    fi
    echo "  admin:           login $ADMIN_LOGIN, name $ADMIN_NAME"
    echo "  admin password:  $pass_label"
    echo "  admin bootstrap: right after install, password via a stdin pipe (never argv)"
  fi
}

# ── Скачивание и проверка tarball ────────────────────────────────────────────
tarball_url() {
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/enotdesk-server.tar.gz' "$REPO"
  else
    printf 'https://github.com/%s/releases/%s/download/enotdesk-server.tar.gz' "$REPO" "$VERSION"
  fi
}
checksums_url() {
  if [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/checksums-sha256.txt' "$REPO"
  else
    printf 'https://github.com/%s/releases/%s/download/checksums-sha256.txt' "$REPO" "$VERSION"
  fi
}
raw_base() {
  if [ "$VERSION" = "latest" ]; then
    printf 'https://raw.githubusercontent.com/%s/main' "$REPO"
  else
    printf 'https://raw.githubusercontent.com/%s/%s' "$REPO" "$VERSION"
  fi
}

fetch() { # $1=url $2=dest $3=что это (для ошибки)
  curl -fsSL --retry 2 --connect-timeout 15 "$1" -o "$2" \
    || die "$(M "не удалось скачать $3: $1 — проверьте доступ к github.com" "failed to download $3: $1 — check access to github.com")"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "$(M "не найден sha256sum/shasum — они нужны для проверки контрольной суммы" "neither sha256sum nor shasum found — needed for checksum verification")"
  fi
}

# Контрольная сумма: fail-closed. Файла чексумм или строки для tarball нет —
# отказ (docs/SERVER.md обещает проверку SHA256); не сошлась — тем более отказ.
verify_sha256() { # $1=file $2=checksums $3=name
  if [ ! -s "$2" ]; then
    die "$(M "checksums-sha256.txt не скачался — установить без проверки SHA256 нельзя (доступность github.com обязательна)" "checksums-sha256.txt could not be downloaded — installing without a SHA256 check is refused (github.com must be reachable)")"
  fi
  local want got
  want="$(grep " $3\$" "$2" 2>/dev/null | awk '{print $1}' | tail -n 1 || true)"
  if [ -z "$want" ]; then
    die "$(M "в checksums-sha256.txt нет строки для $3 — установить без проверки SHA256 нельзя (релиз не полон?)" "checksums-sha256.txt has no line for $3 — installing without a SHA256 check is refused (incomplete release?)")"
  fi
  got="$(sha256_of "$1")"
  if [ "$got" != "$want" ]; then
    die "$(M "SHA256 tarball не совпал со checksums-sha256.txt — файл повреждён или подменён, установка отменена" "tarball SHA256 does not match checksums-sha256.txt — the file is corrupt or tampered with, installation aborted")"
  fi
  info "$(M "SHA256 tarball сверён с checksums-sha256.txt" "tarball SHA256 verified against checksums-sha256.txt")"
}

# ── Bare-metal: скачать → распаковать → install-server.sh → health → bootstrap ──
baremetal_install() {
  SETUP_TMP="$(mktemp -d /tmp/enotdesk-setup.XXXXXX)"
  local app_tgz="$SETUP_TMP/enotdesk-server.tar.gz"
  local fw_args=""
  if [ "$FIREWALL" = "1" ]; then fw_args="--open-firewall"; fi

  if [ -n "$TARBALL" ]; then
    if [ ! -f "$TARBALL" ]; then
      die "$(M "tarball не найден: $TARBALL" "tarball not found: $TARBALL")"
    fi
    info "$(M "использую локальный tarball: $TARBALL" "using the local tarball: $TARBALL")"
    cp "$TARBALL" "$app_tgz"
  else
    info "$(M "скачиваю релиз: $(tarball_url)" "downloading the release: $(tarball_url)")"
    fetch "$(tarball_url)" "$app_tgz" "$(M "tarball релиза" "release tarball")"
    # Пустой файл ниже заставит verify_sha256 честно отказаться: контрольные суммы обязательны (fail-closed).
    if ! curl -fsSL --retry 2 --connect-timeout 15 "$(checksums_url)" -o "$SETUP_TMP/checksums-sha256.txt"; then
      printf '' > "$SETUP_TMP/checksums-sha256.txt"
    fi
    verify_sha256 "$app_tgz" "$SETUP_TMP/checksums-sha256.txt" "enotdesk-server.tar.gz"
  fi

  info "$(M "распаковываю установщик во временный каталог" "extracting the installer into a temp directory")"
  mkdir -p "$SETUP_TMP/src"
  if ! tar -xzf "$app_tgz" -C "$SETUP_TMP/src" scripts/install-server.sh; then
    die "$(M "в tarball нет scripts/install-server.sh — это не сборка EnotDesk" "the tarball has no scripts/install-server.sh — this is not an EnotDesk build")"
  fi

  # Значения — окружением процесса через env-файл 0600 (тот же паттерн, что в
  # deploy-server.sh): секреты не попадают в argv. Без домена TURN/TLS-переменные
  # не передаются — установщик сам остаётся в локальном HTTP-режиме. Файл создаётся
  # сразу с 0600 (install -m 0600 /dev/null, как в install-server.sh), чтобы не было
  # окна world-readable между записью и chmod; значения — в одинарных кавычках с
  # экранированием ' → '\'' (env_kv): содержимое не выезжает за пределы переменной.
  local run_env="$SETUP_TMP/run.env"
  install -m 0600 /dev/null "$run_env"
  kv() {
    local esc
    esc="$(printf '%s' "$2" | sed "s/'/'\\\\''/g")"
    printf "%s='%s'\n" "$1" "$esc"
  }
  {
    kv ENOT_PORT "$PORT"
    kv ENOT_PUBLIC_URL "$PUBLIC_URL"
    kv ENOT_SECRET_KEY "$SECRET_KEY"
    if [ -n "$DOMAIN" ]; then
      kv ENOT_TURN_SECRET "$TURN_SECRET"
      kv ENOT_TRUSTED_PROXY "$TRUSTED_PROXY"
    fi
  } >> "$run_env"

  info "$(M "запускаю scripts/install-server.sh (значения — окружением из run.env 0600)" "running scripts/install-server.sh (values via the environment from run.env 0600)")"
  (
    cd "$SETUP_TMP/src"
    set -a
    # shellcheck disable=SC1090
    . "$run_env"
    set +a
    # shellcheck disable=SC2086  # fw_args — константа "--open-firewall" или пусто
    bash scripts/install-server.sh "$app_tgz" $fw_args
  ) || die "$(M "установщик сообщил об ошибке — исправьте причину и перезапустите мастер" "the installer reported an error — fix the cause and re-run the wizard")"

  # Health-wait ≤90 c: честная ошибка с хвостом журнала.
  wait_health "http://127.0.0.1:$PORT/api/v1/health" baremetal
}

# Общее ожидание health (≤90 c, шаг 1 c): при неудаче — честный отказ с хвостом
# логов (журнал systemd для bare-metal, compose logs для docker).
wait_health() { # $1=url $2=baremetal|docker $3=каталог compose (для docker)
  local url="$1" kind="$2" dir="${3:-}"
  local healthy=0
  local deadline=$((SECONDS + 90))
  info "$(M "жду health: $url (до 90 с)" "waiting for health: $url (up to 90 s)")"
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [ "$healthy" != "1" ]; then
    if [ "$kind" = "docker" ]; then
      echo "--- $(M "последние строки журнала контейнера enotdesk" "last enotdesk container log lines") ---" >&2
      ( cd "$dir" && docker compose logs --tail 20 enotdesk ) >&2 || true
    else
      echo "--- $(M "последние строки журнала enotdesk" "last enotdesk journal lines") ---" >&2
      journalctl -u enotdesk -n 20 --no-pager >&2 || true
    fi
    die "$(M "health не ответил за 90 секунд ($url)" "health did not answer within 90 seconds ($url)")"
  fi
  info "health: ok"
}

# Пароль администратора — только stdin-пайпом bootstrap'у (не argv, не echo).
# «Администратор уже существует» — честное сообщение, НЕ ошибка установки.
run_admin_bootstrap() { # $1=baremetal|docker $2=db-путь (baremetal) $3=node (baremetal)
  local kind="$1" boot_out="" boot_rc=0
  info "$(M "создаю первого администратора (пароль — stdin-пайпом, не argv)" "creating the first admin (the password goes via a stdin pipe, never argv)")"
  case "$kind" in
    baremetal)
      boot_out="$(printf '%s\n' "$ADMIN_LOGIN" "$ADMIN_NAME" "$ADMIN_PASSWORD" "$ADMIN_PASSWORD" \
        | runuser -u enotdesk -- env ENOT_DB="$2" "$3" /opt/enotdesk/current/server/main.mjs bootstrap 2>&1)" || boot_rc=$?
      ;;
    docker)
      boot_out="$(printf '%s\n' "$ADMIN_LOGIN" "$ADMIN_NAME" "$ADMIN_PASSWORD" "$ADMIN_PASSWORD" \
        | ( cd "$DOCKER_DIR" && docker compose exec -T enotdesk node server/main.mjs bootstrap ) 2>&1)" || boot_rc=$?
      ;;
  esac
  if [ -n "$boot_out" ]; then printf '%s\n' "$boot_out" >&2; fi
  case "$boot_out" in
    *"уже существует"*)
      info "$(M "администратор уже существует — база не изменена; это не ошибка установки" "the admin already exists — the database is untouched; this is not an install error")"
      ;;
    *)
      if [ "$boot_rc" != "0" ]; then
        die "$(M "bootstrap администратора не удался (см. вывод выше)" "admin bootstrap failed (see the output above)")"
      fi
      ;;
  esac
}

baremetal_bootstrap() {
  local db_path node_bin
  db_path="$(env_value ENOT_DB /etc/enotdesk/enotdesk.env)"
  if [ -z "$db_path" ]; then db_path="/var/lib/enotdesk/enotdesk.db"; fi
  node_bin="/opt/node-24/bin/node"
  if [ ! -x "$node_bin" ]; then node_bin="$(command -v node || true)"; fi
  if [ -z "$node_bin" ]; then
    die "$(M "Node.js не найден — bootstrap невозможен" "Node.js not found — bootstrap is impossible")"
  fi
  run_admin_bootstrap baremetal "$db_path" "$node_bin"
}

baremetal_final() {
  local ip
  ip="$(detect_ip)"
  echo "=============================================================="
  if [ "$LOCALE" = ru ]; then
    echo "EnotDesk установлен."
    echo "  Страница загрузок:    $PUBLIC_URL/downloads"
    echo "  Браузерный оператор:  $PUBLIC_URL/operator"
    echo "  Логин администратора: $ADMIN_LOGIN"
    if [ "$PASS_AUTO" = "1" ]; then
      echo ""
      echo "  ┌────────────────────────────────────────────────────────"
      echo "  │ Пароль администратора (автогенерация) — показывается ОДИН раз."
      echo "  │ Сохраните его сейчас:"
      echo "  │   $ADMIN_PASSWORD"
      echo "  └────────────────────────────────────────────────────────"
    fi
    if [ -z "$DOMAIN" ]; then
      echo ""
      echo "  ВНИМАНИЕ: домен не задан — работает HTTP без шифрования; пароли, токены"
      echo "  и сигналинг идут по сети открытым текстом. Для продакшена: направьте"
      echo "  A-запись домена на $ip и перезапустите мастер с --update — включится"
      echo "  HTTPS (Caddy, авто-сертификат)."
    fi
    echo ""
    echo "  Обновление: curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash -s -- --update"
    echo "  Удаление:   sudo bash /opt/enotdesk/current/scripts/install-server.sh --uninstall"
    echo "  Проверка:   ENOT_BASE_URL=$PUBLIC_URL ENOT_ADMIN_LOGIN=$ADMIN_LOGIN ENOT_ADMIN_PASSWORD=… \\"
    echo "              node scripts/smoke-remote.mjs   (из клона репозитория)"
  else
    echo "EnotDesk is installed."
    echo "  Downloads page:       $PUBLIC_URL/downloads"
    echo "  Web operator:         $PUBLIC_URL/operator"
    echo "  Admin login:          $ADMIN_LOGIN"
    if [ "$PASS_AUTO" = "1" ]; then
      echo ""
      echo "  ┌────────────────────────────────────────────────────────"
      echo "  │ Admin password (autogenerated) — shown ONCE."
      echo "  │ Save it now:"
      echo "  │   $ADMIN_PASSWORD"
      echo "  └────────────────────────────────────────────────────────"
    fi
    if [ -z "$DOMAIN" ]; then
      echo ""
      echo "  WARNING: no domain — plain HTTP without encryption; passwords, tokens"
      echo "  and signaling travel the network in cleartext. For production: point"
      echo "  the domain's A record at $ip and re-run the wizard with --update —"
      echo "  HTTPS (Caddy, automatic certificate) will be enabled."
    fi
    echo ""
    echo "  Upgrade:   curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash -s -- --update"
    echo "  Uninstall: sudo bash /opt/enotdesk/current/scripts/install-server.sh --uninstall"
    echo "  Check:     ENOT_BASE_URL=$PUBLIC_URL ENOT_ADMIN_LOGIN=$ADMIN_LOGIN ENOT_ADMIN_PASSWORD=… \\"
    echo "             node scripts/smoke-remote.mjs   (from a repo checkout)"
  fi
  echo "=============================================================="
}

# ── Docker: скачать raw-файлы стека → .env 0600 → compose up → bootstrap ─────
docker_install() {
  DOCKER_DIR="$PWD/enotdesk-docker"
  mkdir -p "$DOCKER_DIR/docker/enotdesk" "$DOCKER_DIR/docker/caddy" "$DOCKER_DIR/docker/coturn"
  local base f
  base="$(raw_base)"
  for f in compose.yaml Dockerfile .dockerignore \
           docker/enotdesk/entrypoint.sh docker/caddy/entrypoint.sh docker/coturn/entrypoint.sh; do
    fetch "$base/$f" "$DOCKER_DIR/$f" "$f"
  done

  # .env compose читает сам (интерполяция ${VAR} в compose.yaml); права 0600
  # выставляются ДО записи (внутри секреты) — без окна world-readable.
  # ENOT_PUBLIC_URL добавляем, чтобы без домена страницы знали адрес.
  local envf="$DOCKER_DIR/.env"
  install -m 0600 /dev/null "$envf"
  {
    printf 'DOMAIN=%s\n' "$DOMAIN"
    printf 'TURN_SECRET=%s\n' "$TURN_SECRET"
    printf 'ENOT_SECRET_KEY=%s\n' "$SECRET_KEY"
    printf 'ENOT_PUBLIC_URL=%s\n' "$PUBLIC_URL"
  } >> "$envf"

  info "$(M "поднимаю стек: docker compose up -d --build (в $DOCKER_DIR)" "bringing the stack up: docker compose up -d --build (in $DOCKER_DIR)")"
  if ! ( cd "$DOCKER_DIR" && docker compose up -d --build ); then
    die "$(M "docker compose up не удался — смотрите вывод выше" "docker compose up failed — see the output above")"
  fi

  wait_health "http://127.0.0.1:8080/api/v1/health" docker "$DOCKER_DIR"
}

docker_bootstrap() {
  run_admin_bootstrap docker
}

docker_final() {
  local url
  if [ -n "$DOMAIN" ]; then url="https://$DOMAIN"; else url="http://$(detect_ip)"; fi
  echo "=============================================================="
  if [ "$LOCALE" = ru ]; then
    echo "Стек EnotDesk (docker) запущен: каталог $DOCKER_DIR."
    echo "  Страница загрузок:    $url/downloads"
    echo "  Браузерный оператор:  $url/operator"
    echo "  Логин администратора: $ADMIN_LOGIN"
    if [ "$PASS_AUTO" = "1" ]; then
      echo ""
      echo "  ┌────────────────────────────────────────────────────────"
      echo "  │ Пароль администратора (автогенерация) — показывается ОДИН раз."
      echo "  │ Сохраните его сейчас:"
      echo "  │   $ADMIN_PASSWORD"
      echo "  └────────────────────────────────────────────────────────"
    fi
    if [ -z "$DOMAIN" ]; then
      echo ""
      echo "  ВНИМАНИЕ: домен не задан — Caddy отдаёт HTTP :80 без шифрования."
      echo "  Для HTTPS: направьте A-запись домена на этот хост, затем запустите"
      echo "  мастер с --update и укажите домен."
    fi
    echo ""
    echo "  Управление:  cd $DOCKER_DIR && docker compose ps | logs -f | down"
    echo "  Обновление:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash -s -- --update --docker"
  else
    echo "The EnotDesk docker stack is up: directory $DOCKER_DIR."
    echo "  Downloads page:       $url/downloads"
    echo "  Web operator:         $url/operator"
    echo "  Admin login:          $ADMIN_LOGIN"
    if [ "$PASS_AUTO" = "1" ]; then
      echo ""
      echo "  ┌────────────────────────────────────────────────────────"
      echo "  │ Admin password (autogenerated) — shown ONCE."
      echo "  │ Save it now:"
      echo "  │   $ADMIN_PASSWORD"
      echo "  └────────────────────────────────────────────────────────"
    fi
    if [ -z "$DOMAIN" ]; then
      echo ""
      echo "  WARNING: no domain — Caddy serves plain HTTP on :80."
      echo "  For HTTPS: point the domain's A record at this host, then re-run"
      echo "  the wizard with --update and the domain."
    fi
    echo ""
    echo "  Manage:   cd $DOCKER_DIR && docker compose ps | logs -f | down"
    echo "  Upgrade:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/quick-setup.sh | sudo bash -s -- --update --docker"
  fi
  echo "=============================================================="
}

# ── Главная последовательность ───────────────────────────────────────────────
if [ "$MODE" = "baremetal" ]; then
  if [ "$DRY_RUN" != "1" ]; then
    preflight_baremetal
  fi
else
  if [ "$DRY_RUN" != "1" ]; then
    preflight_docker
  fi
fi

collect_answers
make_secrets
compute_public_url

if [ "$DRY_RUN" = "1" ]; then
  print_plan
  exit 0
fi

info "$(M "стартую установку EnotDesk" "starting the EnotDesk installation")"
if [ "$MODE" = "baremetal" ]; then
  baremetal_install
  baremetal_bootstrap
  baremetal_final
else
  docker_install
  docker_bootstrap
  docker_final
fi

# Пароль отработал: затираем переменную (файлы с секретами удаляет trap cleanup;
# в docker секреты остаются только в .env 0600 — они нужны compose при рестартах).
ADMIN_PASSWORD=""
unset ADMIN_PASSWORD

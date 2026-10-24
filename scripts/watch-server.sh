#!/usr/bin/env bash
# EnotDesk: наблюдатель сервера с другой машины (docs/SERVER.md §7.3).
#   watch-server.sh check [конфиг] — раз в 5 минут (таймер): health сервера и хаба, срок TLS,
#       TCP-порты (TURN), диск и свежесть бэкапов на сервере (ssh status). Итог — пинг
#       Healthchecks-совместимого сервиса: успех или /fail с причиной. Молчание наблюдателя
#       (упала сама эта машина или её сеть) сервис замечает сам — по пропущенному пингу.
#   watch-server.sh pull [конфиг] — раз в сутки: зашифрованная копия бэкапов с сервера
#       (ssh fetch, см. scripts/offsite-serve.sh) в WATCH_DIR, хранить WATCH_KEEP последних;
#       итог — пинг своей проверки.
# Конфиг (по умолчанию /etc/enotdesk-watch.conf, 0600) — строки КЛЮЧ=значение, ключи — ниже.
# Ключа расшифровки копий на этой машине нет: копию шифрует сервер открытым ключом age.
set -uo pipefail
umask 077

ACTION=${1:-}
CONF=${2:-${ENOT_WATCH_CONF:-/etc/enotdesk-watch.conf}}

WATCH_URL=''            # адрес сервера, например https://support.example.com (обязателен)
WATCH_HUB_URL=''        # health хаба целиком, например https://support.example.com/api/hub/health
WATCH_TLS_DAYS=14       # тревога, если сертификат истекает раньше
WATCH_TCP=''            # порты через пробел: support.example.com:3478
WATCH_SSH=''            # root@support.example.com — ключ с принудительной командой offsite-serve.sh
WATCH_SSH_KEY=''
WATCH_SSH_PORT=22
WATCH_KNOWN_HOSTS=''    # отдельный known_hosts с ключом сервера (проверка строгая)
WATCH_DISK_MAX=90       # %, выше — тревога
WATCH_BACKUP_MAX_H=26   # часов, старше — тревога (таймер бэкапа — раз в сутки)
WATCH_PING_CHECK=''     # URL пинга проверки «сервер» (период 5 мин)
WATCH_PING_BACKUP=''    # URL пинга проверки «копия» (период 1 сутки)
WATCH_DIR=/var/lib/enotdesk-offsite
WATCH_KEEP=30
WATCH_RETRY_SEC=20      # пауза перед повторной попыткой: один сбой Wi-Fi — ещё не тревога
WATCH_SSH_BIN=ssh

[ -r "$CONF" ] || { echo "нет конфига $CONF" >&2; exit 2; }
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key=${line%%=*}
  val=${line#*=}
  case "$val" in \"*\" | \'*\') val=${val:1:${#val}-2} ;; esac
  case "$key" in
    WATCH_URL | WATCH_HUB_URL | WATCH_TLS_DAYS | WATCH_TCP | WATCH_SSH | WATCH_SSH_KEY | WATCH_SSH_PORT | \
      WATCH_KNOWN_HOSTS | WATCH_DISK_MAX | WATCH_BACKUP_MAX_H | WATCH_PING_CHECK | WATCH_PING_BACKUP | \
      WATCH_DIR | WATCH_KEEP | WATCH_RETRY_SEC | WATCH_SSH_BIN) printf -v "$key" '%s' "$val" ;;
    *) echo "конфиг: неизвестный ключ «${key}»" >&2; exit 2 ;;
  esac
done < "$CONF"
WATCH_URL=${WATCH_URL%/}
[ -n "$WATCH_URL" ] || { echo "конфиг: нужен WATCH_URL" >&2; exit 2; }
# URL пинга уходит в конфиг curl строкой url = "…": кавычка или пробел в нём дописали бы curl другие опции
for u in "$WATCH_PING_CHECK" "$WATCH_PING_BACKUP"; do
  case "$u" in '' | http://* | https://*) ;; *) echo "конфиг: URL пинга — только http(s)://" >&2; exit 2 ;; esac
  case "$u" in *[!A-Za-z0-9._~:/?\&=%+-]*) echo "конфиг: недопустимый символ в URL пинга" >&2; exit 2 ;; esac
done

# timeout есть в Linux; без него (macOS) — без ограничения, у curl и ssh свои таймауты
tmo() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }

# Пинг: URL — секрет проверки, поэтому в argv curl он не попадает (конфиг через -K -).
ping_hc() { # $1 URL проверки, $2 '' или /fail, $3 текст
  [ -n "$1" ] || return 0
  printf 'url = "%s%s"\n' "$1" "$2" | curl -fsS -m 15 --retry 2 -o /dev/null -K - --data-binary "$3" \
    || echo "пинг не доставлен" >&2
}

ssh_server() { # $1 — команда сервера: status | fetch
  # -n: stdin серверу не нужен; без него ssh съедает остаток скрипта, пришедшего на stdin (bash -s)
  local o=(-n -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=10
    -o ServerAliveCountMax=3 -p "$WATCH_SSH_PORT")
  [ -n "$WATCH_SSH_KEY" ] && o+=(-i "$WATCH_SSH_KEY")
  [ -n "$WATCH_KNOWN_HOSTS" ] && o+=(-o "UserKnownHostsFile=$WATCH_KNOWN_HOSTS" -o StrictHostKeyChecking=yes)
  # ssh пересылает LC_*: локали этой машины на сервере может не быть, и bash сервера сыплет
  # предупреждениями в ответ. C есть везде; русские тексты — просто байты UTF-8
  LC_ALL=C LANG=C "$WATCH_SSH_BIN" "${o[@]}" "$WATCH_SSH" "$1"
}

OKS=()
FAILS=()
attempt() { # $1 — что проверяем, дальше — функция проверки; вторая попытка через WATCH_RETRY_SEC
  local name=$1 out
  shift
  if out=$("$@" 2>&1); then OKS+=("$name: $out"); return 0; fi
  sleep "$WATCH_RETRY_SEC"
  if out=$("$@" 2>&1); then OKS+=("$name: $out (со второй попытки)"); return 0; fi
  FAILS+=("$name: ${out:-сбой}")
}

c_health() { # $1 — URL health; ждём "ok":true
  local body v
  body=$(curl -fsS -m 10 "$1") || return 1
  case "$body" in *'"ok":true'*) ;; *) echo "ответ без \"ok\":true"; return 1 ;; esac
  v=$(printf '%s' "$body" | sed -n 's/.*"version":"\([^"]*\)".*/версия \1/p')
  echo "${v:-ok}"
}

c_tls() { # $1 — хост[:порт]; цепочку уже проверил curl в c_health, тут — только срок
  local host=${1%%:*} hp=$1 cert end
  [ "$hp" = "$host" ] && hp="$host:443"
  cert=$(tmo 20 openssl s_client -connect "$hp" -servername "$host" </dev/null 2>/dev/null | openssl x509 2>/dev/null)
  [ -n "$cert" ] || { echo "сертификат не получен"; return 1; }
  end=$(printf '%s\n' "$cert" | openssl x509 -noout -enddate | sed 's/^notAfter=//')
  if printf '%s\n' "$cert" | openssl x509 -noout -checkend $((WATCH_TLS_DAYS * 86400)) >/dev/null; then
    echo "до $end"
  else
    echo "истекает меньше чем через $WATCH_TLS_DAYS дн.: $end"
    return 1
  fi
}

c_tcp() { # $1 — хост:порт
  if tmo 6 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "${1%:*}" "${1##*:}" 2>/dev/null; then echo открыт; else echo "не отвечает"; return 1; fi
}

c_remote() { # ssh status: диск и возраст дампов
  local js used main hub bad=()
  js=$(ssh_server status) || { echo "ssh status не удался"; return 1; }
  num() { printf '%s' "$js" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p"; }
  used=$(num diskUsedPct)
  main=$(num mainBackupAgeH)
  hub=$(num hubBackupAgeH)
  [ -n "$used" ] || { echo "ответ status не разобран"; return 1; }
  [ "$used" -le "$WATCH_DISK_MAX" ] || bad+=("диск занят на $used%")
  if [ -z "$main" ]; then bad+=("нет готового дампа основной базы")
  elif [ "$main" -gt "$WATCH_BACKUP_MAX_H" ]; then bad+=("дампу основной базы $main ч"); fi
  [ -n "$hub" ] && [ "$hub" -gt "$WATCH_BACKUP_MAX_H" ] && bad+=("дампу базы хаба $hub ч")
  if [ ${#bad[@]} -gt 0 ]; then
    local IFS=';'
    echo "${bad[*]}" | sed 's/;/; /g'
    return 1
  fi
  echo "диск $used%, дамп $main ч${hub:+, хаб $hub ч}"
}

report() { # $1 — URL пинга
  local msg
  if [ ${#FAILS[@]} -eq 0 ]; then
    msg=$(printf '%s\n' "${OKS[@]}")
    printf 'OK\n%s\n' "$msg"
    ping_hc "$1" '' "$msg"
    return 0
  fi
  msg=$(printf 'СБОЙ %s\n' "${FAILS[@]}"; [ ${#OKS[@]} -gt 0 ] && printf '%s\n' "${OKS[@]}")
  printf '%s\n' "$msg"
  ping_hc "$1" /fail "$msg"
  return 1
}

do_check() {
  local h t
  attempt "сервер" c_health "$WATCH_URL/api/v1/health"
  [ -n "$WATCH_HUB_URL" ] && attempt "хаб" c_health "$WATCH_HUB_URL"
  case "$WATCH_URL" in https://*) h=${WATCH_URL#https://}; attempt "TLS" c_tls "${h%%/*}" ;; esac
  for t in $WATCH_TCP; do attempt "порт $t" c_tcp "$t"; done
  [ -n "$WATCH_SSH" ] && attempt "на сервере" c_remote
  report "$WATCH_PING_CHECK"
}

pull_once() { # $1 — итоговый файл; stderr сервера — в stdout функции
  local part="$WATCH_DIR/.part-${1##*/}" err size
  if ! err=$(ssh_server fetch 2>&1 >"$part"); then rm -f "$part"; echo "ssh fetch: ${err:-сбой}"; return 1; fi
  size=$(wc -c < "$part" | tr -d ' ')
  # двоичный формат age начинается строкой версии — иначе это не шифр, а мусор или открытый tar
  if [ "$(head -c 21 "$part")" != "age-encryption.org/v1" ]; then rm -f "$part"; echo "ответ не похож на копию age ($size байт)"; return 1; fi
  mv -f "$part" "$1"
  echo "$((size / 1024)) КБ"
}

do_pull() {
  local out f n=0 info
  [ -n "$WATCH_SSH" ] || { echo "конфиг: для pull нужен WATCH_SSH" >&2; exit 2; }
  mkdir -p "$WATCH_DIR" && chmod 700 "$WATCH_DIR"
  out="$WATCH_DIR/enotdesk-offsite-$(date -u +%Y%m%dT%H%M%SZ).tar.age"
  if ! info=$(pull_once "$out"); then
    sleep "$WATCH_RETRY_SEC"
    info=$(pull_once "$out") || { FAILS+=("копия: $info"); report "$WATCH_PING_BACKUP"; return 1; }
  fi
  for f in $(ls -1 "$WATCH_DIR"/enotdesk-offsite-*.tar.age 2>/dev/null | sort -r | tail -n +$((WATCH_KEEP + 1))); do
    rm -f -- "$f"
  done
  n=$(ls -1 "$WATCH_DIR"/enotdesk-offsite-*.tar.age 2>/dev/null | wc -l | tr -d ' ')
  OKS+=("копия: ${out##*/}, $info, всего копий $n")
  report "$WATCH_PING_BACKUP"
}

case "$ACTION" in
  check) do_check ;;
  pull) do_pull ;;
  *) echo "использование: watch-server.sh check|pull [конфиг]" >&2; exit 2 ;;
esac

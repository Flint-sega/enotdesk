#!/usr/bin/env bash
# EnotDesk: выдача бэкапов машине-наблюдателю — копия вне сервера (docs/SERVER.md §7.3).
# Ставится на сервер как принудительная команда ssh-ключа наблюдателя (authorized_keys root):
#   restrict,command="/usr/local/sbin/enotdesk-offsite" ssh-ed25519 AAAA… enotdesk-watch
# Команда — из SSH_ORIGINAL_COMMAND (так её передаёт sshd) или из первого аргумента:
#   status — одна строка JSON: занятость диска с данными и возраст свежих дампов обеих баз
#            (и дополнительных, если они настроены);
#   fetch  — свежие дампы enotdesk-*.db и hub-*.db (и дополнительных баз) + SHA256SUMS одним tar,
#            зашифрованным age на открытые ключи из файла получателей, в stdout. Без age или без
#            ключей — отказ: открытую копию скрипт не отдаёт никогда.
# Настройки (env): ENOT_OFFSITE_BACKUPS (/var/lib/enotdesk/backups), ENOT_OFFSITE_DATA (/var/lib/enotdesk),
#   ENOT_OFFSITE_RECIPIENTS (/etc/enotdesk/offsite-recipients.txt), ENOT_OFFSITE_AGE (age),
#   ENOT_OFFSITE_SETTLE_SEC (60), ENOT_OFFSITE_CONF (/etc/enotdesk/offsite.conf).
# Дополнительные базы на этом же сервере (их дампы с теми же именами ПРЕФИКС-ГГГГ-ММ-ДДTччммссZ.db
#   делает свой таймер): ENOT_OFFSITE_EXTRA="/папка/префикс- …" — в env или строкой в файле
#   ENOT_OFFSITE_CONF (файл необязателен, не исполняется; владелец — тот, от чьего имени работает
#   скрипт, писать в него может только он).
set -euo pipefail
umask 077

BACKUPS=${ENOT_OFFSITE_BACKUPS:-/var/lib/enotdesk/backups}
DATA=${ENOT_OFFSITE_DATA:-/var/lib/enotdesk}
RECIPIENTS=${ENOT_OFFSITE_RECIPIENTS:-/etc/enotdesk/offsite-recipients.txt}
AGE=${ENOT_OFFSITE_AGE:-age}
# VACUUM INTO пишет прямо в итоговый файл: дамп моложе этого (с) может ещё писаться
SETTLE=${ENOT_OFFSITE_SETTLE_SEC:-60}
CONF=${ENOT_OFFSITE_CONF:-/etc/enotdesk/offsite.conf}

die() { echo "offsite: $1" >&2; exit "${2:-1}"; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# Дополнительные базы → EXTRA_DIRS/EXTRA_PREFIXES, всего EXTRA_N. Счётчик, а не "${arr[@]}":
# пустой массив под set -u в bash 3.2 (macOS) — ошибка «unbound variable».
EXTRA_N=0
load_extra() {
  local extra=${ENOT_OFFSITE_EXTRA:-} line e p list
  if [ -f "$CONF" ]; then
    # файл решает, какие папки root отдаёт наружу: файл чужого владельца или с чужой записью — отказ
    [ -n "$(find "$CONF" -user "$(id -u)" ! -perm -020 ! -perm -002 2>/dev/null)" ] \
      || die "файл настроек $CONF: владелец не $(id -un) или запись доступна не только владельцу" 5
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        '' | '#'*) ;;
        ENOT_OFFSITE_EXTRA=*) extra=${line#*=} ;;
        *) die "файл настроек $CONF: неизвестная строка" 5 ;;
      esac
    done < "$CONF"
  fi
  case "$extra" in \"*\" | \'*\') extra=${extra:1:${#extra}-2} ;; esac
  # read -a, а не for … in $extra: без раскрытия * и ? в именах
  read -r -a list <<< "$extra" || true
  for e in ${list[@]+"${list[@]}"}; do
    case "$e" in /?*/?*) ;; *) die "ENOT_OFFSITE_EXTRA: нужен абсолютный путь «/папка/префикс», а не «$e»" 5 ;; esac
    case "$e" in *[!A-Za-z0-9._/-]* | *..* | */) die "ENOT_OFFSITE_EXTRA: недопустимые символы в «$e»" 5 ;; esac
    p=${e##*/}
    case " enotdesk- hub- ${EXTRA_PREFIXES[*]:-} " in *" $p "*) die "ENOT_OFFSITE_EXTRA: префикс «$p» уже занят" 5 ;; esac
    EXTRA_DIRS[EXTRA_N]=${e%/*}
    EXTRA_PREFIXES[EXTRA_N]=$p
    EXTRA_N=$((EXTRA_N + 1))
  done
}

# Свежий готовый дамп с префиксом $2 в папке $1. Имена из server/backup.mjs сортируются по времени,
# поэтому последнее совпадение глоба — самое новое.
latest() {
  local now f best=''
  now=$(date +%s)
  for f in "$1/$2"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.db; do
    [ -f "$f" ] || continue
    # ссылка в папке дампов может вести на чужой файл: root её не берёт
    [ ! -L "$f" ] || continue
    [ $((now - $(mtime "$f"))) -ge "$SETTLE" ] || continue
    best=$f
  done
  printf '%s' "$best"
}
# имена дампов проходят строгий глоб выше — кавычек и обратных слешей в них нет
jname() { if [ -n "$1" ]; then printf '"%s"' "$(basename "$1")"; else printf 'null'; fi; }
agehours() { if [ -n "$1" ]; then echo $((($2 - $(mtime "$1")) / 3600)); else echo null; fi; }

status() {
  local main hub now used free i f a names='' maxage=null missing=0
  load_extra
  main=$(latest "$BACKUPS" enotdesk-)
  hub=$(latest "$BACKUPS" hub-)
  now=$(date +%s)
  # дополнительные базы: имена свежих дампов, возраст самого старого из них и сколько баз без дампа
  i=0
  while [ "$i" -lt "$EXTRA_N" ]; do
    f=$(latest "${EXTRA_DIRS[i]}" "${EXTRA_PREFIXES[i]}")
    if [ -n "$f" ]; then
      names="$names${names:+,}$(jname "$f")"
      a=$(agehours "$f" "$now")
      if [ "$maxage" = null ] || [ "$a" -gt "$maxage" ]; then maxage=$a; fi
    else
      missing=$((missing + 1))
    fi
    i=$((i + 1))
  done
  used='' free=''
  read -r used free < <(df -Pk "$DATA" 2>/dev/null | awk 'NR == 2 { sub(/%/, "", $5); print $5, int($4 / 1048576) }') || true
  printf '{"ok":%s,"diskUsedPct":%s,"diskFreeGb":%s,"mainBackup":%s,"mainBackupAgeH":%s,"hubBackup":%s,"hubBackupAgeH":%s,"extraBackups":[%s],"extraBackupAgeH":%s,"extraMissing":%s}\n' \
    "$([ -n "$main" ] && echo true || echo false)" "${used:-null}" "${free:-null}" \
    "$(jname "$main")" "$(agehours "$main" "$now")" "$(jname "$hub")" "$(agehours "$hub" "$now")" \
    "$names" "$maxage" "$missing"
}

fetch() {
  local main hub i f
  command -v "$AGE" >/dev/null 2>&1 || die "нет программы age (apt install age) — открытую копию не отдаю" 3
  grep -qvE '^[[:space:]]*(#|$)' "$RECIPIENTS" 2>/dev/null || die "нет открытых ключей age в $RECIPIENTS — открытую копию не отдаю" 3
  main=$(latest "$BACKUPS" enotdesk-)
  [ -n "$main" ] || die "нет готового дампа enotdesk-*.db в $BACKUPS" 4
  hub=$(latest "$BACKUPS" hub-)
  load_extra
  # глобальная, не local: ловушка EXIT срабатывает уже после выхода из функции
  TMPD=$(mktemp -d)
  trap 'rm -rf "$TMPD"' EXIT
  set -- "$(basename "$main")"
  [ -n "$hub" ] && set -- "$@" "$(basename "$hub")"
  (cd "$BACKUPS" && sha256 "$@") > "$TMPD/SHA256SUMS"
  set -- -C "$BACKUPS" "$@"
  # дополнительная база без готового дампа копию не срывает: о пропаже скажет status наблюдателю
  i=0
  while [ "$i" -lt "$EXTRA_N" ]; do
    f=$(latest "${EXTRA_DIRS[i]}" "${EXTRA_PREFIXES[i]}")
    if [ -n "$f" ]; then
      (cd "${EXTRA_DIRS[i]}" && sha256 "$(basename "$f")") >> "$TMPD/SHA256SUMS"
      set -- "$@" -C "${EXTRA_DIRS[i]}" "$(basename "$f")"
    fi
    i=$((i + 1))
  done
  tar -cf - "$@" -C "$TMPD" SHA256SUMS | "$AGE" -R "$RECIPIENTS"
}

case "${SSH_ORIGINAL_COMMAND:-${1:-}}" in
  status) status ;;
  fetch) fetch ;;
  *) die "неизвестная команда (можно: status, fetch)" 2 ;;
esac

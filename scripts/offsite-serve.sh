#!/usr/bin/env bash
# EnotDesk: выдача бэкапов машине-наблюдателю — копия вне сервера (docs/SERVER.md §7.3).
# Ставится на сервер как принудительная команда ssh-ключа наблюдателя (authorized_keys root):
#   restrict,command="/usr/local/sbin/enotdesk-offsite" ssh-ed25519 AAAA… enotdesk-watch
# Команда — из SSH_ORIGINAL_COMMAND (так её передаёт sshd) или из первого аргумента:
#   status — одна строка JSON: занятость диска с данными и возраст свежих дампов обеих баз;
#   fetch  — свежие дампы enotdesk-*.db и hub-*.db + SHA256SUMS одним tar, зашифрованным age
#            на открытые ключи из файла получателей, в stdout. Без age или без ключей — отказ:
#            открытую копию скрипт не отдаёт никогда.
# Настройки (env): ENOT_OFFSITE_BACKUPS (/var/lib/enotdesk/backups), ENOT_OFFSITE_DATA (/var/lib/enotdesk),
#   ENOT_OFFSITE_RECIPIENTS (/etc/enotdesk/offsite-recipients.txt), ENOT_OFFSITE_AGE (age),
#   ENOT_OFFSITE_SETTLE_SEC (60).
set -euo pipefail
umask 077

BACKUPS=${ENOT_OFFSITE_BACKUPS:-/var/lib/enotdesk/backups}
DATA=${ENOT_OFFSITE_DATA:-/var/lib/enotdesk}
RECIPIENTS=${ENOT_OFFSITE_RECIPIENTS:-/etc/enotdesk/offsite-recipients.txt}
AGE=${ENOT_OFFSITE_AGE:-age}
# VACUUM INTO пишет прямо в итоговый файл: дамп моложе этого (с) может ещё писаться
SETTLE=${ENOT_OFFSITE_SETTLE_SEC:-60}

die() { echo "offsite: $1" >&2; exit "${2:-1}"; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# Свежий готовый дамп с префиксом $1. Имена из server/backup.mjs сортируются по времени,
# поэтому последнее совпадение глоба — самое новое.
latest() {
  local now f best=''
  now=$(date +%s)
  for f in "$BACKUPS/$1"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.db; do
    [ -f "$f" ] || continue
    [ $((now - $(mtime "$f"))) -ge "$SETTLE" ] || continue
    best=$f
  done
  printf '%s' "$best"
}
# имена дампов проходят строгий глоб выше — кавычек и обратных слешей в них нет
jname() { if [ -n "$1" ]; then printf '"%s"' "$(basename "$1")"; else printf 'null'; fi; }
agehours() { if [ -n "$1" ]; then echo $((($2 - $(mtime "$1")) / 3600)); else echo null; fi; }

status() {
  local main hub now used free
  main=$(latest enotdesk-)
  hub=$(latest hub-)
  now=$(date +%s)
  used='' free=''
  read -r used free < <(df -Pk "$DATA" 2>/dev/null | awk 'NR == 2 { sub(/%/, "", $5); print $5, int($4 / 1048576) }') || true
  printf '{"ok":%s,"diskUsedPct":%s,"diskFreeGb":%s,"mainBackup":%s,"mainBackupAgeH":%s,"hubBackup":%s,"hubBackupAgeH":%s}\n' \
    "$([ -n "$main" ] && echo true || echo false)" "${used:-null}" "${free:-null}" \
    "$(jname "$main")" "$(agehours "$main" "$now")" "$(jname "$hub")" "$(agehours "$hub" "$now")"
}

fetch() {
  local main hub
  command -v "$AGE" >/dev/null 2>&1 || die "нет программы age (apt install age) — открытую копию не отдаю" 3
  grep -qvE '^[[:space:]]*(#|$)' "$RECIPIENTS" 2>/dev/null || die "нет открытых ключей age в $RECIPIENTS — открытую копию не отдаю" 3
  main=$(latest enotdesk-)
  [ -n "$main" ] || die "нет готового дампа enotdesk-*.db в $BACKUPS" 4
  hub=$(latest hub-)
  # глобальная, не local: ловушка EXIT срабатывает уже после выхода из функции
  TMPD=$(mktemp -d)
  trap 'rm -rf "$TMPD"' EXIT
  set -- "$(basename "$main")"
  [ -n "$hub" ] && set -- "$@" "$(basename "$hub")"
  (cd "$BACKUPS" && sha256 "$@") > "$TMPD/SHA256SUMS"
  tar -cf - -C "$BACKUPS" "$@" -C "$TMPD" SHA256SUMS | "$AGE" -R "$RECIPIENTS"
}

case "${SSH_ORIGINAL_COMMAND:-${1:-}}" in
  status) status ;;
  fetch) fetch ;;
  *) die "неизвестная команда (можно: status, fetch)" 2 ;;
esac

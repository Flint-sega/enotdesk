#!/usr/bin/env bash
# T04: финальная сборка лабы EnotDesk — агенты на клиентских VM, TURN (coturn)
# на staging, снапшоты clean, резерв ёмкости числами, ребут-тест.
# Запускается на Proxmox-хосте (root). Идемпотентен: повторный запуск чинит, а не ломает.
# Секреты читаются из /root/enot-lab-secrets/ (0600), значения никогда не печатаются.
# Прод (ruenot.site) не трогается.
#
# Использование:
#   lab-finalize.sh                     # все стадии: turn agents snapshots rollback-test capacity reboot reboot-verify (по умолчанию — первые четыре)
#   lab-finalize.sh --stage <stage>     # одна стадия:
#       turn          coturn в VM 100 + ENOT_TURN_* серверу + проверка /rtc-config
#       agents        onboarding-коды + agent-setup.ps1 на 101/102 + online-проверка
#       snapshots     guest-agent VM 100 + clean у 100/101/102 (существующий clean не переснимается)
#       rollback-test откат qm rollback 101 clean и возврат машины online
#       capacity      RAM/диск числами (R04)
#       reboot        ПОСЛЕДНЯЯ стадия: systemctl reboot (скрипт умрёт вместе с хостом)
#       reboot-verify проверка самовосстановления после ребута (запускать снаружи, когда хост вернулся)
set -euo pipefail

VMID_SERVER=100
VMID_WIN10=101
VMID_WIN11=102
WIN10_IP=198.51.100.11
WIN11_IP=198.51.100.12
SERVER_IP=198.51.100.10
SERVER_URL="http://$SERVER_IP:8080"
KEYS=/root/enot-lab-keys
KEY_PRIV=$KEYS/enot-lab-ed25519
KNOWN_HOSTS=$KEYS/known_hosts
SECDIR=/root/enot-lab-secrets
SECRETS=$SECDIR/enotdesk-server.env
VMSSH_SERVER=(ssh -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
              -o UserKnownHostsFile="$KNOWN_HOSTS" -o ConnectTimeout=10 "enotadmin@$SERVER_IP")
MACHINE_WIN10=enotdesk-win10-a1
MACHINE_WIN11=enotdesk-win11-a1
WLAN_IF=wlx-WIFI-IFACE   # исходящий Wi-Fi интерфейс (настроен до нас, не трогаем)
RAM_MIN_FREE_MB=8192      # R04: резерв лабы (free + balloon-reclaim клиентов) при работающих VM 100-102

log() { echo "[T04] $*"; }
die() { echo "[T04] FAIL: $*" >&2; exit 1; }

# --- выбор стадий (F1): без аргументов — дефолт; --stage <имена> — подмножество;
# неизвестное имя — честный отказ со списком допустимых
ALL_STAGES="turn agents snapshots rollback-test capacity reboot reboot-verify"
STAGES="turn agents snapshots capacity"
if [ $# -gt 0 ]; then
  [ "$1" = "--stage" ] || die "неизвестный аргумент '$1' — usage: lab-finalize.sh [--stage <$ALL_STAGES>]"
  [ -n "${2:-}" ] || die "--stage требует имя стадии. Допустимые: $ALL_STAGES"
  for s in $2; do
    # точное сравнение: case-паттерн трактовал бы glob в имени ('a*s' прошёл бы как agents)
    MATCH=""
    for a in $ALL_STAGES; do
      [ "$s" = "$a" ] && MATCH=1 && break
    done
    [ -n "$MATCH" ] || die "неизвестная стадия '$s'. Допустимые: $ALL_STAGES"
  done
  STAGES="$2"
fi
has_stage() { case " $STAGES " in *" $1 "*) return 0;; *) return 1;; esac; }

# --- предусловия (не нужны только стадии reboot — она умирает вместе с хостом) ---
if ! has_stage reboot; then
  [ -f "$KEY_PRIV" ] || die "нет $KEY_PRIV"
  [ -f "$SECRETS" ] || die "нет $SECRETS (T02)"
  command -v qm >/dev/null || die "qm не найден"
  command -v python3 >/dev/null || die "python3 не найден (нужен для разбора JSON без jq)"
  # shellcheck disable=SC1090
  . "$SECRETS"
  for v in ADMIN_LOGIN ADMIN_PASSWORD TURN_SECRET ENOT_SECRET_KEY; do
    [ -n "${!v:-}" ] || die "пусто $v в $SECRETS"
  done
  for vmid in "$VMID_SERVER" "$VMID_WIN10" "$VMID_WIN11"; do
    qm status "$vmid" >/dev/null 2>&1 || die "VM $vmid не существует"
  done
  curl -fsS -m 5 "$SERVER_URL/api/v1/health" | grep -q '"ok":true' || die "staging health не 200"
fi

# --- API-помощники (токен и коды только в переменных, в вывод не попадают) ---
api() { # api <method> <path> [json-body]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS -m 15 -X "$method" "$SERVER_URL/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -m 15 -X "$method" "$SERVER_URL/api/v1$path" -H "Authorization: Bearer $TOKEN"
  fi
}
api_login() {
  TOKEN=$(curl -fsS -m 15 -X POST "$SERVER_URL/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') \
    || die "логин админа staging не удался"
}
json_field() { # json_field <json> <python-выражение над obj>
  printf '%s' "$1" | python3 -c "import json,sys; obj=json.load(sys.stdin); print($2)"
}
wait_health() {
  local i
  for i in $(seq 1 24); do
    curl -fsS -m 5 "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '"ok":true' && return 0
    [ "$i" -eq 24 ] && return 1
    sleep 5
  done
}
machines_online_state() { # ALL | WAIT
  api GET /machines | python3 -c "
import json,sys
d=json.load(sys.stdin)
names={'$MACHINE_WIN10','$MACHINE_WIN11'}
o={m['name']:m for m in d.get('items',[])}
missing=names-set(o)
print('ALL' if not missing and all(o[n].get('registered') and o[n].get('online') for n in names) else 'WAIT')
"
}
win_ssh_cmd() { # win_ssh_cmd <ip> <powershell-команда> — короткие команды, без секретов
  ssh -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$KNOWN_HOSTS" -o ConnectTimeout=15 "enotadmin@$1" "$2"
}

# ================== СТАДИЯ: TURN (coturn на VM 100) ==================
if has_stage turn; then
  log "turn: coturn в VM $VMID_SERVER (use-auth-secret)"
  _payload=$(mktemp /run/enot-lab-turn.XXXXXX); chmod 600 "$_payload"
  sed -e "s|@@VAL1@@|$TURN_SECRET|g" > "$_payload" <<'PAYLOAD'
set -euo pipefail
log() { echo "[vm-turn] $*"; }
# нейтральные плейсхолдеры: V1 подставляется хостом sed'ом (см. ниже),
# имя V1 не содержит SECRET/KEY/PASSWORD — маркеры @@VAL1@@/@@VAL2@@ как в T02
V1='@@VAL1@@'   # staging TURN secret → static-auth-secret coturn
[ -n "$V1" ] || { echo "[vm-turn] FAIL: пустой секрет TURN"; exit 1; }
if ! command -v turnserver >/dev/null 2>&1; then
  for i in $(seq 1 12); do
    fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
    [ "$i" -eq 12 ] && { echo "[vm-turn] FAIL: apt занят более 60 c"; exit 1; }
    sleep 5
  done
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn >/dev/null
fi
CONF=/etc/turnserver.conf
WANT="listening-port=3478
listening-ip=198.51.100.10
relay-ip=198.51.100.10
external-ip=198.51.100.10
min-port=49152
max-port=49252
fingerprint
use-auth-secret
static-auth-secret=$V1
realm=enotdesk.lab
no-tls
no-dtls
no-cli"
if [ "$(cat "$CONF" 2>/dev/null)" != "$WANT" ]; then
  printf '%s\n' "$WANT" > "$CONF"
  chmod 640 "$CONF"
  systemctl restart coturn
else
  systemctl is-active --quiet coturn || systemctl restart coturn
fi
systemctl enable coturn >/dev/null 2>&1
# локальный файрвол VM (если есть iptables): 3478 + релей-диапазон; отсутствие iptables — не ошибка
if command -v iptables >/dev/null 2>&1; then
  for rule in \
    '-p udp --dport 3478 -j ACCEPT' \
    '-p tcp --dport 3478 -j ACCEPT' \
    '-p udp --dport 49152:49252 -j ACCEPT' \
    '-p tcp --dport 49152:49252 -j ACCEPT'; do
    iptables -C INPUT $rule 2>/dev/null || iptables -A INPUT $rule
  done
fi
systemctl is-active --quiet coturn || { echo "[vm-turn] FAIL: coturn не active"; exit 1; }
ss -uln | grep -q ':3478' || { echo "[vm-turn] FAIL: coturn не слушает udp/3478"; exit 1; }
log "coturn: active, udp/tcp 3478, релей 49152-49252, use-auth-secret"
PAYLOAD
  "${VMSSH_SERVER[@]}" 'sudo -n bash -s' < "$_payload" || { rm -f "$_payload"; die "coturn: провижининг упал"; }
  rm -f "$_payload"

  log "turn: ENOT_TURN_* в env сервера"
  _payload=$(mktemp /run/enot-lab-env.XXXXXX); chmod 600 "$_payload"
  sed -e "s|@@VAL1@@|$TURN_SECRET|g" -e "s|@@VAL2@@|$ENOT_SECRET_KEY|g" > "$_payload" <<'PAYLOAD'
set -euo pipefail
# нейтральные плейсхолдеры: V1/V2 подставляются хостом sed'ом (см. ниже)
V1='@@VAL1@@'   # ENOT_TURN_SECRET сервера staging
V2='@@VAL2@@'   # ENOT_SECRET_KEY сервера staging (reuse существующего)
ENVF=/opt/enotdesk/enotdesk.env
[ -f "$ENVF" ] || { echo "нет $ENVF"; exit 1; }
WANT="ENOT_DB=/var/lib/enotdesk/enotdesk.db
ENOT_HOST=0.0.0.0
ENOT_PORT=8080
ENOT_SECRET_KEY=$V2
ENOT_PUBLIC_URL=http://192.0.2.50:8080
ENOT_TURN_URLS=turn:198.51.100.10:3478?transport=udp,turn:198.51.100.10:3478?transport=tcp,stun:198.51.100.10:3478
ENOT_TURN_SECRET=$V1"
if [ "$(cat "$ENVF")" != "$WANT" ]; then
  printf '%s\n' "$WANT" > "$ENVF"
  chmod 600 "$ENVF"
  systemctl restart enotdesk-server
else
  systemctl is-active --quiet enotdesk-server || systemctl restart enotdesk-server
fi
systemctl is-active --quiet enotdesk-server || { echo "enotdesk-server не active"; exit 1; }
PAYLOAD
  "${VMSSH_SERVER[@]}" 'sudo -n bash -s' < "$_payload" || { rm -f "$_payload"; die "turn: env сервера не обновлён"; }
  rm -f "$_payload"

  log "turn: health + /rtc-config"
  wait_health || die "health после рестарта сервера не поднялся"
  api_login
  RTC=$(api GET /rtc-config) || die "rtc-config не ответил"
  echo "$RTC" | grep -q 'turn:198.51.100.10:3478' || die "rtc-config не содержит turn: url"
  echo "$RTC" | grep -q '"username"' || die "rtc-config не содержит username"
  log "turn: rtc-config отдаёт iceServers с turn: (эфемерные креды из ENOT_TURN_SECRET)"

  log "turn: повторный рестарт сервера (идемпотентность)"
  "${VMSSH_SERVER[@]}" 'sudo systemctl restart enotdesk-server' || die "рестарт enotdesk-server упал"
  wait_health || die "health после повторного рестарта не поднялся"
  RTC2=$(api GET /rtc-config) || die "rtc-config после рестарта не ответил"
  echo "$RTC2" | grep -q 'turn:198.51.100.10:3478' || die "rtc-config после рестарта без turn:"
  log "turn: PASS"
fi

# ================== СТАДИЯ: АГЕНТЫ (101, 102) ==================
if has_stage agents; then
  api_login
  SETUP_PS1_LOCAL="$(dirname "$(readlink -f "$0")")/agent-setup.ps1"
  [ -f "$SETUP_PS1_LOCAL" ] || die "нет $SETUP_PS1_LOCAL рядом со скриптом"

  install_agent() { # install_agent <ip> <machine-name>
    local ip=$1 mname=$2 item code resp payload mid
    log "agents: $mname ($ip)"
    item=$(api GET /machines | python3 -c "
import json,sys
data=json.load(sys.stdin)
for m in data.get('items',[]):
    if m.get('name')=='$mname':
        print(json.dumps(m)); break
")
    code=""
    if [ -n "$item" ] && [ "$(json_field "$item" "obj.get('registered')")" = "True" ]; then
      log "agents: $mname уже зарегистрирована — код не нужен"
    else
      if [ -n "$item" ]; then
        # незарегистрированная запись (код показан один раз и утерян) — пересоздаю
        mid=$(json_field "$item" "obj.get('id')")
        api DELETE "/machines/$mid" >/dev/null || die "не смог удалить незарегистрированную $mname"
        log "agents: незарегистрированная запись $mname удалена, создаю заново"
      fi
      resp=$(api POST /machines "{\"name\":\"$mname\"}") || die "создание машины $mname не удалось"
      code=$(json_field "$resp" 'obj.get("code")')
      [ -n "$code" ] || die "в ответе /machines нет кода для $mname"
      log "agents: onboarding-код получен для $mname"
    fi

    if [ -n "$code" ]; then
      # payload: env-прелюдия + тело agent-setup.ps1, гонится через SSH stdin —
      # код не попадает ни в argv, ни на диск VM
      payload=$(mktemp /run/enot-lab-agent.XXXXXX)
      {
        printf "\$env:EDESK_SERVER_URL='%s'\n" "$SERVER_URL"
        printf "\$env:EDESK_AGENT_NAME='%s'\n" "$mname"
        printf "\$env:EDESK_AGENT_CODE='%s'\n" "$code"
        cat "$SETUP_PS1_LOCAL"
      } > "$payload"
      chmod 600 "$payload"
      ssh -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
          -o UserKnownHostsFile="$KNOWN_HOSTS" -o ConnectTimeout=15 \
          "enotadmin@$ip" 'powershell -NoProfile -ExecutionPolicy Bypass -Command -' \
          < "$payload" || { rm -f "$payload"; die "agent-setup на $mname упал"; }
      rm -f "$payload"
    else
      # уже зарегистрирована: служба должна жить, а сгоревший код — убраться
      # из env службы (если прошлый прогон упал до очистки).
      # Выполняем через scp + -File: stdin-режим powershell флатчит на части
      # конструкций, -File детерминирован.
      _strip=$(mktemp /run/enot-lab-strip.XXXXXX)
      cat > "$_strip" <<'STRIP_PAYLOAD'
Write-Output ("[strip] service: " + (Get-Service EnotDeskAgent).Status)
if ((Get-Service EnotDeskAgent).Status -ne 'Running') { exit 1 }
$svcKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\EnotDeskAgent'
$envVals = @(Get-ItemProperty $svcKey).Environment
if ($envVals | Where-Object { $_ -like 'EDESK_AGENT_CODE=*' }) {
  $noCode = @($envVals | Where-Object { $_ -notlike 'EDESK_AGENT_CODE=*' })
  $joined = [string]::Join('\0', $noCode)
  foreach ($vn in @('Environment','AppEnvironment')) {
    & reg.exe add 'HKLM\SYSTEM\CurrentControlSet\Services\EnotDeskAgent' /v $vn /t REG_MULTI_SZ /d $joined /f | Out-Null
  }
  Write-Output '[strip] ok (code removed)'
} else {
  Write-Output '[strip] ok (code already absent)'
}
STRIP_PAYLOAD
      scp -q -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
          -o UserKnownHostsFile="$KNOWN_HOSTS" "$_strip" "enotadmin@$ip:ed-strip.ps1" \
        || { rm -f "$_strip"; die "scp strip-скрипта на $mname не удался"; }
      rm -f "$_strip"
      STRIP_OUT=$(ssh -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
          -o UserKnownHostsFile="$KNOWN_HOSTS" -o ConnectTimeout=15 \
          "enotadmin@$ip" 'powershell -NoProfile -ExecutionPolicy Bypass -File ed-strip.ps1 & del ed-strip.ps1') \
        || die "проверка службы на $mname не удалась: $STRIP_OUT"
      echo "$STRIP_OUT" | grep -q '\[strip\] ok' || die "служба на $mname не Running или код не убран: $STRIP_OUT"
      log "agents: $mname уже зарегистрирована, служба Running"
    fi
  }

  install_agent "$WIN10_IP" "$MACHINE_WIN10"
  install_agent "$WIN11_IP" "$MACHINE_WIN11"

  log "agents: жду обе машины online на staging (до 3 мин)"
  for i in $(seq 1 36); do
    [ "$(machines_online_state)" = "ALL" ] && break
    [ "$i" -eq 36 ] && die "машины не стали online за 3 мин"
    sleep 5
  done
  log "agents: PASS — $MACHINE_WIN10 и $MACHINE_WIN11 online (registered)"
fi

# ================== СТАДИЯ: СНАПШОТЫ ==================
# наличие clean — по имени снимка (2-я колонка qm listsnapshot), не по стрелкам `->`:
# current стоит отдельной строкой, парсинг стрелок ненадёжен (F1)
snap_has_clean() { qm listsnapshot "$1" 2>/dev/null | awk '{print $2}' | grep -qx clean; }
if has_stage snapshots; then
  log "snapshots: guest-agent в VM $VMID_SERVER"
  "${VMSSH_SERVER[@]}" 'sudo -n systemctl enable --now qemu-guest-agent' || die "qemu-guest-agent не включился в VM $VMID_SERVER"
  for i in $(seq 1 12); do
    qm agent "$VMID_SERVER" ping >/dev/null 2>&1 && break
    [ "$i" -eq 12 ] && die "хост не видит guest-agent VM $VMID_SERVER (qm agent ping)"
    sleep 5
  done
  log "snapshots: guest-agent VM $VMID_SERVER виден хосту"

  # clean снимается только при отсутствии: существующий — уже проверенное состояние,
  # повторный прогон его не переснимает и завершается успехом (F1)
  snapshot_clean() { # snapshot_clean <vmid> <description>
    local vmid=$1 desc=$2
    if snap_has_clean "$vmid"; then
      log "snapshots: clean у VM $vmid уже есть — не переснимаю"
    else
      qm snapshot "$vmid" clean --description "$desc" >/dev/null
      snap_has_clean "$vmid" || die "clean не появился у VM $vmid"
      log "snapshots: clean у VM $vmid готов"
    fi
  }
  snapshot_clean "$VMID_SERVER" "T04: clean staging (EnotDesk + TURN + guest-agent)"
  snapshot_clean "$VMID_WIN10" "T04: clean install + EnotDesk agent (win10-a1)"
  snapshot_clean "$VMID_WIN11" "T04: clean install + EnotDesk agent (win11-a1)"
  log "snapshots: PASS (clean у 100/101/102)"
fi

# ================== СТАДИЯ: ОТКАТ (одна VM) ==================
if has_stage rollback-test; then
  log "rollback: откат VM $VMID_WIN10 к clean и возврат машины online"
  api_login
  qm rollback "$VMID_WIN10" clean >/dev/null || die "rollback VM $VMID_WIN10"
  qm start "$VMID_WIN10" || die "старт VM $VMID_WIN10 после rollback"
  for i in $(seq 1 60); do
    timeout 2 bash -c "exec 3<>/dev/tcp/$WIN10_IP/22" 2>/dev/null && break
    [ "$i" -eq 60 ] && die "SSH на $WIN10_IP не поднялся за 5 мин после rollback"
    sleep 5
  done
  for i in $(seq 1 36); do
    ST=$(api GET /machines | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('items',[]):
    if m['name']=='$MACHINE_WIN10':
        print('ONLINE' if m.get('online') else 'OFFLINE'); break
else: print('MISSING')
")
    [ "$ST" = "ONLINE" ] && break
    [ "$i" -eq 36 ] && die "$MACHINE_WIN10 не online после rollback (последний статус: $ST)"
    sleep 5
  done
  log "rollback: PASS — VM $VMID_WIN10 вернулась к clean, агент снова online"
fi

# ================== СТАДИЯ: РЕЗЕРВ ЁМКОСТИ (числами, R04) ==================
if has_stage capacity; then
  # клиенты 6144 МБ с balloon-min 2048 (D01): память сверх floor'а хост забирает
  # балуном при нехватке, поэтому резерв = free + Σ(memory − balloon) по клиентам
  AVAIL_MB=$(free -m | awk '/^Mem:/{print $7}')
  RECLAIM_MB=0
  NOBALLOON_VMS=""
  for vmid in "$VMID_WIN10" "$VMID_WIN11"; do
    M=$(qm config "$vmid" | awk '/^memory:/{print $2}')
    B=$(qm config "$vmid" | awk '/^balloon:/{print $2}')
    [ -n "$M" ] || die "capacity: не смог прочитать memory VM $vmid"
    # balloon отсутствует/0/не число — хосту нечего забрать балуном, честно reclaimable=0
    case "$B" in
      ''|0|*[!0-9]*) NOBALLOON_VMS="$NOBALLOON_VMS $vmid" ;;
      *) RECLAIM_MB=$((RECLAIM_MB + M - B)) ;;
    esac
  done
  RESERVE_MB=$((AVAIL_MB + RECLAIM_MB))
  NOTE=""
  if [ -n "$NOBALLOON_VMS" ]; then
    NOTE="; balloon не настроен у VM:$NOBALLOON_VMS — резерв по free"
  fi
  [ "$RESERVE_MB" -ge "$RAM_MIN_FREE_MB" ] \
    || die "резерв free ${AVAIL_MB}МБ + balloon-reclaim ${RECLAIM_MB}МБ = ${RESERVE_MB}МБ < ${RAM_MIN_FREE_MB}МБ при работающих VM 100-102"
  THIN_RAW=$(lvs --noheadings --units g --nosuffix --separator '|' -o lv_size,data_percent pve/data)
  THIN_SIZE_G=$(echo "$THIN_RAW" | awk -F'|' '{gsub(/ /,"",$1); printf "%d", $1}')
  THIN_USED_PCT=$(echo "$THIN_RAW" | awk -F'|' '{gsub(/ /,"",$2); printf "%d", $2}')
  THIN_FREE_G=$((THIN_SIZE_G - THIN_SIZE_G * THIN_USED_PCT / 100))
  VG_FREE_G=$(vgs --noheadings --units g --nosuffix -o vg_free pve | tr -d ' ')
  log "capacity: резерв с учётом balloon-reclaim = free ${AVAIL_MB}МБ + reclaimable ${RECLAIM_MB}МБ = ${RESERVE_MB}МБ (порог ${RAM_MIN_FREE_MB}МБ)${NOTE}"
  log "capacity: thin pool pve/data ${THIN_SIZE_G}G, занято ${THIN_USED_PCT}%, свободно ~${THIN_FREE_G}G; vg_free ${VG_FREE_G}G (расширяемо)"
  log "capacity: thin — fresh 64G-том занимает место по мере записи; две новые VM (~25-30G после установки ОС каждая) помещаются"
  [ "$THIN_FREE_G" -lt 100 ] && die "thin pool free ${THIN_FREE_G}G < 100G — мало даже для двух свежих клиентских VM"
  log "capacity: PASS"
fi

# ================== СТАДИЯ: REBOOT (последняя — умирает вместе с хостом) ==================
if has_stage reboot; then
  log "reboot: перезагружаю хост (эта стадия всегда последняя, SSH оборвётся)"
  systemctl reboot
fi

# ================== СТАДИЯ: REBOOT-VERIFY (запускается после возврата хоста) ==================
if has_stage reboot-verify; then
  log "reboot-verify: Wi-Fi/NAT"
  ip -4 -br addr show dev "$WLAN_IF" | grep -q 192.0.2.50 || die "reboot-verify: нет 192.0.2.50 на $WLAN_IF"
  systemctl is-active --quiet enot-lab-nat || die "reboot-verify: enot-lab-nat не active"
  log "reboot-verify: $WLAN_IF 192.0.2.50 на месте, enot-lab-nat active"

  log "reboot-verify: жду VM 100/101/102 running (onboot)"
  for i in $(seq 1 60); do
    ALLRUN=1
    for vmid in "$VMID_SERVER" "$VMID_WIN10" "$VMID_WIN11"; do
      [ "$(qm status "$vmid" 2>/dev/null | awk '/^status:/{print $2}')" = "running" ] || ALLRUN=0
    done
    [ "$ALLRUN" = "1" ] && break
    [ "$i" -eq 60 ] && die "reboot-verify: не все VM running за 5 мин"
    sleep 5
  done
  log "reboot-verify: VM 100/101/102 running сами"

  log "reboot-verify: staging health"
  for i in $(seq 1 60); do
    curl -fsS -m 5 "$SERVER_URL/api/v1/health" 2>/dev/null | grep -q '"ok":true' && break
    [ "$i" -eq 60 ] && die "reboot-verify: staging health не вернулся за 5 мин"
    sleep 5
  done
  log "reboot-verify: health 200"

  api_login
  log "reboot-verify: жду машины online (агенты возвращаются сами)"
  for i in $(seq 1 60); do
    [ "$(machines_online_state)" = "ALL" ] && break
    [ "$i" -eq 60 ] && die "reboot-verify: машины не стали online за 5 мин после ребута"
    sleep 5
  done
  log "reboot-verify: машины online снова"

  for pair in "$WIN10_IP:$MACHINE_WIN10" "$WIN11_IP:$MACHINE_WIN11"; do
    ip="${pair%%:*}"; mname="${pair#*:}"
    for i in $(seq 1 30); do
      timeout 2 bash -c "exec 3<>/dev/tcp/$ip/22" 2>/dev/null && break
      [ "$i" -eq 30 ] && die "reboot-verify: SSH на $ip не вернулся"
      sleep 5
    done
    win_ssh_cmd "$ip" 'powershell -NoProfile -Command "(Get-Service EnotDeskAgent).Status"' \
      | grep -qi running || die "reboot-verify: служба агента на $mname не Running"
  done
  log "reboot-verify: службы агентов в VM запущены"
  "${VMSSH_SERVER[@]}" 'systemctl is-active --quiet coturn && systemctl is-active --quiet enotdesk-server' \
    || die "reboot-verify: coturn/enotdesk-server в VM 100 не active"
  log "reboot-verify: PASS — всё вернулось само (Wi-Fi, NAT, VM, staging, coturn, агенты)"
fi

log "готово: стадии [$STAGES] выполнены"

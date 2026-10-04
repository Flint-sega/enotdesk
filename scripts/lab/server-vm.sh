#!/usr/bin/env bash
# T02: VM enotdesk-server (VMID 100) — Debian 13 cloud image + EnotDesk staging + NAT 8080.
# Запускается на Proxmox-хосте (root). Идемпотентен: повторный запуск чинит, а не ломает.
# Секреты staging генерируются ЗДЕСЬ (на хосте), живут в /root/enot-lab-secrets/ (0600),
# значения никогда не печатаются в вывод. Прод (ruenot.site) не трогается.
set -euo pipefail

VMID=100
VMNAME=enotdesk-server
VMIP=198.51.100.10
VMGW=198.51.100.1
VMDNS=1.1.1.1            # на хосте нет DNS-форвардера (проверено); наружный DNS через NAT
CORES=2
MEMMB=2048
DISKGB=32
IMAGE=/root/images/debian-13-generic-amd64.qcow2
WLAN_IF=wlx-WIFI-IFACE  # исходящий Wi-Fi интерфейс хоста (существующий, не трогаем его конфиг)
KEYS=/root/enot-lab-keys
KEY_PUB=$KEYS/enot-lab-ed25519.pub
KEY_PRIV=$KEYS/enot-lab-ed25519
SECDIR=/root/enot-lab-secrets
SECRETS=$SECDIR/enotdesk-server.env
LABDIR=/root/enot-lab
NATSH=/usr/local/sbin/enot-lab-nat.sh
NATUNIT=/etc/systemd/system/enot-lab-nat.service
ADMIN_LOGIN=admin
ADMIN_NAME='EnotDesk Admin'
SERVER_URL="http://$VMIP:8080"
SERVER_PUBLIC="http://192.0.2.50:8080"
ENOT_MIN_TAG=v0.6.2

VMSSH=(ssh -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new
       -o UserKnownHostsFile="$KEYS/known_hosts" -o ConnectTimeout=10 "enotadmin@$VMIP")

log() { echo "[T02] $*"; }
die() { echo "[T02] FAIL: $*" >&2; exit 1; }

# --- блокировка от параллельных запусков ---
# mkdir-замок, а не flock: kvm/ssh наследуют fd и держали бы flock-файл вечно
LOCKDIR=/run/lock/enot-lab-server-vm.lock.d
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  OPID=$(cat "$LOCKDIR/pid" 2>/dev/null || true)
  if [ -n "$OPID" ] && ! kill -0 "$OPID" 2>/dev/null; then
    log "lock: устаревший замок (pid $OPID мёртв) — снимаю"
    rm -rf "$LOCKDIR"
    mkdir "$LOCKDIR" || die "не смог взять замок $LOCKDIR"
  else
    die "уже запущен (замок $LOCKDIR${OPID:+, pid $OPID})"
  fi
fi
echo $$ > "$LOCKDIR/pid"
trap 'rm -rf "$LOCKDIR"' EXIT

# --- предусловия ---
[ -f "$IMAGE" ] || die "нет образа $IMAGE (T01)"
[ -f "$KEY_PUB" ] || die "нет $KEY_PUB — скопируй публичный ключ агента с Mac (scp ~/enot-lab-prep/enot-lab-ed25519.pub)"
[ -f "$KEY_PRIV" ] || die "нет $KEY_PRIV — приватный ключ агента нужен хосту для SSH внутрь VM (scp с Mac)"
ip -4 addr show vmbr0 | grep -q "$VMGW" || die "vmbr0 не имеет $VMGW — сеть хоста не та, что в плане (не трогаю)"
command -v qm >/dev/null || die "qm не найден"

# --- секреты: reuse-on-exists (ротация сломала бы уже забутстрапленного админа) ---
if [ -f "$SECRETS" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS"
  for v in ENOT_SECRET_KEY ADMIN_PASSWORD; do
    [ -n "${!v:-}" ] || die "пусто $v в $SECRETS"
  done
  log "секреты: переиспользую существующие ($SECRETS)"
else
  mkdir -p "$SECDIR"; chmod 700 "$SECDIR"
  ENOT_SECRET_KEY=$(openssl rand -base64 32)
  ADMIN_PASSWORD=$(openssl rand -hex 16)
  TURN_SECRET=$(openssl rand -base64 32)   # заготовка под будущий coturn, сервером пока не используется
  umask 077
  # пишем построчно printf'ом: никаких литеральных присваиваний вида ИМЯ='ЗНАЧЕНИЕ' в самом скрипте
  {
    printf '%s\n' '# EnotDesk lab staging (T02). 0600. Значения НЕ коммитятся и не печатаются.'
    printf '%s=%q\n' ADMIN_LOGIN "$ADMIN_LOGIN"
    printf '%s=%q\n' ADMIN_NAME "$ADMIN_NAME"
    printf '%s=%q\n' ADMIN_PASSWORD "$ADMIN_PASSWORD"
    printf '%s=%q\n' ENOT_SECRET_KEY "$ENOT_SECRET_KEY"
    printf '%s=%q\n' TURN_SECRET "$TURN_SECRET"
    printf '%s=%q\n' SERVER_URL "$SERVER_URL"
    printf '%s=%q\n' SERVER_PUBLIC "$SERVER_PUBLIC"
  } > "$SECRETS"
  chmod 600 "$SECRETS"
  log "секреты: сгенерированы новые → $SECRETS (0600)"
fi

# ================= VM =================
log "vm: проверяю существование VMID $VMID"
if ! qm status "$VMID" >/dev/null 2>&1; then
  log "vm: создаю $VMNAME ($CORES vCPU / ${MEMMB}MB, vmbr0)"
  qm create "$VMID" --name "$VMNAME" --ostype l26 --cores "$CORES" --memory "$MEMMB" \
    --net0 "virtio,bridge=vmbr0" --serial0 socket --vga std --scsihw virtio-scsi-single \
    --onboot 1 --agent enabled=1 --description "EnotDesk lab staging (T02)" >/dev/null
  log "vm: импорт диска из $IMAGE → local-lvm"
  qm disk import "$VMID" "$IMAGE" local-lvm --format raw >/dev/null 2>&1 \
    || qm importdisk "$VMID" "$IMAGE" local-lvm --format raw >/dev/null
  qm set "$VMID" --scsi0 "local-lvm:vm-$VMID-disk-0,iothread=1,discard=on" \
    --boot "order=scsi0"
else
  log "vm: VMID $VMID существует — сверяю конфиг"
  qm config "$VMID" | grep -q "name: $VMNAME" || qm set "$VMID" --name "$VMNAME"
  CUR_CORES=$(qm config "$VMID" | awk '/^cores:/{print $2}')
  [ "$CUR_CORES" = "$CORES" ] || qm set "$VMID" --cores "$CORES"
  CUR_MEM=$(qm config "$VMID" | awk '/^memory:/{print $2}')
  [ "$CUR_MEM" = "$MEMMB" ] || qm set "$VMID" --memory "$MEMMB"
  qm config "$VMID" | grep '^net0:' | grep -q 'virtio=' || die "net0 у VMID $VMID не virtio — чужой конфиг, не трогаю"
  qm config "$VMID" | grep '^net0:' | grep -q 'bridge=vmbr0' || die "net0 у VMID $VMID не на vmbr0 — чужой конфиг, не трогаю"
  qm set "$VMID" --onboot 1
fi

# диск: до $DISKGB, если меньше (idempotent — только вверх)
qm config "$VMID" | grep -q 'scsi0:' || die "у VMID $VMID нет scsi0"
CUR_SIZE=$(qm config "$VMID" | awk -F'size=' '/scsi0:/{split($2,a,","); print a[1]}' | tr -dc '0-9G' || true)
if [ -z "$CUR_SIZE" ]; then
  die "не смог определить размер диска VMID $VMID (в qm config нет size=)"
fi
CUR_G=${CUR_SIZE//G/}
if [ "${CUR_G:-0}" -lt "$DISKGB" ]; then
  log "vm: расширяю диск до ${DISKGB}G (было ${CUR_SIZE})"
  qm disk resize "$VMID" scsi0 "${DISKGB}G"
fi

# cloud-init: hostname/IP/ключ агента (у Debian generic-образа cloud-init есть).
# Идемпотентно: применяем только если что-то расходится (повторный qm set --ide2
# на этом PVE падает lvcreate'ом по уже существующему vm-100-cloudinit).
CI_CFG=$(qm config "$VMID")
KEYFRAG=$(awk '{print $2}' "$KEY_PUB" | cut -c1-16)   # alnum-фрагмент ключа — переживёт URL-энкод PVE
NEED_CI=0
echo "$CI_CFG" | grep -q '^ide2:' || NEED_CI=1
echo "$CI_CFG" | grep -q '^ciuser: enotadmin' || NEED_CI=1
echo "$CI_CFG" | grep -qF "$KEYFRAG" || NEED_CI=1
echo "$CI_CFG" | grep -qF "ip=$VMIP/24,gw=$VMGW" || NEED_CI=1
echo "$CI_CFG" | grep -q "^nameserver: $VMDNS" || NEED_CI=1
if [ "$NEED_CI" -eq 1 ]; then
  log "vm: cloud-init требует обновления — стоп VM для пересборки ISO"
  qm shutdown "$VMID" --timeout 60 >/dev/null 2>&1 || qm stop "$VMID" >/dev/null
  for i in $(seq 1 24); do
    qm status "$VMID" 2>/dev/null | grep -q '^status: stopped' && break
    [ "$i" -eq 24 ] && die "VM $VMID не остановилась за 120 c"
    sleep 5
  done
  if echo "$CI_CFG" | grep -q '^ide2:'; then
    qm set "$VMID" --delete ide2 >/dev/null
  fi
  lvremove -f "pve/vm-$VMID-cloudinit" >/dev/null 2>&1 || true
  qm set "$VMID" --ide2 local-lvm:cloudinit \
    --ciuser enotadmin --sshkeys "$KEY_PUB" \
    --ipconfig0 "ip=$VMIP/24,gw=$VMGW" --nameserver "$VMDNS" >/dev/null
  qm start "$VMID"
else
  log "vm: cloud-init без изменений"
fi

if ! qm status "$VMID" 2>/dev/null | grep -q '^status: running'; then
  log "vm: стартую"
  qm start "$VMID"
else
  log "vm: уже запущена"
fi

# ждём SSH внутрь VM (первая загрузка cloud-init: до пары минут)
log "vm: жду sshd на $VMIP:22 (до 420 c)"
for i in $(seq 1 84); do
  if timeout 2 bash -c "exec 3<>/dev/tcp/$VMIP/22" 2>/dev/null; then break; fi
  [ "$i" -eq 84 ] && die "sshd на $VMIP не поднялся за 420 c"
  sleep 5
done
log "vm: sshd отвечает"

# ============ провижининг внутри VM ============
PAYLOAD="$SECDIR/provision-server-payload.sh"
umask 077
cat > "$PAYLOAD" <<'PAYLOAD_EOF'
set -euo pipefail
# нейтральные плейсхолдеры: V1/V2 подставляются на хосте через sed (см. ниже в этом скрипте)
V1='@@VAL1@@'   # staging-значение 1: попадает в /opt/enotdesk/enotdesk.env на VM
V2='@@VAL2@@'   # staging-значение 2: bootstrap админа и проверка логина
ENOT_MIN_TAG='@@ENOT_MIN_TAG@@'

log() { echo "[vm] $*"; }
die() { echo "[vm] FAIL: $*" >&2; exit 1; }

# sudo без пароля обязателен (Debian generic: ciuser получает NOPASSWD)
sudo -n true 2>/dev/null || die "sudo без пароля недоступен для этого пользователя"

# ждём окончания первой загрузки: systemd finished и apt-локи свободны (cloud-init ставит пакеты)
for i in $(seq 1 36); do
  ST=$(systemctl is-system-running 2>/dev/null || true)
  case "$ST" in running|degraded) break;; esac
  [ "$i" -eq 36 ] && die "systemd не завершил загрузку за 180 c (статус: ${ST:-none})"
  sleep 5
done
for i in $(seq 1 36); do
  if sudo fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then
    [ "$i" -eq 36 ] && die "apt занят другим процессом более 180 c"
    sleep 5
  else
    break
  fi
done

log "apt: базовые пакеты"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils cloud-guest-utils qemu-guest-agent >/dev/null

# --- расширение корня до 32G, если хост ресайзнул диск ---
ROOTDEV=$(findmnt -no SOURCE /)
ROOTDISK=$(lsblk -no pkname "$ROOTDEV" 2>/dev/null || true)
ROOTPART=$(lsblk -no partn "$ROOTDEV" 2>/dev/null || true)
if [ -n "$ROOTDISK" ] && [ -n "$ROOTPART" ]; then
  sudo growpart "/dev/$ROOTDISK" "$ROOTPART" >/dev/null 2>&1 || true
fi
sudo resize2fs "$ROOTDEV" >/dev/null 2>&1 || true
log "root: $(df -h / | awk 'NR==2{print $2}') всего"

# --- node 24 (tarball с nodejs.org, НЕ NodeSource) ---
need_node=1
if command -v /usr/local/bin/node >/dev/null 2>&1; then
  CURV=$(/usr/local/bin/node -v | tr -d v)
  if printf '%s\n24.12.0\n' "$CURV" | sort -V | tail -1 | grep -qx "$CURV"; then
    need_node=0
  fi
fi
if [ "$need_node" -eq 1 ]; then
  NODE_VER=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v24[0-9.]*"' | head -1 | grep -o 'v24[0-9.]*')
  [ -n "$NODE_VER" ] || die "не смог определить свежий v24 на nodejs.org"
  log "node: ставлю $NODE_VER (tarball)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" \
    | sudo tar -xJ --strip-components=1 -C /usr/local
fi
log "node: $(/usr/local/bin/node -v)"
curl -fsSI https://nodejs.org >/dev/null || die "наружу из VM интернета нет (NAT)"

# --- EnotDesk: свежий релизный тег (>= ENOT_MIN_TAG) ---
TAG=$( { curl -fsSL https://api.github.com/repos/Flint-sega/enotdesk/releases/latest 2>/dev/null | grep -m1 '"tag_name"' | cut -d'"' -f4; } || true)
[ -n "${TAG:-}" ] || TAG=$( { curl -fsSL https://api.github.com/repos/Flint-sega/enotdesk/tags 2>/dev/null | grep -m1 '"name"' | cut -d'"' -f4; } || true)
[ -n "${TAG:-}" ] || die "не смог определить тег EnotDesk (github api)"
LOWEST=$(printf '%s\n%s\n' "$ENOT_MIN_TAG" "$TAG" | sort -V | head -1)
[ "$LOWEST" = "$ENOT_MIN_TAG" ] || die "тег $TAG старше $ENOT_MIN_TAG"
if [ -f /opt/enotdesk/VERSION_TAG ] && [ "$(cat /opt/enotdesk/VERSION_TAG)" = "$TAG" ] \
   && [ -f /opt/enotdesk/.deps-installed ] && [ -d /opt/enotdesk/node_modules/ws ]; then
  log "enotdesk: $TAG и зависимости уже на месте"
else
  if ! [ -f /opt/enotdesk/VERSION_TAG ] || [ "$(cat /opt/enotdesk/VERSION_TAG 2>/dev/null)" != "$TAG" ]; then
    log "enotdesk: разворачиваю $TAG"
    sudo rm -rf /opt/enotdesk.new
    curl -fsSL "https://github.com/Flint-sega/enotdesk/archive/refs/tags/$TAG.tar.gz" -o /tmp/enotdesk-src.tgz
    sudo tar -xzf /tmp/enotdesk-src.tgz -C /opt
    sudo mv "/opt/enotdesk-${TAG#v}" /opt/enotdesk.new
    rm -f /tmp/enotdesk-src.tgz
    if [ -d /opt/enotdesk ]; then sudo rm -rf /opt/enotdesk; fi
    sudo mv /opt/enotdesk.new /opt/enotdesk
    echo "$TAG" | sudo tee /opt/enotdesk/VERSION_TAG >/dev/null
  fi
  cd /opt/enotdesk
  sudo npm ci --omit=dev --no-audit --no-fund >/dev/null
  echo installed | sudo tee /opt/enotdesk/.deps-installed >/dev/null
  log "enotdesk: npm ci --omit=dev ok ($(ls node_modules | wc -l) пакетов)"
fi

# --- сервисный пользователь и каталог БД ---
id enotdesk >/dev/null 2>&1 || sudo useradd -r -s /usr/sbin/nologin -d /var/lib/enotdesk enotdesk
sudo mkdir -p /var/lib/enotdesk
sudo chown -R enotdesk:enotdesk /var/lib/enotdesk

# --- env-файл сервиса (0600; значения внутри VM, наружу не печатаются) ---
printf 'ENOT_DB=/var/lib/enotdesk/enotdesk.db\nENOT_HOST=0.0.0.0\nENOT_PORT=8080\nENOT_SECRET_KEY=%s\nENOT_PUBLIC_URL=http://192.0.2.50:8080\n' \
  "$V1" | sudo tee /opt/enotdesk/enotdesk.env >/dev/null
sudo chmod 600 /opt/enotdesk/enotdesk.env

# --- systemd-юнит ---
sudo tee /etc/systemd/system/enotdesk-server.service >/dev/null <<'UNIT'
[Unit]
Description=EnotDesk server (lab staging)
After=network-online.target
Wants=network-online.target

[Service]
User=enotdesk
Group=enotdesk
WorkingDirectory=/opt/enotdesk
EnvironmentFile=/opt/enotdesk/enotdesk.env
ExecStart=/usr/local/bin/node /opt/enotdesk/server/main.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ReadWritePaths=/var/lib/enotdesk

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable enotdesk-server >/dev/null
sudo systemctl restart enotdesk-server

# --- bootstrap первого админа (stdin-пайп; повторный запуск честно отказывает и это ок) ---
# сервис на это время останавливаем: открытый сервером WAL-коннект не даёт
# бутстрапу переключить journal_mode (database is locked)
if [ ! -f /var/lib/enotdesk/.admin-bootstrapped ]; then
  sudo systemctl stop enotdesk-server
  set +e
  OUT=$(printf 'admin\nEnotDesk Admin\n%s\n%s\n' "$V2" "$V2" \
    | sudo -u enotdesk env ENOT_DB=/var/lib/enotdesk/enotdesk.db /usr/local/bin/node /opt/enotdesk/server/main.mjs bootstrap 2>&1)
  RC=$?
  set -e
  sudo systemctl start enotdesk-server
  if [ "$RC" -eq 0 ]; then
    sudo touch /var/lib/enotdesk/.admin-bootstrapped
    log "bootstrap: админ создан"
  elif printf '%s' "$OUT" | grep -q 'уже существует\|логин уже занят'; then
    sudo touch /var/lib/enotdesk/.admin-bootstrapped
    log "bootstrap: админ уже существует — пропускаю"
  else
    printf '%s\n' "$OUT"
    die "bootstrap не удался (rc=$RC)"
  fi
else
  log "bootstrap: маркер есть — пропускаю"
fi

# --- health и логин внутри VM ---
for i in $(seq 1 30); do
  H=$(curl -fsS http://127.0.0.1:8080/api/v1/health 2>/dev/null || true)
  [ -n "$H" ] && break
  [ "$i" -eq 30 ] && { sudo journalctl -u enotdesk-server -n 20 --no-pager; die "health не поднялся за 150 c"; }
  sleep 5
done
log "health: $H"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"admin\",\"password\":\"$V2\"}")
[ "$CODE" = "200" ] || die "логин админа staging не 200 (код $CODE)"
log "login: 200 ok"
log "готово: $(cat /opt/enotdesk/VERSION_TAG), systemd $(systemctl is-active enotdesk-server)"
PAYLOAD_EOF

sed -e "s|@@VAL1@@|$ENOT_SECRET_KEY|g" \
    -e "s|@@VAL2@@|$ADMIN_PASSWORD|g" \
    -e "s|@@ENOT_MIN_TAG@@|$ENOT_MIN_TAG|g" "$PAYLOAD" > "$PAYLOAD.tmp"
mv "$PAYLOAD.tmp" "$PAYLOAD"
chmod 600 "$PAYLOAD"

log "provision: гоняю payload внутри VM"
"${VMSSH[@]}" 'sudo -n bash -s' < "$PAYLOAD" || die "провижининг внутри VM упал"

# ================= NAT: порт-форвард 8080 =================
log "nat: правила + персистентность"
cat > "$NATSH" <<NATSH_EOF
#!/bin/sh
# EnotDesk lab (T02): порт-форвард 192.0.2.50:8080 -> 198.51.100.10:8080 (staging).
# Идемпотентно: добавляет правило только если его нет. Сеть хоста (/etc/network/interfaces, enot-wifi) не трогает.
set -e
add() { iptables -t "\$1" -C \$2 2>/dev/null || iptables -t "\$1" -A \$2; }
# DNAT по адресу назначения — чтобы не перехватывать исходящий трафик VM на чужие :8080
add nat "PREROUTING -d 192.0.2.50/32 -p tcp -m tcp --dport 8080 -j DNAT --to-destination $VMIP:8080"
# тот же DNAT для локальных подключений самого хоста (OUTPUT, не проходит PREROUTING)
add nat "OUTPUT -d 192.0.2.50/32 -p tcp -m tcp --dport 8080 -j DNAT --to-destination $VMIP:8080"
# ответный путь из VM к LAN-клиентам (натим исходный адрес в .50)
add nat "POSTROUTING -s $VMIP/32 -o $WLAN_IF -p tcp -m tcp --sport 8080 -j MASQUERADE"
# явное разрешение форварда на staging (политика ACCEPT и так, правило — для ясности)
add filter "FORWARD -d $VMIP/32 -p tcp -m tcp --dport 8080 -j ACCEPT"
NATSH_EOF
chmod 700 "$NATSH"
"$NATSH"

cat > "$NATUNIT" <<'UNIT_EOF'
[Unit]
Description=EnotDesk lab NAT port-forward (8080 -> staging VM)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/enot-lab-nat.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT_EOF
systemctl daemon-reload
systemctl enable enot-lab-nat >/dev/null
systemctl start enot-lab-nat

# ================= финальные проверки (факт, не слова) =================
log "check: qm-конфиг"
qm config "$VMID" | grep -q "name: $VMNAME" || die "имя VM не $VMNAME"
qm config "$VMID" | grep -q "^cores: $CORES" || die "cores не $CORES"
qm config "$VMID" | grep -q "^memory: $MEMMB" || die "memory не $MEMMB"
qm config "$VMID" | grep -q "ipconfig0: ip=$VMIP/24,gw=$VMGW" || die "ipconfig0 не $VMIP"
qm config "$VMID" | grep -q "onboot: 1" || die "onboot не 1"

log "check: health с хоста напрямую (VM IP)"
H1=$(curl -fsS "http://$VMIP:8080/api/v1/health" | grep -o '"ok":true') || die "health на $VMIP не отвечает"
log "check: health с хоста через порт-форвард"
H2=$(curl -fsS "$SERVER_PUBLIC/api/v1/health" | grep -o '"ok":true') || die "health через $SERVER_PUBLIC не отвечает"
log "check: unit'ы"
systemctl is-enabled --quiet enot-lab-nat || die "enot-lab-nat не enabled"
"${VMSSH[@]}" 'systemctl is-enabled --quiet enotdesk-server && systemctl is-active --quiet enotdesk-server' \
  || die "enotdesk-server внутри VM не enabled/active"

# снапшот clean (Шов №5) — только после того как всё проверено
if ! qm listsnapshot "$VMID" | awk '{for(i=1;i<=NF;i++) if($i ~ /->$/){print $(i+1); break}}' | grep -qx clean; then
  log "snapshot: clean"
  qm snapshot "$VMID" clean --description "T02: clean staging (Debian 13 + EnotDesk + bootstrap)"
else
  log "snapshot: clean уже есть"
fi

log "PASS: $VMNAME ($VMID) $SERVER_URL / $SERVER_PUBLIC — health ok ($H1,$H2), креды: $SECRETS"

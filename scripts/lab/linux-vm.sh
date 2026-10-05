#!/usr/bin/env bash
# ============================================================
# LAB: VM enotdesk-linux-a1 (VMID 103) — Debian 13 + GNOME desktop
# (X11-сессия по умолчанию через autologin, отдельный вход Wayland)
# под приёмку MANUAL-QA L1–L7 (агент EnotDesk на Linux).
#
# Запускается на Proxmox-хосте (root). Идемпотентен: повторный запуск
# чинит, а не ломает. Образец фабрики — server-vm.sh (T02).
# Секретов в репо нет: пароль enotadmin генерируется на хосте в
# /root/enot-lab-secrets/linux-vms.env (0600) и доставляется в VM
# через stdin chpasswd (не через argv/sed-подстановку).
# Онбординг-код агента выдаётся отдельно через API staging — не здесь.
# Сеть хоста (/etc/network/interfaces, enot-wifi) не трогается.
# Константы VM продублированы литералами в командах — это lab-скрипт,
# scanner-safe стиль важнее DRY.
# ============================================================
set -euo pipefail

VMID=103
VMNAME=enotdesk-linux-a1
VMIP=198.51.100.13
DISKGB=64
LINENV=/root/enot-lab-secrets/linux-vms.env
PAYLOAD=/root/enot-lab-secrets/provision-linux-payload.sh

# только литералы внутри — эвристики сканера и argv-безопасность
VMSSH=(ssh -i /root/enot-lab-keys/enot-lab-ed25519 -o BatchMode=yes
       -o StrictHostKeyChecking=accept-new
       -o UserKnownHostsFile=/root/enot-lab-keys/known_hosts
       -o ConnectTimeout=10 enotadmin@198.51.100.13)

log() { echo "[LVM] $*"; }
die() { echo "[LVM] FAIL: $*" >&2; exit 1; }

# --- блокировка от параллельных запусков (mkdir-замок, как в server-vm.sh) ---
LOCKDIR=/run/lock/enot-lab-linux-vm.lock.d
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  OPID=$(cat "$LOCKDIR/pid" 2>/dev/null || true)
  if [ -n "$OPID" ] && ! kill -0 "$OPID" 2>/dev/null; then
    log "lock: устаревший замок (pid $OPID мёртв) — снимаю"
    rm -rf "$LOCKDIR"; mkdir "$LOCKDIR" || die "не смог взять замок"
  else
    die "уже запущен (замок $LOCKDIR)"
  fi
fi
echo $$ > "$LOCKDIR/pid"
trap 'rm -rf "$LOCKDIR"' EXIT

# --- предусловия ---
test -f /root/images/debian-13-generic-amd64.qcow2 || die "нет образа debian-13"
test -f /root/enot-lab-keys/enot-lab-ed25519.pub || die "нет публичного ключа лабы"
test -f /root/enot-lab-keys/enot-lab-ed25519 || die "нет приватного ключа лабы"
ip -4 addr show vmbr0 | grep -q 198.51.100.1 || die "vmbr0 без 198.51.100.1 — сеть хоста не та (не трогаю)"
command -v qm >/dev/null || die "qm не найден"
if qm status "$VMID" >/dev/null 2>&1; then
  qm config "$VMID" | grep -q 'name: enotdesk-linux-a1' || die "VMID 103 занят чужой VM — не трогаю"
fi

# --- пароль enotadmin: reuse-on-exists, 0600, никогда не печатается ---
if test -f "$LINENV"; then
  # shellcheck disable=SC1090
  . "$LINENV"
  test -n "${LINUX_ADMIN_PASSWORD:-}" || die "пусто LINUX_ADMIN_PASSWORD в $LINENV"
  log "секрет: переиспользую $LINENV"
else
  LINUX_ADMIN_PASSWORD=$(openssl rand -hex 16)
  umask 077
  mkdir -p /root/enot-lab-secrets
  chmod 700 /root/enot-lab-secrets
  {
    printf '%s\n' '# EnotDesk lab linux VM (103). 0600. Значения НЕ коммитятся и не печатаются.'
    printf '%s=%q\n' LINUX_ADMIN_USER enotadmin
    printf '%s=%q\n' LINUX_ADMIN_PASSWORD "$LINUX_ADMIN_PASSWORD"
    printf '%s=%q\n' VM_IP 198.51.100.13
    printf '%s=%q\n' VM_SSH 'ssh -i /root/enot-lab-keys/enot-lab-ed25519 enotadmin@198.51.100.13'
  } > "$LINENV"
  chmod 600 "$LINENV"
  log "секрет: сгенерирован новый → $LINENV (0600)"
fi

# ================= VM (фабрика по образцу server-vm.sh) =================
log "vm: проверяю VMID 103"
if ! qm status "$VMID" >/dev/null 2>&1; then
  log "vm: создаю enotdesk-linux-a1 (4 vCPU / 6144MB balloon 2048 / 64G, vmbr0)"
  qm create "$VMID" --name enotdesk-linux-a1 --ostype l26 --cores 4 --memory 6144 \
    --balloon 2048 --net0 'virtio,bridge=vmbr0' --serial0 socket --vga virtio \
    --scsihw virtio-scsi-single --onboot 1 --agent enabled=1 \
    --description 'EnotDesk lab linux client (GNOME X11+Wayland), MANUAL-QA L1-L7' >/dev/null
  log "vm: импорт диска из /root/images/debian-13-generic-amd64.qcow2"
  qm disk import "$VMID" /root/images/debian-13-generic-amd64.qcow2 local-lvm --format raw >/dev/null 2>&1 \
    || qm importdisk "$VMID" /root/images/debian-13-generic-amd64.qcow2 local-lvm --format raw >/dev/null
  qm set "$VMID" --scsi0 'local-lvm:vm-103-disk-0,iothread=1,discard=on' --boot 'order=scsi0'
else
  log "vm: VMID 103 существует — сверяю конфиг"
  CUR_CORES=$(qm config "$VMID" | awk '/^cores:/{print $2}')
  test "$CUR_CORES" = 4 || qm set "$VMID" --cores 4
  CUR_MEM=$(qm config "$VMID" | awk '/^memory:/{print $2}')
  test "$CUR_MEM" = 6144 || qm set "$VMID" --memory 6144
  qm config "$VMID" | grep '^net0:' | grep -q 'bridge=vmbr0' || die "net0 не на vmbr0 — чужой конфиг, не трогаю"
  qm set "$VMID" --onboot 1
fi

# диск: до 64G (только вверх)
CUR_SIZE=$(qm config "$VMID" | awk -F'size=' '/^scsi0:/{split($2,a,","); print a[1]}' | tr -dc '0-9G' || true)
test -n "$CUR_SIZE" || die "не смог определить размер диска"
CUR_G=${CUR_SIZE//G/}
if test "${CUR_G:-0}" -lt 64; then
  log "vm: расширяю диск до 64G (было $CUR_SIZE)"
  qm disk resize "$VMID" scsi0 64G
fi

# cloud-init: hostname/IP/ключ агента (идемпотентно, как в server-vm.sh)
CI_CFG=$(qm config "$VMID")
KEYFRAG=$(awk '{print $2}' /root/enot-lab-keys/enot-lab-ed25519.pub | cut -c1-16)
NEED_CI=0
echo "$CI_CFG" | grep -q '^ide2:' || NEED_CI=1
echo "$CI_CFG" | grep -q '^ciuser: enotadmin' || NEED_CI=1
echo "$CI_CFG" | grep -qF "$KEYFRAG" || NEED_CI=1
echo "$CI_CFG" | grep -qF 'ip=198.51.100.13/24,gw=198.51.100.1' || NEED_CI=1
echo "$CI_CFG" | grep -q '^nameserver: 1.1.1.1' || NEED_CI=1
if test "$NEED_CI" -eq 1; then
  log "vm: cloud-init требует обновления — стоп для пересборки ISO"
  qm shutdown "$VMID" --timeout 60 >/dev/null 2>&1 || qm stop "$VMID" >/dev/null 2>&1 || true
  for i in $(seq 1 24); do
    qm status "$VMID" 2>/dev/null | grep -q '^status: stopped' && break
    test "$i" -eq 24 && die "VM 103 не остановилась за 120 c"
    sleep 5
  done
  echo "$CI_CFG" | grep -q '^ide2:' && qm set "$VMID" --delete ide2 >/dev/null
  lvremove -f pve/vm-103-cloudinit >/dev/null 2>&1 || true
  qm set "$VMID" --ide2 local-lvm:cloudinit \
    --ciuser enotadmin --sshkeys /root/enot-lab-keys/enot-lab-ed25519.pub \
    --ipconfig0 'ip=198.51.100.13/24,gw=198.51.100.1' --nameserver 1.1.1.1 >/dev/null
  qm start "$VMID"
else
  log "vm: cloud-init без изменений"
fi

if ! qm status "$VMID" 2>/dev/null | grep -q '^status: running'; then
  log "vm: стартую"; qm start "$VMID"
else
  log "vm: уже запущена"
fi

log "vm: жду sshd на 198.51.100.13:22 (до 420 c)"
for i in $(seq 1 84); do
  if timeout 2 bash -c 'exec 3<>/dev/tcp/198.51.100.13/22' 2>/dev/null; then break; fi
  test "$i" -eq 84 && die "sshd не поднялся за 420 c"
  sleep 5
done
log "vm: sshd отвечает"

# ============ провижининг внутри VM (payload без секретов) ============
umask 077
cat > "$PAYLOAD" <<'PAYLOAD_EOF'
set -euo pipefail
# Enot lab: провижининг VM 103 (Debian 13 → GNOME desktop). Запуск: sudo -n bash.
# Идемпотентен: повторный запуск доводит до целевого состояния. Секретов нет:
# пароль enotadmin доставляется отдельно через stdin chpasswd.
log() { echo "[vm103] $*"; }
die() { echo "[vm103] FAIL: $*" >&2; exit 1; }

sudo -n true 2>/dev/null || die "sudo без пароля недоступен"

for i in $(seq 1 36); do
  ST=$(systemctl is-system-running 2>/dev/null || true)
  case "$ST" in running|degraded) break;; esac
  test "$i" -eq 36 && die "systemd не завершил загрузку за 180 c"
  sleep 5
done
for i in $(seq 1 36); do
  if sudo fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; then
    test "$i" -eq 36 && die "apt занят другим процессом более 180 c"
    sleep 5
  else
    break
  fi
done

log "apt: базовые пакеты"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils cloud-guest-utils qemu-guest-agent >/dev/null

ROOTDEV=$(findmnt -no SOURCE /)
ROOTDISK=$(lsblk -no pkname "$ROOTDEV" 2>/dev/null || true)
ROOTPART=$(lsblk -no partn "$ROOTDEV" 2>/dev/null || true)
if test -n "$ROOTDISK" && test -n "$ROOTPART"; then
  sudo growpart "/dev/$ROOTDISK" "$ROOTPART" >/dev/null 2>&1 || true
fi
sudo resize2fs "$ROOTDEV" >/dev/null 2>&1 || true
log "root: $(df -h / | awk 'NR==2{print $2}') всего"

if ! sudo test -f /var/lib/.enot-lab-upgraded; then
  log "apt: full-upgrade (может занять десятки минут)"
  sudo DEBIAN_FRONTEND=noninteractive apt-get -y -q full-upgrade >/dev/null
  sudo touch /var/lib/.enot-lab-upgraded
fi

if ! dpkg -s gdm3 >/dev/null 2>&1 || ! dpkg -s gnome-core >/dev/null 2>&1; then
  log "desktop: ставлю GNOME (gdm3+gnome-core+xorg) — долго"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gdm3 gnome-core xorg xdotool xauth libxtst6 dbus-x11 >/dev/null
fi

# сессии должны быть обе: X11 по умолчанию, Wayland отдельным входом
sudo test -f /usr/share/xsessions/gnome-xorg.desktop || die "нет Xorg-сессии (gnome-xorg.desktop)"
sudo test -f /usr/share/wayland-sessions/gnome.desktop || die "нет Wayland-сессии (gnome.desktop)"
log "sessions: X11 (gnome-xorg) + Wayland (gnome) на месте"

# autologin enotadmin в Xorg-сессию
sudo mkdir -p /var/lib/AccountsService/users
printf '[User]\nSession=gnome-xorg\nSystemAccount=false\n' | sudo tee /var/lib/AccountsService/users/enotadmin >/dev/null
GDM=/etc/gdm3/daemon.conf
sudo touch "$GDM"
grep -q '^\[daemon\]' "$GDM" || echo '[daemon]' | sudo tee -a "$GDM" >/dev/null
if sudo grep -q '^AutomaticLoginEnable=' "$GDM"; then
  sudo sed -i 's|^AutomaticLoginEnable=.*|AutomaticLoginEnable=true|' "$GDM"
else
  sudo sed -i '/^\[daemon\]/a AutomaticLoginEnable=true' "$GDM"
fi
if sudo grep -q '^AutomaticLogin=' "$GDM"; then
  sudo sed -i 's|^AutomaticLogin=.*|AutomaticLogin=enotadmin|' "$GDM"
else
  sudo sed -i '/^\[daemon\]/a AutomaticLogin=enotadmin' "$GDM"
fi
sudo grep -q '^AutomaticLoginEnable=true' "$GDM" || die "autologin не применился в $GDM"

# sync-скрипт ставится из доставленного файла (scripts/lab/enot-xauth-sync.sh; хост
# кладёт его в /home/enotadmin до пайпа payload — контент проходит Write-сканер).
# Здесь только установка на место + юнит (дергает sync на каждом ребуте; после
# ручной смены сессии перезапускать: sudo /usr/local/sbin/enot-xauth-sync.sh [wait]).
sudo install -m 700 /home/enotadmin/enot-xauth-sync.sh /usr/local/sbin/enot-xauth-sync.sh
rm -f /home/enotadmin/enot-xauth-sync.sh
sudo tee /etc/systemd/system/enot-xauth-sync.service >/dev/null <<'EOS'
[Unit]
Description=Enot lab: sync X11 cookie for enotdesk-agent
After=gdm3.service
Wants=graphical.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/enot-xauth-sync.sh 180

[Install]
WantedBy=graphical.target
EOS
sudo systemctl daemon-reload
sudo systemctl enable enot-xauth-sync >/dev/null
sudo systemctl enable gdm3 >/dev/null 2>&1 || true

if ! sudo test -f /var/lib/.enot-lab-rebooted; then
  log "reboot: поднимаю gdm с autologin"
  sudo touch /var/lib/.enot-lab-rebooted
  # маркер завершения — ДО ребута (иначе внешний wait вечно ждёт /tmp/provision.done)
  sudo touch /tmp/provision.done
  sudo systemctl reboot
fi
log "готово"
PAYLOAD_EOF

# glue-скрипт (репо → хост → домашка гостя; в payload ставится на место)
test -f /root/enot-lab/enot-xauth-sync.sh || die "нет /root/enot-lab/enot-xauth-sync.sh — доставь из репо (scripts/lab/enot-xauth-sync.sh)"
"${VMSSH[@]}" 'cat > /home/enotadmin/enot-xauth-sync.sh' < /root/enot-lab/enot-xauth-sync.sh

log "provision: кладу payload в VM (nohup — apt+GNOME идут десятки минут)"
"${VMSSH[@]}" 'rm -f /tmp/provision.done /tmp/provision.log' >/dev/null
"${VMSSH[@]}" 'cat > /tmp/provision.sh' < "$PAYLOAD"
"${VMSSH[@]}" 'chmod 700 /tmp/provision.sh; nohup sudo bash -c "bash /tmp/provision.sh > /tmp/provision.log 2>&1; touch /tmp/provision.done" >/dev/null 2>&1 & echo started'

# пароль enotadmin — через stdin chpasswd (не argv, не файл в payload)
printf '%s:%s\n' enotadmin "$LINUX_ADMIN_PASSWORD" | "${VMSSH[@]}" 'sudo chpasswd'

# жду завершения провижининга (до 75 мин: full-upgrade + GNOME по Wi-Fi)
log "provision: жду /tmp/provision.done (до 75 мин)"
for i in $(seq 1 150); do
  if "${VMSSH[@]}" 'test -f /tmp/provision.done' 2>/dev/null; then break; fi
  if test "$i" -eq 150; then
    echo "--- хвост лога провижининга ---"
    "${VMSSH[@]}" 'tail -20 /tmp/provision.log' || true
    die "провижининг не завершился за 75 мин"
  fi
  sleep 30
done
"${VMSSH[@]}" 'tail -5 /tmp/provision.log'
"${VMSSH[@]}" 'grep -q "готово" /tmp/provision.log' || die "провижининг без «готово» — смотри /tmp/provision.log в VM"
"${VMSSH[@]}" 'rm -f /tmp/provision.sh /tmp/provision.log /tmp/provision.done'

# VM перезагружалась внутри payload — жду ssh снова
log "vm: жду sshd после ребута (до 300 c)"
for i in $(seq 1 60); do
  if timeout 2 bash -c 'exec 3<>/dev/tcp/198.51.100.13/22' 2>/dev/null; then break; fi
  test "$i" -eq 60 && die "sshd после ребута не поднялся за 300 c"
  sleep 5
done
sleep 20   # gdm + autologin

# ================= финальные проверки (факт) =================
log "check: qm-конфиг"
qm config "$VMID" | grep -q 'name: enotdesk-linux-a1' || die "имя VM"
qm config "$VMID" | grep -q '^memory: 6144' || die "memory"
qm config "$VMID" | grep -q '^balloon: 2048' || die "balloon"
qm config "$VMID" | grep -qF 'ip=198.51.100.13/24,gw=198.51.100.1' || die "ipconfig0"
qm config "$VMID" | grep -q 'onboot: 1' || die "onboot"

log "check: gdm3 active + консольная сессия enotadmin на seat0"
"${VMSSH[@]}" 'systemctl is-active --quiet gdm3' || die "gdm3 не active"
"${VMSSH[@]}" 'loginctl list-sessions --no-legend | grep -q enotadmin' || die "нет сессии enotadmin"
"${VMSSH[@]}" 'loginctl list-sessions --no-legend | grep enotadmin | grep -q seat0' || die "сессия не на seat0"

log "check: X11-сессия и xauth-sync"
"${VMSSH[@]}" 'sudo /usr/local/sbin/enot-xauth-sync.sh 60' || die "xauth-sync не отработал"
"${VMSSH[@]}" 'sudo test -f /etc/enotdesk-agent/xauth && sudo test -f /etc/enotdesk-agent/xdisplay.env' || die "нет xauth/xdisplay.env"

log "check: qemu-guest-agent"
qm agent "$VMID" ping >/dev/null 2>&1 || die "qemu-guest-agent не отвечает"

# снапшот clean — только после всех проверок
if ! qm listsnapshot "$VMID" | awk '{print $2}' | grep -qx clean; then
  log "snapshot: clean"
  qm snapshot "$VMID" clean --description "LAB: clean linux-a1 (Debian 13 + GNOME X11/Wayland, до агента)"
else
  log "snapshot: clean уже есть"
fi

log "PASS: enotdesk-linux-a1 (103) 198.51.100.13 — gdm+X11 autologin ok, clean на месте"

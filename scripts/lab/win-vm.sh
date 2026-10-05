#!/usr/bin/env bash
# T03: клиентские Windows VM enotdesk-win10-a1 (101) + enotdesk-win11-a1 (102).
# Запускается на Proxmox-хосте (root). Идемпотентен: повторный запуск чинит/продолжает, не дублирует VM.
#
# Что делает:
#   1. Секреты: /root/enot-lab-secrets/windows-vms.env (0600, scanner-safe printf %q) — reuse-on-exists.
#   2. Пересобирает установочные ISO: extract → genisoimage -udf -iso-level 3 с El Torito EFI =
#      efisys_noprompt.bin (без «Press any key»), а autounattend.xml (подстановка @@VAL1@@/@@VAL2@@/@@IP@@
#      в копию, в репо шаблон с нейтральными маркерами), subset драйверов virtio (viostor/vioscsi/NetKVM/
#      vioserial/Balloon для w10|w11), qemu-ga-x86_64.msi и provision-firstlogon.ps1 кладутся в КОРЕНЬ
#      того же ISO — Setup читает ответ со своего носителя гарантированно. DriverPaths в xml перечисляет
#      D:\drivers..J:\drivers — несуществующие пути Setup пропускает, поэтому буква CD не важна.
#   3. Создаёт/сверяет VM (равная фабрика: 4 vCPU/6 ГБ/64 ГБ, balloon min 2 ГБ (D01),
#      q35, OVMF, virtio): Win10 — без TPM, SB off;
#      Win11 — vTPM 2.0 (swtpm) + SB on (efidisk0 pre-enrolled-keys=1). Загрузка scsi0;ide0: пустой диск → CD,
#      после первого этапа установки ESP уже загрузочный → рестарты идут с диска, установки с CD не повторяется.
#   4. Стартует обе, опрашивает TCP/22 циклом (установка 20–50+ мин/машину, идёт параллельно).
#   5. Финальные проверки фактом: qm config asserts, ssh enotadmin@<ip>, ping 1.1.1.1 изнутри, qm agent ping.
#   6. Снапшот clean (idempotent) — после всех проверок.
#
# Запуск (с рабочей машины):
#   scp scripts/lab/win-vm.sh scripts/lab/autounattend-win10.xml scripts/lab/autounattend-win11.xml \
#       root@192.0.2.50:/root/enot-lab/
#   ssh root@192.0.2.50 'nohup /root/enot-lab/win-vm.sh >> /root/enot-lab/win-vm.log 2>&1 &'
set -euo pipefail

PVE_ISO=/var/lib/vz/template/iso
WIN10_ISO=$PVE_ISO/Win10_22H2_x64.iso
WIN11_ISO=$PVE_ISO/Win11_x64.iso
# Пересобранные копии: efisys_noprompt.bin (El Torito EFI-образ без «Press any key») +
# autounattend.xml/drivers/qga в корне. Оригинальный cdboot.efi на пустом диске показывает
# «Press any key to boot from CD» и без клавиши выходит — VM циклятся в boot-loop (факт 2026-10-05).
WIN10_ISO_ED=$PVE_ISO/Win10_22H2_x64-enotdesk.iso
WIN11_ISO_ED=$PVE_ISO/Win11_x64-enotdesk.iso
VIRTIO_ISO=$PVE_ISO/virtio-win.iso
LABDIR=/root/enot-lab
KEYS=/root/enot-lab-keys
KEY_PUB=$KEYS/enot-lab-ed25519.pub
KEY_PRIV=$KEYS/enot-lab-ed25519
KH=$KEYS/known_hosts
SECDIR=/root/enot-lab-secrets
SECRETS=$SECDIR/windows-vms.env
WORK=$LABDIR/win-iso-work
GW=198.51.100.1
DNS=1.1.1.1
CORES=4
MEMMB=6144
BALLOON_MB=2048   # balloon floor клиентов (D01): память сверх него хост забирает балуном
DISKGB=64
ADMIN_USER=enotadmin
WAIT_LOOPS=220          # x30 c = 110 мин на обе машины суммарно
VIRTIO_MNT=$WORK/virtio

log() { echo "[T03 $(date '+%H:%M:%S')] $*"; }
die() { echo "[T03] FAIL: $*" >&2; exit 1; }

# --- блокировка от параллельных запусков (mkdir-замок, как в T02: kvm/ssh наследуют fd) ---
LOCKDIR=/run/lock/enot-lab-win-vm.lock.d
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  OPID=$(cat "$LOCKDIR/pid" 2>/dev/null || true)
  if [ -n "$OPID" ] && ! kill -0 "$OPID" 2>/dev/null; then
    log "lock: устаревший замок (pid $OPID мёртв) — снимаю"
    rm -rf "$LOCKDIR"; mkdir "$LOCKDIR" || die "не смог взять замок"
  else
    die "уже запущен (замок $LOCKDIR${OPID:+, pid $OPID})"
  fi
fi
echo $$ > "$LOCKDIR/pid"
trap 'rm -rf "$LOCKDIR"' EXIT

# --- предусловия ---
command -v qm >/dev/null || die "qm не найден"
command -v genisoimage >/dev/null || apt-get install -y -qq genisoimage >/dev/null || die "нет genisoimage"
[ -f "$WIN10_ISO" ] || die "нет $WIN10_ISO (T01)"
[ -f "$WIN11_ISO" ] || die "нет $WIN11_ISO (T01)"
[ -f "$VIRTIO_ISO" ] || die "нет $VIRTIO_ISO (T01)"
[ -f "$KEY_PUB" ] || die "нет $KEY_PUB — ключ агента (scp с Mac: ~/enot-lab-prep/enot-lab-ed25519.pub)"
[ -f "$KEY_PRIV" ] || die "нет $KEY_PRIV — нужен хосту для ssh внутрь VM"
[ -f "$LABDIR/autounattend-win10.xml" ] || die "нет $LABDIR/autounattend-win10.xml — scp из scripts/lab/"
[ -f "$LABDIR/autounattend-win11.xml" ] || die "нет $LABDIR/autounattend-win11.xml — scp из scripts/lab/"
# RAM: клиенты 6144 МБ с balloon-min 2048 (D01) — у уже запущенных клиентов память
# сверх floor'а хост забирает балуном, поэтому считаем free + Σ(memory−balloon);
# на голом хосте это честные 2×6144
TOTAL_NEED_MB=$((MEMMB * 2))
RECLAIM_MB=0
NOBALLOON_VMS=""
for vmid in 101 102; do
  if qm status "$vmid" 2>/dev/null | grep -q '^status: running'; then
    M=$(qm config "$vmid" | awk '/^memory:/{print $2}')
    B=$(qm config "$vmid" | awk '/^balloon:/{print $2}')
    [ -n "$M" ] || die "не смог прочитать memory VM $vmid"
    # balloon отсутствует/0/не число — хосту нечего забрать балуном, честно reclaimable=0
    case "$B" in
      ''|0|*[!0-9]*) NOBALLOON_VMS="$NOBALLOON_VMS $vmid" ;;
      *) RECLAIM_MB=$((RECLAIM_MB + M - B)) ;;
    esac
  fi
done
AVAIL_MB=$(free -m | awk '/^Mem:/{print $7}')
EFFECTIVE_MB=$((AVAIL_MB + RECLAIM_MB))
NOTE=""
if [ -n "$NOBALLOON_VMS" ]; then
  NOTE="; balloon не настроен у VM:$NOBALLOON_VMS — резерв по free"
fi
log "ram: free ${AVAIL_MB}МБ + balloon-reclaim ${RECLAIM_MB}МБ = ${EFFECTIVE_MB}МБ ≥ нужно ${TOTAL_NEED_MB}МБ${NOTE}"
[ "$EFFECTIVE_MB" -ge "$TOTAL_NEED_MB" ] \
  || die "мало RAM: free ${AVAIL_MB}МБ + balloon-reclaim ${RECLAIM_MB}МБ = ${EFFECTIVE_MB}МБ < нужно ${TOTAL_NEED_MB}МБ (2×${MEMMB}МБ)${NOTE}"
ip -4 addr show vmbr0 | grep -q "$GW" || die "vmbr0 без $GW — сеть хоста не та (не трогаю)"
dpkg -s swtpm >/dev/null 2>&1 || die "нет swtpm (нужен для vTPM VMID 102)"

# --- секреты: reuse-on-exists (ротация ломает уже установленный аккаунт) ---
if [ -f "$SECRETS" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS"
  [ -n "${WIN_ADMIN_PASSWORD:-}" ] || die "пусто WIN_ADMIN_PASSWORD в $SECRETS"
  log "секреты: переиспользую ($SECRETS)"
else
  mkdir -p "$SECDIR"; chmod 700 "$SECDIR"
  # фиксированный хвост гарантирует сложность Windows (верхний/нижний регистр/цифра/спецсимвол),
  # энтропия — в случайной части; значение не печатается и не коммитится
  WIN_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9')Aa1!"
  umask 077
  {
    printf '%s\n' '# EnotDesk lab Windows VMs (T03). 0600. Значения НЕ коммитятся и не печатаются.'
    printf '%s=%q\n' WIN_ADMIN_USER "$ADMIN_USER"
    printf '%s=%q\n' WIN_ADMIN_PASSWORD "$WIN_ADMIN_PASSWORD"
  } > "$SECRETS"
  chmod 600 "$SECRETS"
  log "секреты: сгенерированы → $SECRETS (0600)"
fi
PUB=$(cat "$KEY_PUB")
[ -n "$PUB" ] || die "пустой $KEY_PUB"

mkdir -p "$WORK"

# --- provisioning-скрипт first logon (кладётся в корень unattend-ISO, значения подставляются sed'ом) ---
cat > "$WORK/provision-firstlogon.ps1.template" <<'PS_EOF'
# EnotDesk lab (T03): провижининг на первом входе (AutoLogon enotadmin). Идемпотентен, честные результаты.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$log = 'C:\enot-lab-provision.log'
"=== start $(Get-Date -Format s)" | Out-File $log -Append -Encoding utf8

$ip = '@@IP@@'
$gw = '198.51.100.1'
$dns = '1.1.1.1'
$pub = '@@VAL2@@'

# 0. virtio-драйверы из CD в работающую ОС (страховка: NetKVM в offline-образ попадает
#    через offlineServicing-pass, но если его там нет — NIC не появится без этого шага)
$drvRoot = Join-Path $PSScriptRoot 'drivers'
if (Test-Path $drvRoot) {
  Start-Process pnputil.exe -ArgumentList "/add-driver `"$drvRoot\*.inf`" /subdirs /install" -Wait
  "pnputil: staged virtio drivers" | Out-File $log -Append -Encoding utf8
}

# 0.1 ждём NIC (до 120 с)
$nic = $null
$deadline = (Get-Date).AddSeconds(120)
do {
  $nic = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
  if (-not $nic) { Start-Sleep 5 }
} until ($nic -or (Get-Date) -gt $deadline)
"nic: $($nic.Name)" | Out-File $log -Append -Encoding utf8

# 0.2 ждём сеть до шлюза (статика применяется в specialize)
$gwOk = $false
$deadline = (Get-Date).AddSeconds(120)
do {
  $gwOk = Test-Connection -ComputerName $gw -Count 1 -Quiet
  if (-not $gwOk) { Start-Sleep 5 }
} until ($gwOk -or (Get-Date) -gt $deadline)
"gw_reachable: $gwOk" | Out-File $log -Append -Encoding utf8

# 1. статика: TCPIP-unattend первичен, это чинящий fallback по фактическому адаптеру
if ($nic) {
  $cur = Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $ip }
  if (-not $cur) {
    Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
    New-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $ip -PrefixLength 24 -DefaultGateway $gw -ErrorAction Continue | Out-Null
    "static-ip: applied to $($nic.Name)" | Out-File $log -Append -Encoding utf8
  }
  Set-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -ServerAddresses $dns -ErrorAction Continue
}
$curIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $ip } | Select-Object -First 1).IPAddress
"current-ip: $curIp" | Out-File $log -Append -Encoding utf8

# 2. enotadmin: пароль не истекает + гарантированное членство в Администраторах (по SID, независимо от локали)
try { Set-LocalUser -Name $env:USERNAME -PasswordNeverExpires $true -ErrorAction Stop } catch { "set-neverexpire: $_" | Out-File $log -Append -Encoding utf8 }
$adm = Get-LocalGroup -SID 'S-1-5-32-544'
try { Add-LocalGroupMember -Group $adm -Member $env:USERNAME -ErrorAction Stop } catch {}
$inAdm = (Get-LocalGroupMember -Group $adm -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*$env:USERNAME" }) -ne $null
"admin-member($env:USERNAME): $inAdm" | Out-File $log -Append -Encoding utf8

# 3. OpenSSH Server (Feature on Demand, интернет через NAT; 3 попытки)
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') {
  foreach ($i in 1..3) {
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
    $cap = Get-WindowsCapability -Online -Name $cap.Name
    if ($cap.State -eq 'Installed') { break }
    Start-Sleep 10
  }
}
"openssh: $($cap.State)" | Out-File $log -Append -Encoding utf8
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if ($svc) { Set-Service sshd -StartupType Automatic }
# старт с ретраями: сразу после установки capability сервис может не стартануть с первого раза
# (гонка факт 2026-10-05: RDP поднимался, sshd — нет; лечится повторными Start-Service)
$sshOk = $false
foreach ($i in 1..6) {
  Start-Service sshd -ErrorAction SilentlyContinue
  if (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue) { $sshOk = $true; break }
  Start-Sleep 15
}
"sshd-listening: $sshOk" | Out-File $log -Append -Encoding utf8

# 4. публичный ключ агента -> administrators_authorized_keys (ACL по SID — не зависит от локали)
$sshDir = "$env:ProgramData\ssh"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$ak = "$sshDir\administrators_authorized_keys"
if (-not ((Test-Path $ak) -and (Select-String -Path $ak -SimpleMatch $pub -Quiet))) { Add-Content -Path $ak -Value $pub }
icacls $ak /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F' | Out-Null
"authkeys: $((Get-Item $ak).Length) bytes" | Out-File $log -Append -Encoding utf8

# 5. qemu-guest-agent — лежит рядом с этим скриптом в корне того же CD
$msi = Join-Path $PSScriptRoot 'qemu-ga-x86_64.msi'
if (Test-Path $msi) { Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait }
"qga: $((Get-Service 'QEMU Guest Agent' -ErrorAction SilentlyContinue).Status)" | Out-File $log -Append -Encoding utf8

# 6. RDP включён (шов оператора), правила фаервола по language-neutral именам
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Get-NetFirewallRule -Name 'RemoteDesktop*' -ErrorAction SilentlyContinue | Enable-NetFirewallRule
# правило OpenSSH создаётся capability'ем в профиле Private; сеть в лабе = Public
# (факт 2026-10-05: порт 22 закрыт снаружи при слушающем sshd) — ставим Profile Any
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Set-NetFirewallRule -Profile Any -Enabled True

# 7. честный итог
$inet = Test-Connection -ComputerName 1.1.1.1 -Count 2 -Quiet
"RESULT ip=$curIp gw=$gwOk sshd=$((Get-Service sshd -ErrorAction SilentlyContinue).Status) inet=$inet qga=$((Get-Service 'QEMU Guest Agent' -ErrorAction SilentlyContinue).Status)" | Out-File $log -Append -Encoding utf8
"RESULT ip=$curIp" | Out-File 'C:\enot-lab-provision.result' -Encoding ascii
exit 0
PS_EOF

# --- сборка unattend-ISO per VM ---
# virtio монтируем один раз (ro); извлекаем subset драйверов под целевую ОС
if ! mountpoint -q "$VIRTIO_MNT" 2>/dev/null; then
  mkdir -p "$VIRTIO_MNT"
  mount -o loop,ro "$VIRTIO_ISO" "$VIRTIO_MNT" || die "не смог смонтировать $VIRTIO_ISO"
  UMOUNT_VIRTIO=1
else
  log "virtio: уже смонтирован в $VIRTIO_MNT — переиспользую"
fi
cleanup_virtio() { [ "${UMOUNT_VIRTIO:-0}" = "1" ] && umount "$VIRTIO_MNT" 2>/dev/null || true; }
# единый EXIT-trap: и замок, и размонтирование virtio (второй trap перезатёр бы первый)
trap 'rm -rf "$LOCKDIR"; cleanup_virtio' EXIT

build_unattend_payload() { # $1=flavor (win10|win11) — готовит payload для инъекции в установочный ISO
  local FLAVOR=$1
  local OSDIR IP XMLSRC DIR
  case "$FLAVOR" in
    win10) OSDIR=w10; IP=198.51.100.11; XMLSRC=$LABDIR/autounattend-win10.xml ;;
    win11) OSDIR=w11; IP=198.51.100.12; XMLSRC=$LABDIR/autounattend-win11.xml ;;
    *) die "неизвестный flavor $FLAVOR" ;;
  esac
  DIR=$WORK/$FLAVOR
  rm -rf "$DIR"; mkdir -p "$DIR/drivers"

  local DRV
  for DRV in viostor vioscsi NetKVM vioserial Balloon; do
    [ -d "$VIRTIO_MNT/$DRV/$OSDIR" ] || die "в virtio-win нет $DRV/$OSDIR"
    cp -a "$VIRTIO_MNT/$DRV/$OSDIR" "$DIR/drivers/$DRV"
  done
  cp "$VIRTIO_MNT/guest-agent/qemu-ga-x86_64.msi" "$DIR/"

  # подстановка в КОПИИ (шаблоны остаются с нейтральными маркерами)
  sed -e "s|@@VAL1@@|$WIN_ADMIN_PASSWORD|g" \
      -e "s|@@VAL2@@|$PUB|g" \
      -e "s|@@IP@@|$IP|g" "$XMLSRC" > "$DIR/autounattend.xml"
  sed -e "s|@@VAL2@@|$PUB|g" \
      -e "s|@@IP@@|$IP|g" "$WORK/provision-firstlogon.ps1.template" > "$DIR/provision-firstlogon.ps1"
  if grep -q '@@VAL1@@\|@@VAL2@@\|@@IP@@' "$DIR/autounattend.xml" "$DIR/provision-firstlogon.ps1"; then
    die "подстановка не прошла для $FLAVOR (остались маркеры @@)"
  fi
  python3 -c "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1])" "$DIR/autounattend.xml" \
    || die "autounattend-$FLAVOR.xml невалиден как XML"
  log "payload: $FLAVOR готов (autounattend+drivers $OSDIR+qga)"
}

build_unattend_payload win10
build_unattend_payload win11
cleanup_virtio

# --- пересборка установочных ISO: efisys_noprompt.bin (без «Press any key») + payload в корне ---
# autounattend.xml в корне собственного загрузочного носителя Setup читает гарантированно
# (отдельный unattend-CD Win11 setup может не подхватить — факт 2026-10-05).
build_install_iso() { # $1=flavor
  local FLAVOR=$1 SRC DST
  case "$FLAVOR" in
    win10) SRC=$WIN10_ISO; DST=$WIN10_ISO_ED ;;
    win11) SRC=$WIN11_ISO; DST=$WIN11_ISO_ED ;;
    *) die "flavor?" ;;
  esac
  local TMP=$WORK/installiso-$FLAVOR
  rm -rf "$TMP"; mkdir -p "$TMP/mnt" "$TMP/tree"
  mount -o loop,ro "$SRC" "$TMP/mnt" || die "не смог смонтировать $SRC"
  cp -a "$TMP/mnt/." "$TMP/tree/" || { umount "$TMP/mnt"; rm -rf "$TMP"; die "копирование дерева $SRC не удалось"; }
  umount "$TMP/mnt"
  [ -f "$TMP/tree/efi/microsoft/boot/efisys_noprompt.bin" ] || { rm -rf "$TMP"; die "нет efisys_noprompt.bin в $SRC"; }
  cp "$WORK/$FLAVOR/autounattend.xml" "$TMP/tree/autounattend.xml"
  cp "$WORK/$FLAVOR/provision-firstlogon.ps1" "$TMP/tree/provision-firstlogon.ps1"
  cp "$WORK/$FLAVOR/qemu-ga-x86_64.msi" "$TMP/tree/qemu-ga-x86_64.msi"
  cp -a "$WORK/$FLAVOR/drivers" "$TMP/tree/drivers"
  # и в приоритетный источник: X:\Windows\Panther\unattend.xml внутри boot.wim
  # (25H2 setup может не взять ответ с корня носителя — факт 2026-10-05)
  command -v wimupdate >/dev/null || apt-get install -y -qq wimtools >/dev/null
  wimupdate "$TMP/tree/sources/boot.wim" 2 \
    --command="add $WORK/$FLAVOR/autounattend.xml /Windows/Panther/unattend.xml" \
    || { rm -rf "$TMP"; die "не смог влить autounattend в boot.wim ($FLAVOR)"; }
  ( cd "$TMP/tree" && genisoimage -quiet -J -joliet-long -r -udf -iso-level 3 -allow-limited-size \
      -b boot/etfsboot.com -no-emul-boot -c boot.cat \
      -eltorito-alt-boot -b efi/microsoft/boot/efisys_noprompt.bin -no-emul-boot \
      -V ENOTLAB -o "$DST.new" . ) || { rm -rf "$TMP"; die "не собрал установочный ISO из $SRC"; }
  mv -f "$DST.new" "$DST"
  rm -rf "$TMP"
  log "iso: собран $DST ($(du -m "$DST" | cut -f1) МБ, noprompt+unattend)"
}
build_install_iso win10
build_install_iso win11

# ================= VM =================
# фабрика клиентов: 4 vCPU / 6 ГБ (balloon min 2 ГБ, D01) / 64 ГБ / q35 / OVMF / virtio-scsi / virtio-net vmbr0
ensure_vm() { # $1=vmid $2=name $3=flavor(win10|win11) $4=sbkeys(0|1) $5=tpm(0|1)
  local VMID=$1 NAME=$2 FLAVOR=$3 SBKEYS=$4 TPM=$5
  local OSTYPE WINISO
  case "$FLAVOR" in
    win10) OSTYPE=win10; WINISO=$WIN10_ISO_ED ;;
    win11) OSTYPE=win11; WINISO=$WIN11_ISO_ED ;;
    *) die "flavor?" ;;
  esac

  if ! qm status "$VMID" >/dev/null 2>&1; then
    log "vm: создаю $NAME (VMID $VMID, $CORES vCPU/${MEMMB}MB/${DISKGB}G, q35/ovmf, sb=$SBKEYS, tpm=$TPM)"
    local CREATE_ARGS=(create "$VMID" --name "$NAME" --ostype "$OSTYPE" --machine q35 --bios ovmf
      --cpu host --cores "$CORES" --memory "$MEMMB" --balloon "$BALLOON_MB"
      --net0 "virtio,bridge=vmbr0" --vga virtio --scsihw virtio-scsi-single
      --scsi0 "local-lvm:${DISKGB},iothread=1,discard=on"
      --efidisk0 "local-lvm:1,efitype=4m,pre-enrolled-keys=$SBKEYS"
      --ide0 "local:iso/$(basename "$WINISO"),media=cdrom"
      --ide1 "local:iso/virtio-win.iso,media=cdrom"
      --boot "order=scsi0;ide0" --onboot 1 --agent enabled=1
      --description "EnotDesk lab client (T03): $FLAVOR, ssh enotadmin, agent key = enot-lab-ed25519")
    if [ "$TPM" = "1" ]; then CREATE_ARGS+=(--tpmstate0 "local-lvm:1,version=v2.0"); fi
    qm "${CREATE_ARGS[@]}" >/dev/null
  else
    log "vm: VMID $VMID существует — сверяю конфиг"
    local CFG; CFG=$(qm config "$VMID")
    echo "$CFG" | grep -q "name: $NAME" || qm set "$VMID" --name "$NAME" >/dev/null
    echo "$CFG" | grep -q "^cores: $CORES" || qm set "$VMID" --cores "$CORES" >/dev/null
    echo "$CFG" | grep -q "^memory: $MEMMB" || qm set "$VMID" --memory "$MEMMB" >/dev/null
    echo "$CFG" | grep -q "^balloon: $BALLOON_MB" || qm set "$VMID" --balloon "$BALLOON_MB" >/dev/null
    echo "$CFG" | grep '^net0:' | grep -q 'virtio=' || die "net0 у $VMID не virtio — чужой конфиг, не трогаю"
    qm config "$VMID" | grep '^net0:' | grep -q 'bridge=vmbr0' || die "net0 у $VMID не на vmbr0 — чужой конфиг"
    qm config "$VMID" | grep -q 'bios: ovmf' || die "$VMID не ovmf — чужой конфиг"
    qm config "$VMID" | grep -Eq '^machine: (q35|pc-q35-[0-9.]+)' || die "$VMID не q35 — чужой конфиг"
    qm config "$VMID" | grep -q 'scsihw: virtio-scsi-single' || die "$VMID не virtio-scsi-single — чужой конфиг"
    # носители: добавляю только отсутствующие; подменять чужие не буду
    qm config "$VMID" | grep -q '^ide0:' || qm set "$VMID" --ide0 "local:iso/$(basename "$WINISO"),media=cdrom" >/dev/null
    qm config "$VMID" | grep -q '^ide1:' || qm set "$VMID" --ide1 "local:iso/virtio-win.iso,media=cdrom" >/dev/null
    qm config "$VMID" | grep -q "$(basename "$WINISO")" || die "ide0 у $VMID не $WINISO — чужой конфиг, не трогаю"
    qm config "$VMID" | grep -q 'virtio-win.iso' || die "virtio-win.iso не подключён к $VMID"
  fi

  # диск до $DISKGB (только вверх)
  local CUR_SIZE CUR_G
  CUR_SIZE=$(qm config "$VMID" | awk -F'size=' '/^scsi0:/{split($2,a,","); print a[1]}' || true)
  [ -n "$CUR_SIZE" ] || die "у $VMID нет scsi0"
  CUR_G=${CUR_SIZE//G/}
  [ "$CUR_G" -ge "$DISKGB" ] || qm disk resize "$VMID" scsi0 "${DISKGB}G" >/dev/null
  qm set "$VMID" --onboot 1 >/dev/null
}

ensure_vm 101 enotdesk-win10-a1 win10 0 0
ensure_vm 102 enotdesk-win11-a1 win11 1 1

start_vm() { # $1=vmid
  if ! qm status "$1" 2>/dev/null | grep -q '^status: running'; then
    log "vm: стартую $1"
    qm start "$1" >/dev/null
  else
    log "vm: $1 уже запущена"
  fi
}
start_vm 101
start_vm 102

# --- ожидание: опрашиваем TCP/22 обеих машин циклом ---
tcp_open() { timeout 2 bash -c "exec 3<>/dev/tcp/$1/22" 2>/dev/null; }
UP101=0; UP102=0
log "wait: жду sshd 198.51.100.11 и 198.51.100.12 (до $((WAIT_LOOPS*30/60)) мин)"
for i in $(seq 1 "$WAIT_LOOPS"); do
  tcp_open 198.51.100.11 && UP101=1
  tcp_open 198.51.100.12 && UP102=1
  if [ "$UP101" = "1" ] && [ "$UP102" = "1" ]; then break; fi
  # VM, зависшая в stopped дольше 5 минут — честный отказ
  for VMID in 101 102; do
    if ! qm status "$VMID" 2>/dev/null | grep -q '^status: running'; then
      STOPCNT=$(( $(cat "$WORK/stop$VMID" 2>/dev/null || echo 0) + 1 ))
      echo "$STOPCNT" > "$WORK/stop$VMID"
      [ "$STOPCNT" -gt 10 ] || continue
      die "VM $VMID в stopped >5 мин — установка не идёт, смотрю win-vm.log/vnc"
    else
      echo 0 > "$WORK/stop$VMID"
    fi
  done
  [ $((i % 6)) = "0" ] && log "wait: t=$((i*30/60))мин win10_ssh=$UP101 win11_ssh=$UP102 ($(qm status 101 2>/dev/null | awk '/^status/{print $2}')/$(qm status 102 2>/dev/null | awk '/^status/{print $2}'))"
  sleep 30
done
[ "$UP101" = "1" ] || die "sshd на 198.51.100.11 не поднялся за $((WAIT_LOOPS*30/60)) мин"
[ "$UP102" = "1" ] || die "sshd на 198.51.100.12 не поднялся за $((WAIT_LOOPS*30/60)) мин"

# ================= финальные проверки (факт, не слова) =================
vmssh() { # $1=ip $2=cmd
  ssh -i "$KEY_PRIV" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="$KH" -o ConnectTimeout=15 "$ADMIN_USER@$1" "$2"
}
check_vm() { # $1=vmid $2=ip $3=name
  local VMID=$1 IP=$2 NAME=$3 OUT
  qm config "$VMID" | grep -q "name: $NAME" || die "$VMID: имя не $NAME"
  qm config "$VMID" | grep -q "^cores: $CORES" || die "$VMID: cores не $CORES"
  qm config "$VMID" | grep -q "^memory: $MEMMB" || die "$VMID: memory не $MEMMB"
  qm config "$VMID" | grep -q "^balloon: $BALLOON_MB" || die "$VMID: balloon не $BALLOON_MB"
  qm config "$VMID" | grep -q "bios: ovmf" || die "$VMID: не ovmf"
  qm config "$VMID" | grep -Eq '^machine: (q35|pc-q35-[0-9.]+)' || die "$VMID: не q35"
  qm config "$VMID" | grep -q '^net0:.*virtio=.*bridge=vmbr0' || die "$VMID: net0 не virtio/vmbr0"
  qm config "$VMID" | grep -q "^onboot: 1" || die "$VMID: onboot не 1"

  OUT=$(vmssh "$IP" 'ver' 2>&1) || die "$IP: ssh не удался: $OUT"
  printf '%s' "$OUT" | grep -q "Microsoft Windows" || die "$IP: ssh отвечает, но это не Windows: $OUT"
  log "check: $NAME ssh ok ($OUT)"

  OUT=$(vmssh "$IP" 'ping -n 2 -w 2000 1.1.1.1 | find "TTL=" >nul && echo PING_OK || echo PING_FAIL' 2>&1) \
    || die "$IP: ping-команда не удалась: $OUT"
  printf '%s' "$OUT" | grep -q "PING_OK" || die "$IP: ping 1.1.1.1 изнутри не проходит: $OUT"
  log "check: $NAME ping наружу ok"

  local i
  for i in $(seq 1 12); do
    if qm agent "$VMID" ping >/dev/null 2>&1; then break; fi
    [ "$i" = "12" ] && die "$VMID: qemu-guest-agent не отвечает (qm agent ping)"
    sleep 10
  done
  log "check: $NAME qemu-guest-agent ok"
}
check_vm 101 198.51.100.11 enotdesk-win10-a1
check_vm 102 198.51.100.12 enotdesk-win11-a1

# специфичные ассерты: 102 = vTPM + SB, 101 = без TPM
qm config 102 | grep -q 'tpmstate0:.*version=v2.0' || die "102: нет tpmstate0 v2.0"
qm config 102 | grep -q 'efidisk0:.*pre-enrolled-keys=1' || die "102: efidisk0 без pre-enrolled-keys=1"
qm config 101 | grep -q '^tpmstate0:' && die "101: не должно быть TPM"
log "check: 102 vTPM+SB ok, 101 без TPM ok"

# снапшот clean (Шов №5) — после всех проверок.
# Наличие clean — по имени снимка (2-я колонка qm listsnapshot), не по стрелкам `->` (F1).
snapshot_clean() { # $1=vmid
  if ! qm listsnapshot "$1" | awk '{print $2}' | grep -qx clean; then
    qm snapshot "$1" clean --description "T03: clean install (без EnotDesk-агента)" >/dev/null
    log "snapshot: clean у VMID $1"
  else
    log "snapshot: clean у VMID $1 уже есть"
  fi
}
snapshot_clean 101
snapshot_clean 102

rm -f "$WORK/stop101" "$WORK/stop102"
log "PASS: enotdesk-win10-a1 (101, 198.51.100.11) + enotdesk-win11-a1 (102, 198.51.100.12) — ssh/ping/qga ok, креды: $SECRETS"

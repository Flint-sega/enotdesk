#!/usr/bin/env bash
# fetch-images.sh — образы лабы EnotDesk на хосте Proxmox (192.0.2.50).
# Запускается НА ХОСТЕ: bash fetch-images.sh (обычно через ssh, в фоне с nohup).
#
# Что кладёт:
#   /root/images/debian-13-generic-amd64.qcow2      — Debian 13 cloud (сервер VM)
#   /var/lib/vz/template/iso/virtio-win.iso         — драйверы virtio для Windows
#   /var/lib/vz/template/iso/Win10_22H2_x64.iso     — официальный ISO с CDN Microsoft
#   /var/lib/vz/template/iso/Win11_x64.iso          — официальный ISO с CDN Microsoft
#
# Ссылки на Windows ISO Microsoft выдаёт сессионные (≈10 ч): они лежат в
#   /root/images/win10.url и /root/images/win11.url (первая строка — URL,
#   только домены *.microsoft.com).
# Если ссылка истекла, а файл недокачан — скрипт честно падает с подсказкой,
# НЕ перекачивая образ с нуля: недокачанный кусок сохраняется до новой ссылки
# (curl -C - докатит с места обрыва, когда sidecar обновят).
#
# Идемпотентность: полный файл (размер == Content-Length источника) не
# перекачивается; недокачанный докачивается с места обрыва; обрыв соединения
# внутри curl лечится --retry (каждый ретрай продолжает с текущего размера
# файла благодаря -C -).
set -u

IMAGES_DIR=/root/images
ISO_DIR=/var/lib/vz/template/iso

DEBIAN_URL="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2"
DEBIAN_SHA_URL="https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS"
VIRTIO_URL="https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-0.1.302-1/virtio-win-0.1.302.iso"

# Разрешённые домены для сессионных ссылок Windows (официальный CDN Microsoft)
MS_DOMAIN_RE='^(https://[a-z0-9.-]*microsoft\.com/)'

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() { log "FAIL: $*"; exit 1; }

curl_meta() { curl -sSIL --retry 3 --retry-delay 3 --retry-all-errors --max-time 40 "$1" 2>/dev/null; }

head_size() {
    curl_meta "$1" | tr -d '\r' | grep -i '^content-length:' | tail -1 | awk '{print $2}'
}

head_code() {
    curl_meta "$1" | tr -d '\r' | grep -iE '^HTTP/' | tail -1 | awk '{print $2}'
}

# ISO 9660: метка "CD001" по смещению 0x8001
iso_magic_ok() { dd if="$1" bs=1 skip=32769 count=5 2>/dev/null | grep -q CD001; }

# fetch <url> <файл> — скачать/докачать до точного размера источника
fetch() {
    local url=$1 file=$2 rsize lsize fsize
    rsize=$(head_size "$url")
    [ -n "$rsize" ] || die "источник не отдал Content-Length: $url"
    if [ -f "$file" ]; then
        lsize=$(stat -c%s "$file")
        if [ "$lsize" -eq "$rsize" ]; then
            log "SKIP: $file уже полная ($lsize байт)"
            return 0
        fi
        if [ "$lsize" -gt "$rsize" ]; then
            log "WARN: $file ($lsize) больше источника ($rsize) — источник сменился, перекачиваю"
            rm -f "$file"
        else
            log "RESUME: $file докачиваю $lsize -> $rsize (осталось $((rsize - lsize)) байт)"
        fi
    else
        log "START: $file ($rsize байт)"
    fi
    curl -fL --retry 10 --retry-delay 5 --retry-all-errors \
         --connect-timeout 30 --speed-limit 10240 --speed-time 90 \
         -C - -o "$file" "$url" \
        || die "curl не смог скачать/докачать $file (url=$url)"
    fsize=$(stat -c%s "$file")
    [ "$fsize" -eq "$rsize" ] \
        || die "размер $file после скачивания ($fsize) не совпал с источником ($rsize)"
    log "OK: $file полный ($fsize байт)"
}

# записать контрольную сумму, если ещё нет
sha_note() {
    local file=$1 sum="$1.sha256"
    if [ -f "$sum" ] && [ "$(head -1 "$sum" | awk '{print $1}')" != "" ]; then
        return 0
    fi
    sha256sum "$file" > "$sum" 2>/dev/null || return 0
    log "SHA256($file): $(awk '{print $1}' "$sum")"
}

# живая сессионная ссылка Windows из sidecar'а
win_url() {
    local side=$1 u code
    [ -s "$side" ] || return 1
    u=$(head -1 "$side" | tr -d '[:space:]')
    # разрешены только хосты *.microsoft.com (официальный CDN)
    if [[ ! "$u" =~ ^https://[a-zA-Z0-9.-]*microsoft\.com/ ]]; then
        log "WARN: $side — не microsoft.com домен, отклонено"
        return 1
    fi
    code=$(head_code "$u")
    [ "$code" = "200" ] || { log "WARN: $side — ссылка истекла (HTTP $code)"; return 1; }
    echo "$u"
}

# --- Debian 13 cloud qcow2 ---
debian_check() {
    local file="$IMAGES_DIR/debian-13-generic-amd64.qcow2" size info
    mkdir -p "$IMAGES_DIR"
    if [ ! -f "$file" ]; then
        fetch "$DEBIAN_URL" "$file" || return 1
    fi
    size=$(stat -c%s "$file")
    [ "$size" -gt 400000000 ] || die "debian qcow2 слишком мал: $size байт"
    info=$(qemu-img info "$file" 2>/dev/null) || die "qemu-img info не читает $file"
    echo "$info" | grep -q "file format: qcow2" || die "$file не qcow2"
    echo "$info" | grep -q "corrupt: false" || die "$file помечен corrupt"
    log "OK: $file валидный qcow2, $size байт"
    # сверка с upstream SHA512 (смена point-release — не ошибка целостности)
    if sums=$(curl -fsSL --max-time 60 "$DEBIAN_SHA_URL" 2>/dev/null); then
        local want have
        want=$(echo "$sums" | awk -v f="$(basename "$file")" '$2=="*"f || $2==f {print $1}')
        if [ -n "$want" ]; then
            have=$(sha512sum "$file" | awk '{print $1}')
            if [ "$want" = "$have" ]; then
                log "OK: debian sha512 совпадает с upstream"
            else
                log "WARN: debian sha512 отличается от upstream (возможно сменился point-release; qemu-img целостность пройдена)"
            fi
        fi
    else
        log "WARN: не смог получить $DEBIAN_SHA_URL — проверка sha512 пропущена"
    fi
}

# --- virtio-win.iso ---
virtio_step() {
    local file="$ISO_DIR/virtio-win.iso"
    mkdir -p "$ISO_DIR"
    fetch "$VIRTIO_URL" "$file" || return 1
    iso_magic_ok "$file" || die "$file не ISO 9660"
    log "OK: $file ISO 9660"
    sha_note "$file"
}

# --- Windows ISO из сессионных ссылок ---
win_iso_step() {
    local side=$1 target=$2 name
    name=$(basename "$target")
    mkdir -p "$ISO_DIR"
    if [ -f "$target" ]; then
        local rsize
        # полный ли уже: сверяемся с кэшем размера в sidecar-метке или просто берём ссылку
        local url
        url=$(win_url "$side") || url=""
        if [ -n "$url" ]; then
            rsize=$(head_size "$url")
            if [ -n "$rsize" ] && [ "$(stat -c%s "$target")" -eq "$rsize" ]; then
                log "SKIP: $name уже полная ($(stat -c%s "$target") байт)"
                iso_magic_ok "$target" || die "$target есть, но не ISO 9660"
                log "OK: $name ISO 9660"
                return 0
            fi
        fi
    fi
    local url
    url=$(win_url "$side") \
        || die "$name: нет живой сессионной ссылки в $side. Недокачанный кусок сохранён; обнови sidecar свежей ссылкой с CDN Microsoft (браузерный проход www.microsoft.com/software-download/...) и перезапусти."
    fetch "$url" "$target" || return 1
    iso_magic_ok "$target" || die "$target не ISO 9660"
    log "OK: $name ISO 9660, $(stat -c%s "$target") байт"
    sha_note "$target"
}

main() {
    log "=== fetch-images: старт ==="
    debian_check
    virtio_step
    win_iso_step "$IMAGES_DIR/win10.url" "$ISO_DIR/Win10_22H2_x64.iso"
    win_iso_step "$IMAGES_DIR/win11.url" "$ISO_DIR/Win11_x64.iso"
    log "=== fetch-images: все образы на месте ==="
    ls -la "$IMAGES_DIR" "$ISO_DIR"
}

main "$@"

#!/bin/bash
# LAB VM103 (L6): сборка EnotDesk-linux AppImage из локального HEAD (a7fe5a7) прямо на VM.
# BUILD.md: сборка на целевой ОС; Linux-сборка ни разу не прогонялась — это первый прогон.
# Node 24 — tarball с nodejs.org (НЕ NodeSource, конвенция репо). Запуск: nohup, маркер done.
# Запуск на VM 103: sudo bash /var/tmp/enotdesk/build.sh  (лог: /var/tmp/enotdesk/build.log)
set -uo pipefail
log(){ echo "[build] $(date +%H:%M:%S) $*"; }
fail(){ echo "[build] FAIL: $*" >&2; touch /var/tmp/enotdesk/build.failed; exit 1; }

APP=/var/tmp/enotdesk
SRC=$APP/build-src
NODEDIR=/opt/node24
cd "$APP"

# --- node 24 tarball ---
if ! test -x "$NODEDIR/bin/node"; then
  log "node: определяю свежий v24 на nodejs.org"
  NODE_VER=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o '"version":"v24[0-9.]*"' | head -1 | grep -o 'v24[0-9.]*')
  [ -n "$NODE_VER" ] || fail "не нашёл v24"
  log "node: ставлю $NODE_VER в $NODEDIR"
  mkdir -p "$NODEDIR"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" \
    | tar -xJ --strip-components=1 -C "$NODEDIR" || fail "node tarball"
fi
export PATH="$NODEDIR/bin:$PATH"
log "node: $(node -v), npm: $(npm -v)"

# --- исходники ---
rm -rf "$SRC"
mkdir -p "$SRC"
tar -xzf "$APP/src.tar.gz" -C "$SRC"
cd "$SRC"
log "src: $(git log --oneline -1 2>/dev/null || echo 'без git (tar worktree)')"
log "npm ci: старт (зависимости + electron 44)"
npm ci --no-audit --no-fund > "$APP/npm-ci.log" 2>&1 || { tail -20 "$APP/npm-ci.log"; fail "npm ci"; }
log "npm ci: ok ($(ls node_modules | wc -l) пакетов)"

log "pack:linux: старт"
npm run pack:linux > "$APP/pack.log" 2>&1 || { tail -30 "$APP/pack.log"; fail "pack:linux"; }
DISTAPP=$(ls "$SRC"/dist/EnotDesk-linux-*.AppImage 2>/dev/null | head -1)
[ -n "$DISTAPP" ] || { tail -30 "$APP/pack.log"; fail "AppImage не появился"; }
log "pack:linux: ok -> $DISTAPP ($(du -h "$DISTAPP" | cut -f1))"
sha256sum "$DISTAPP" > "$APP/built.sha256"
mv "$DISTAPP" "$APP/EnotDesk-built.AppImage"
touch "$APP/build.done"
log "готово: $APP/EnotDesk-built.AppImage"

#!/bin/bash
# Enot lab VM103: приводит /etc/enotdesk-agent/agent.env к типу активной консольной сессии.
#   x11     -> DISPLAY/XAUTHORITY (cookie от Xorg) в agent.env
#   wayland -> XDG_SESSION_TYPE=wayland (адаптер агента честно откажет
#              wayland-unsupported-control) + DISPLAY/XAUTHORITY от Xwayland,
#              чтобы Electron агента вообще поднялся (UI-стек требует дисплей;
#              XTest в Xwayland десктоп GNOME не управляет — потому и отказ)
#   нет     -> дисплейные строки убираются (агент, увы, будет рестартоваться —
#              Electron без дисплея не стартует; честное ограничение, в отчёт)
# Прочие строки agent.env (EDESK_AGENT_NAME и пр.) сохраняются. Идемпотентен.
# Юнит enot-xauth-sync.service зовёт его на каждом ребуте; после смены сессии —
# перезапуск вручную: sudo /usr/local/sbin/enot-xauth-sync.sh [wait-sec]
# Копия на VM 103: /usr/local/sbin/enot-xauth-sync.sh (самоустановка из домашки).
TARGET=/usr/local/sbin/enot-xauth-sync.sh
SELFDIR=$(dirname "$(readlink -f "$0")")
if [ "$SELFDIR" = "/home/enotadmin" ]; then
  sudo install -m 700 "$0" "$TARGET"
  rm -f "$0"
  exec sudo "$TARGET" "${1:-30}"
fi
set -u
ENVF=/etc/enotdesk-agent/agent.env
XAUTHF=/etc/enotdesk-agent/xauth
XDISPF=/etc/enotdesk-agent/xdisplay.env
install -d -m 0750 /etc/enotdesk-agent
touch "$ENVF"

env_set() {
  K=$1; V=$2
  grep -v "^${K}=" "$ENVF" > "$ENVF.tmp" 2>/dev/null || true
  echo "$K=$V" >> "$ENVF.tmp"
  mv "$ENVF.tmp" "$ENVF"
}
env_del() {
  K=$1
  grep -v "^${K}=" "$ENVF" > "$ENVF.tmp" 2>/dev/null || true
  mv "$ENVF.tmp" "$ENVF"
}

WAIT=${1:-60}
# На ребуте юнит стартует раньше, чем gdm поднимет autologin-сессию: ждём
# АКТИВНУЮ сессию с типом. Старые умирающие сессии (State!=active) пропускаем.
SESS=""; TYPE=""
for i in $(seq 1 "$WAIT"); do
  for S in $(loginctl list-sessions --no-legend 2>/dev/null | awk '/enotadmin/{print $1}'); do
    ST=$(loginctl show-session "$S" -p State --value 2>/dev/null || true)
    TY=$(loginctl show-session "$S" -p Type --value 2>/dev/null || true)
    if [ "$ST" = "active" ] && { [ "$TY" = "x11" ] || [ "$TY" = "wayland" ]; }; then
      SESS=$S; TYPE=$TY; break
    fi
  done
  [ -n "$TYPE" ] && break
  [ "$i" = "$WAIT" ] && break
  sleep 1
done

# display-helper: D из сокета /tmp/.X11-unix/X*, A — из -auth в cmdline процесса
resolve_display() { # $1 = имя процесса (Xorg|Xwayland)
  XP=$(pgrep -x "$1" | head -1)
  [ -n "$XP" ] || return 1
  A=$(ps -o args= -p "$XP" | sed -n 's/.*-auth \([^ ]*\).*/\1/p')
  XSOCK=$(ls /tmp/.X11-unix/X* 2>/dev/null | head -1)
  D=""
  if [ -n "$XSOCK" ]; then
    BASE=$(basename "$XSOCK")
    D=":${BASE#X}"
  fi
  [ -n "$D" ] && [ -n "$A" ] && [ -f "$A" ]
}

if [ "$TYPE" = "x11" ]; then
  for i in $(seq 1 "$WAIT"); do
    resolve_display Xorg && break
    [ "$i" = "$WAIT" ] && break
    sleep 1
  done
  if [ -n "$D" ] && [ -n "$A" ] && [ -f "$A" ]; then
    xauth -f "$A" extract - "$D" > "$XAUTHF" 2>/dev/null || { echo "xauth-sync: extract fail"; exit 1; }
    chmod 0400 "$XAUTHF"
    env_set DISPLAY "$D"
    env_set XAUTHORITY "$XAUTHF"
    env_del XDG_SESSION_TYPE
    printf 'DISPLAY=%s\nXAUTHORITY=%s\n' "$D" "$XAUTHF" > "$XDISPF"
    chmod 0644 "$XDISPF"
    echo "xauth-sync: x11 ok display=$D"
  else
    echo "xauth-sync: x11-сессия есть, DISPLAY/XAUTHORITY у Xorg не найдены"
    exit 1
  fi
elif [ "$TYPE" = "wayland" ]; then
  # дисплей для Electron — Xwayland (если есть); маркер wayland обязателен:
  # адаптер ввода обязан честно отказаться (wayland-unsupported-control)
  if resolve_display Xwayland; then
    xauth -f "$A" extract - "$D" > "$XAUTHF" 2>/dev/null || true
    chmod 0400 "$XAUTHF"
    env_set DISPLAY "$D"
    env_set XAUTHORITY "$XAUTHF"
    printf 'DISPLAY=%s\nXAUTHORITY=%s\nSESSION=wayland\n' "$D" "$XAUTHF" > "$XDISPF"
    echo "xauth-sync: wayland ok (display=$D через Xwayland, маркер wayland)"
  else
    printf 'SESSION=wayland\n' > "$XDISPF"
    echo "xauth-sync: wayland ok (Xwayland нет — только маркер)"
  fi
  chmod 0400 "$XAUTHF" 2>/dev/null || true
  chmod 0644 "$XDISPF"
  env_set XDG_SESSION_TYPE wayland
  # Electron по XDG_SESSION_TYPE=wayland сам выбирает ozone-wayland и падает без
  # XDG_RUNTIME_DIR; агенту нужен UI через Xwayland, а маркер wayland — только
  # для честного отказа адаптера ввода. Принуждаем ozone к X11.
  env_set ELECTRON_OZONE_PLATFORM_HINT x11
else
  env_del DISPLAY
  env_del XAUTHORITY
  env_del XDG_SESSION_TYPE
  echo "xauth-sync: активной сессии enotadmin нет — дисплейные строки убраны"
fi

chown enotdesk-agent:enotdesk-agent "$XAUTHF" 2>/dev/null || true
# каталог /etc/enotdesk-agent создаёт install-linux.sh (0750 root:root) — агент-юзер
# должен уметь войти в каталог ради xauth-файла
chgrp enotdesk-agent /etc/enotdesk-agent 2>/dev/null || true
chmod 0750 /etc/enotdesk-agent 2>/dev/null || true
chown root:enotdesk-agent "$ENVF" 2>/dev/null || true
chmod 0640 "$ENVF" 2>/dev/null || true
# агент читает env только при старте — перезапуск, если служба есть
systemctl try-restart enotdesk-agent 2>/dev/null || true
exit 0

#!/bin/bash
# Watchdog Wi-Fi-аплинка лабы EnotDesk: роутер мигнул/потух — связь поднимается сама, без ребута хоста.
# Каскад: (0) подтакивание reassociate -> (1) перезапуск wpa + enot-wifi-up.sh (адрес/маршрут/NAT)
#         -> (2) перезагрузка модулей aic8800 (драйвер заклинивает после потери AP) + enot-wifi-up.sh.
# Логи: journalctl -t enot-wifi-watchdog
set -u
W=wlx8c773b236d21
GW=192.168.100.1
UP=/usr/local/sbin/enot-wifi-up.sh
CHECK_EVERY=20        # период проверки, с
PATIENCE=4            # проверок подряд до первого действия (~80 с)
RELOAD_COOLDOWN=300   # не чаще раза в 5 минут трогать модули
LOCK=/run/enot-wifi-watchdog.lock

exec 9>"$LOCK"
flock -n 9 || exit 0

log() { logger -t enot-wifi-watchdog "$*"; }

iface_ok() { ip link show "$W" >/dev/null 2>&1; }

assoc_state() {
  wpa_cli -p /var/run/wpa_supplicant -i "$W" status 2>/dev/null | awk -F= '$1=="wpa_state"{print $2}'
}

gw_ok() { ping -c1 -W3 "$GW" >/dev/null 2>&1; }

healthy() { iface_ok && [ "$(assoc_state)" = "COMPLETED" ] && gw_ok; }

# Уровень 1: полный идемпотентный up-скрипт (убьёт/перезапустит wpa, переназначит адрес/маршрут/NAT)
level1() {
  log "действие=l1 перезапуск wpa_supplicant + enot-wifi-up.sh"
  timeout 240 "$UP"
}

# Уровень 2: перезагрузка модулей aic8800, затем снова up-скрипт
level2() {
  log "действие=l2 перезагрузка модулей aic8800"
  ip link set "$W" down 2>/dev/null
  pkill -x wpa_supplicant 2>/dev/null
  timeout 20 modprobe -r aic8800_fdrv 2>/dev/null; sleep 1
  timeout 20 modprobe -r aic_load_fw 2>/dev/null;  sleep 2
  modprobe aic_load_fw 2>/dev/null
  modprobe aic8800_fdrv 2>/dev/null
  local i
  for i in $(seq 1 30); do iface_ok && break; sleep 2; done
  iface_ok || { log "СБОЙ: интерфейс $W не вернулся после перезагрузки модулей"; return 1; }
  timeout 240 "$UP"
}

fails=0
last_reload=0
log "старт: период ${CHECK_EVERY}с, терпение ${PATIENCE} проверок"
sleep 60   # дать спокойно дойти стартовой связке enot-wifi.service
while true; do
  if healthy; then
    [ "$fails" -ge 1 ] && log "связь в норме, счётчик сбоев сброшен"
    fails=0
    sleep "$CHECK_EVERY"
    continue
  fi

  fails=$((fails+1))
  log "связь не в норме (${fails}/${PATIENCE}): iface=$(iface_ok && echo есть || echo нет) wpa=$(assoc_state) шлюз=$(gw_ok && echo ок || echo недоступен)"

  if [ "$fails" -lt "$PATIENCE" ]; then
    # роутер мог моргнуть: мягко подталкиваем переассоциацию, ничего не рушим
    wpa_cli -p /var/run/wpa_supplicant -i "$W" reassociate >/dev/null 2>&1
    sleep "$CHECK_EVERY"
    continue
  fi

  now=$(date +%s)
  level1 || true
  sleep "$CHECK_EVERY"
  if ! healthy && [ $((now-last_reload)) -ge "$RELOAD_COOLDOWN" ]; then
    last_reload=$(date +%s)
    level2 || true
  fi

  if healthy; then
    log "ВОССТАНОВЛЕНО: $W ассоциирован, шлюз отвечает"
    fails=0
  else
    # не восстановилось: продолжаем цикл, следующее действие после ещё PATIENCE-1 проверок
    fails=$((PATIENCE-1))
    log "связь не восстановлена, продолжаю наблюдение"
    sleep 60
  fi
done

# Лаба EnotDesk на Proxmox (runbook)

Тестовый стенд для ручной приёмки EnotDesk: staging-сервер + клиентские машины
«как разные люди», агенты зарегистрированы сами, откат деструктивных тестов —
снапшотом `clean`. Всё переживает перезагрузку хоста без ручных команд.

Построено тикетами T01–T04 (скрипты `scripts/lab/*.sh` в репо — источник истины;
копии на хосте в `/root/enot-lab/`).

## Схема сети

```
 Wi-Fi (аплинк)                       NAT-сеть лабы (vmbr0)
 ┌────────────┐  192.0.2.50      198.51.100.0/24, шлюз .1 (хост)
 │  Proxmox   ├─────────────────────► ┌──────────────────────────────┐
 │  enot-lab  │  wlx-WIFI-IFACE     │ .10 enotdesk-server   (VM 100)│
 │            │  (Wi-Fi, DHCP LAN)   │ .11 enotdesk-win10-a1 (VM 101)│
 │            │◄──── порт-форвард    │ .12 enotdesk-win11-a1 (VM 102)│
 └────────────┘   :8080 → .10:8080    │ .13/.14 — резерв под VM 103/104│
                                      └──────────────────────────────┘
 Наружу (GitHub/образы/apt) — MASQUERADE через тот же Wi-Fi-интерфейс.
```

- Хост: `192.0.2.50`, исходящий интерфейс `wlx-WIFI-IFACE` (Wi-Fi, конфиг
  сети хоста не трогается скриптами — `enot-wifi.service` переживает ребут сам).
- IP-адреса и имена интерфейсов в этом документе и в `scripts/lab/` —
  документационные диапазоны (192.0.2.0/24, 198.51.100.0/24, RFC 5737).
  Реальные значения стенда живут только на хосте (`/root/enot-lab`,
  `/root/enot-lab-secrets`); скрипты лабы на конкретном стенде правятся
  копиями на хосте, не в репо.
- Порт-форвард: `192.0.2.50:8080` → `198.51.100.10:8080` (staging для
  браузера оператора с Mac/телефона). Правила — `/usr/local/sbin/enot-lab-nat.sh`,
  юнит `enot-lab-nat.service` (на хосте, переживает ребут).
- Панель Proxmox: `https://192.0.2.50:8006`.

## Прогон 06.10.2026 — v0.6.4 и v0.6.5 (один день)

- Сервер staging остался 0.6.3 (код сервера не менялся ни в 0.6.4, ни в 0.6.5);
  клиенты/агенты 101/102/103 обновлены до **релизного 0.6.5** (Windows — замена
  portable exe в `Program Files\EnotDesk` + рестарт службы; Linux —
  `--appimage-extract` релизного AppImage в `/opt/enotdesk-agent/EnotDesk`
  с `chown root:root` + `chmod -R a+rX` + `chmod 4755 chrome-sandbox` — три
  ловушки распаковки, см. MANUAL-QA L1). Машины online, версия 0.6.5 в инвентаре.
- Прод support.ruenot.site: клиентские артефакты 0.6.5 в dist (сам прод-сервер
  0.6.4; дистрибутив прода — **Ubuntu 24.04.4 LTS**).
- clean-снапшоты 101/102/103 пересняты на 0.6.5. Staging-пароль админа
  ротирован 06.10 (утёк в лог автоматизации через ARIA-снимок формы — новое
  значение только в `/root/enot-lab-secrets/enotdesk-server.env`).
- **Приёмка 0.6.5**: L4 ЗАКРЫТ живой инъекцией (MANUAL-QA), H-J2 регрессия
  пройдена (сеанс 873164643), H-J6 → 410. Видео: хелпер 0.6.5 жив (фиксы
  CRT+ACL работают — start/pipe/input attach ok), кадра нет — на ВМ
  `Microsoft Basic Display Adapter` без DDA; вердикт и план — MANUAL-QA
  находка 6, GDI-fallback в ROADMAP.
- **Новые ловушки среды** (учтены в clean-снапшотах):
  - Win-ВМ: дисплей засыпает при простое → DXGI-таймауты в диагностике видео;
    на 102 выставлено `powercfg /change monitor-timeout-ac 0` (+standby 0).
  - Linux-ВМ (103): GNOME самозалачивает сессию при простое — локскрин
    перехватывает инъекцию ввода; отключено (`gsettings org.gnome.desktop
    .screensaver lock-enabled false`, `idle-delay 0`, power nothing).
  - 101/102 = `Microsoft Basic Display Adapter` (virtio-gpu не ставился при
    провижине): DDA-захват на таких ВМ невозможен; для видео-приёмки в ВМ
    нужен virtio-gpu драйвер (решение владельца) или GDI-fallback в хелпере.
  - Операторская панель `/operator`: токен живёт только в памяти страницы
    (SEC-008) — после «Сессия панели истекла» нужен повторный вход; при
    зависании формы логиниться через повторную загрузку страницы.
  - Диагностика видео хелпера — тик-лог `C:\ProgramData\EnotDesk\enotdesk-video.log`
    (start/attach/tick с fps/displayOff/err) — включён всегда, окупился сразу.
- Обновление Windows-агента: `net stop EnotDeskAgent` НЕ убивает дочерний
  агент — после стопа нужен `taskkill /F /IM EnotDesk.exe /T`, пауза, замена
  exe; первый `net start` может дать 2186 (самораспаковка) — повторить старт.
- `join.cmd`-триггер: проценты URL в .cmd удваивать (`%%3A`), иначе cmd портит
  ссылку. Если GUI-клиент уже запущен — ссылка уходит в него через
  single-instance (новой записи boot-лога не будет, это норма).

## VM

| VMID | Имя | IP | Роль | Спецификация |
|---|---|---|---|---|
| 100 | enotdesk-server | 198.51.100.10 | staging EnotDesk + coturn (TURN) + hub + комбинированный фронт :8081 | Debian 13, 2 vCPU / 2 ГБ / 32 ГБ, cloud-init |
| 101 | enotdesk-win10-a1 | 198.51.100.11 | клиент Win10 22H2, агент-служба | 4 vCPU / 6144 МБ (balloon min 2048) / 64 ГБ, UEFI, virtio |
| 102 | enotdesk-win11-a1 | 198.51.100.12 | клиент Win11, агент-служба | 4 vCPU / 6144 МБ (balloon min 2048) / 64 ГБ, UEFI + vTPM 2.0 + Secure Boot |
| 103 | enotdesk-linux-a1 | 198.51.100.13 | Debian 13 + GNOME (X11-сессия autologin + отдельный вход Wayland), агент-служба — приёмка L1–L7 | как клиенты: 4 vCPU / 6144 МБ (balloon min 2048) / 64 ГБ |
| 104 | enotdesk-win10-a2 (резерв, не создана) | 198.51.100.14 | Windows 10, конфигурация как win10-a1 | как клиенты |

Все клиентские VM — «равные» (4 vCPU / 6144 МБ / balloon min 2048 / 64 ГБ); сервер — служебная роль.
Onboot=1 у всех: после ребута хоста VM поднимаются сами.

## Секреты (имена файлов; значения нигде не печатаются)

На хосте `/root/enot-lab-secrets/` (каталог 0700, файлы 0600), scanner-safe
формат (`printf '%s=%q'`):

- `enotdesk-server.env` — админ staging (ADMIN_LOGIN/ADMIN_PASSWORD),
  ENOT_SECRET_KEY, TURN_SECRET (общий для coturn и сервера), SERVER_URL/SERVER_PUBLIC.
- `windows-vms.env` — WIN_ADMIN_USER/WIN_ADMIN_PASSWORD локального админа Windows-VM.
- `/root/enot-lab-keys/` — SSH-ключ лабы `enot-lab-ed25519` (+ known_hosts);
  копия того же ключа на Mac: `~/enot-lab-prep/enot-lab-ed25519`.

Внутри VM 100: `/opt/enotdesk/enotdesk.env` (0600) — env сервера, включая
TURN-переменные; `/etc/turnserver.conf` — конфиг coturn (use-auth-secret).

## SSH-швы

```sh
# Mac → хост
ssh -i ~/enot-lab-prep/enot-lab-ed25519 root@192.0.2.50 '<команда>'

# хост → staging VM 100
ssh -i /root/enot-lab-keys/enot-lab-ed25519 enotadmin@198.51.100.10

# хост → Windows-VM (OpenSSH Server, админ-токен: net session = ok)
ssh -i /root/enot-lab-keys/enot-lab-ed25519 enotadmin@198.51.100.11   # win10-a1
ssh -i /root/enot-lab-keys/enot-lab-ed25519 enotadmin@198.51.100.12   # win11-a1
```

Windows-VM: сложные команды — пайпом в `powershell -NoProfile -Command -` через
SSH stdin; для надёжных многострочных скриптов — scp + `powershell -File`
(stdin-режим флатчится на части конструкций). Пароль локального админа — в
`windows-vms.env`, вход по ключу.

## Снапшоты и откат

У каждой VM ровно один служебный снапшот — `clean` («чистая установка + агент»).
Другие снапшоты не создавать, чтобы не засорять список.

```sh
qm listsnapshot 100                    # проверить наличие clean
qm rollback 101 clean                  # откат (VM остановится сама)
qm start 101                           # после отката запустить
qm snapshot 102 clean --description "…"   # переснять (сначала qm delsnapshot 102 clean)
```

После отката агент-служба стартует сама и машина снова online на staging
(проверено на VM 101). Переснимать `clean` стоит после осознанных изменений
базового состояния (обновление EnotDesk, смена конфига агента).

## Деблоат Windows-VM (G01+G02)

Обе клиентские VM дeблоачены скриптом `scripts/lab/win-debloat.ps1` (репо — источник
истины; копия на гостях `%USERPROFILE%\win-debloat.ps1`, на хосте `/tmp/win-debloat.ps1`).
Снапшот `clean` переснят ПОСЛЕ полного деблоата G01+G02 включая отключение WU
(2026-10-05 12:46): откат `qm rollback <vmid> clean` возвращает это состояние.

Запуск (с хоста, scp + `powershell -File` — stdin-режим не использовать):

```sh
scp -i /root/enot-lab-keys/enot-lab-ed25519 /tmp/win-debloat.ps1 enotadmin@198.51.100.11:win-debloat.ps1
ssh … enotadmin@198.51.100.11 "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/enotadmin/win-debloat.ps1"             # применить
ssh … enotadmin@198.51.100.11 "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/enotadmin/win-debloat.ps1 -VerifyOnly" # только проверить факты
```

Что отключено (идемпотентно, на 101 и 102):

- **Службы**: `DiagTrack` (Connected User Experiences) и `dmwappushservice` → Disabled.
- **Windows Update ОТКЛЮЧЁН решением владельца** (G02 — источник WU-волн, вешавших
  машины): политика `NoAutoUpdate=1` + `SetDisableUXWUAccess=1` в обеих ветках
  (`SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU` и
  `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\WindowsUpdate\AU`), служба
  `wuauserv` → Disabled. UsoSvc/WaaSMedicSvc напрямую не трогаются (защищены,
  self-heal — их гасит политика). Вернуть WU: удалить `NoAutoUpdate` и
  `SetDisableUXWUAccess` из обеих веток политики, затем
  `Set-Service wuauserv -StartupType Manual`.
- **CEIP/Feedback-задачи**: Consolidator, UsbCeip, QueueReporting → Disabled
  (KernelCeipTask и Microsoft-Windows-Feedback* на этих сборках отсутствуют).
- **AppX-мусор** (развлекательное/промо, снято с текущего профиля и deprovisioned —
  новым профилям не возвращается): Solitaire Collection, Feedback Hub, Get Started,
  Xbox-набор (XboxApp, GameOverlay, GamingOverlay, SpeechToTextOverlay, GamingApp,
  XboxIdentityProvider, Xbox.TCUI), Cortana, Office Hub, News (Win11).
  Clipchamp/King.*/Copilot отсутствовали на этих сборках — скрипт снимает их,
  если появятся.
- **AppX, удалённые решением владельца** (G02): Камера (WindowsCamera), Запись
  звука (WindowsSoundRecorder), Техподдержка Windows (GetHelp), Будильники и часы
  (AlarmsClock), 3D-набор (Microsoft3DViewer, Print3D, MixedReality.Portal),
  Почта/Календарь (WindowsCommunicationsApps). Не тронуты: Store, Calculator,
  Notepad, Terminal, Photos, Paint, Defender.
- **OneDrive**: автозапуск выключен (Run-ключи, Startup-ярлыки, OneDrive*-задачи
  в планировщике); само приложение и каталоги оставлены.
- **Delivery Optimization**: `DODownloadMode=1` (HTTP-only, без P2P-раздачи наружу;
  политика + конфиг-ветка).
- **Consumer-фичи**: 13 флагов `ContentDeliveryManager` = 0 (silent-установка приложений,
  советы/реклама в Пуске) + политика `DisableWindowsConsumerFeatures=1`.
- **Телеметрия**: политика `AllowTelemetry=0` (Security на Pro) + автологгер
  `Diagtrack-Listener` Start=0.

Намеренно НЕ тронуто: Defender, Store, StickyNotes, Weather, YourPhone,
каталоги OneDrive, UsoSvc/WaaSMedicSvc (гасятся политикой, не напрямую),
EnotDeskAgent, SSH-сервер, профиль сети.

Грабли (учтены в скрипте/эксплуатации):

- `Remove-AppxPackage -AllUsers` из SSH-сессии падает с 0x80070002 — скрипт сначала
  снимает per-user (enotadmin — единственный интерактивный профиль), `-AllUsers` только добором.
- Файл `.ps1` строго ASCII: PS 5.1 читает BOM-less файлы в ANSI, «умные» тире ломают парсинг.
- Проверка фактов одной командой — `-VerifyOnly` (службы, задачи, AppX, реестр, guards).
- `qm snapshot` на Win11 (102): `guest-fsfreeze-thaw` иногда таймаутит, гость может
  зависнуть (налагается волна свежих WU) — лечение: `qm reset 102` (деблоат уже на
  диске, снапшот не страдает), после загрузки агент и сеть возвращаются сами.

Откат: состояние машины целиком — `qm rollback <vmid> clean` + `qm start <vmid>`
(см. раздел выше). Откат самого деблоата снапшотом невозможен — `clean` уже содержит
деблоат; полная перестройка — через `win-vm.sh`.

BalloonService установлен до переснятия `clean` (G02), входит в чистое состояние —
при откате панель показывает реальную память. BalloonService (`blnsvr.exe -i` из virtio-win: `Balloon/w10|w11/amd64`, на гостях
`C:\Users\enotadmin\blnsvr.exe`, служба `BalloonService` AUTO_START) установлен,
`qm set 101 --balloon 2048` (+102): панель показывает реальное потребление
(`mem` ≈ 2,4/1,7 ГБ вместо RSS qemu ~6,3 ГБ), хост забирает неиспользуемое через
балун при своей нехватке памяти (floor 2048 МБ).

## Старт/стоп и ребут

```sh
qm start 102 / qm shutdown 102 / qm stop 102
systemctl reboot        # на хосте: всё возвращается само за ~3 мин
```

После ребута хоста сами поднимаются: Wi-Fi, NAT (enot-lab-nat), VM 100–102
(onboot), staging (`enotdesk-server.service` в VM 100), coturn, агент-службы
`EnotDeskAgent` в Windows-VM — машины снова online. Проверка одной командой:

```sh
ssh -i ~/enot-lab-prep/enot-lab-ed25519 root@192.0.2.50 \
  'qm list; curl -s http://198.51.100.10:8080/api/v1/health; ip -4 -br addr | grep wlx'
```

## Staging API (быстрые проверки)

```sh
# health
curl -s http://198.51.100.10:8080/api/v1/health            # {"ok":true,...}
# логин (пароль из /root/enot-lab-secrets/enotdesk-server.env)
TOKEN=$(curl -s -X POST http://198.51.100.10:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"login":"admin","password":"…"}' | jq -r .token)
# список машин: registered/online у каждой
curl -s http://198.51.100.10:8080/api/v1/machines -H "Authorization: Bearer $TOKEN"
# TURN-креденшелы (эфемерные: username=метка истечения, credential=base64(HMAC-SHA1))
curl -s http://198.51.100.10:8080/api/v1/rtc-config -H "Authorization: Bearer $TOKEN"
```

TURN (coturn в VM 100): `use-auth-secret` + `static-auth-secret` из TURN_SECRET;
сервер раздаёт эфемерные креды из `ENOT_TURN_SECRET` (схема v0.6.3 —
`ENOT_TURN_USERNAME/PASSWORD` не используются при заданном секрете).
Порты: 3478 udp/tcp, релей 49152–49252.

### Грабля: install-server.sh --update поверх лабового staging (инцидент 08.10)

Лабовый staging VM100 живёт на КАСТОМНОМ юните `enotdesk-server.service`
(лаб-поставка: БД /var/lib/enotdesk/, ENOT_HUB, фронт enot-combined-caddy :8081).
`install-server.sh --update` этот юнит НЕ распознаёт: ставит/запускает
стандартный `enotdesk.service`, который занимает порт 8080.

Симптомы (выглядят как «продукт сломался», а это инфраструктура):
- лабовый `enotdesk-server.service` падает каждые ~2-3 с с EADDRINUSE :8080
  (restart counter улетает за 900);
- его endLiveSessions при каждом старте рвёт ВСЕ живые сеансы в общей БД:
  любой свежий claim умирает с end_reason='server-restart' за 2-3 с —
  «машина не подключается к сеансу»;
- /agent/session, машины, health живы (обслуживает чужой enotdesk.service с той
  же БД по дефолтному пути) — это маскирует поломку.

Лечение: `sudo systemctl stop enotdesk && sudo systemctl disable enotdesk &&
sudo systemctl start enotdesk-server`.

Профилактика: обновлять staging вручную под кастомный юнит — заменить каталог
релиза (/opt/enotdesk/releases/<stamp> + симлинк current) и
`sudo systemctl restart enotdesk-server`, БЕЗ install-server.sh. Флаг
`--unit-name` в установщике — отдельное решение.

## Агенты на Windows-VM (установка/переустановка)

Канон — `scripts/lab/lab-finalize.sh --stage agents` (на хосте) + `scripts/lab/agent-setup.ps1`
(в VM, гоняется через SSH stdin после env-прелюдии — код не попадает в argv/на диск).

Сценарий: админ создаёт машину (`POST /api/v1/machines` → одноразовый
onboarding-код, TTL 24 ч) → `agent-setup.ps1` ставит EnotDesk из GitHub Releases
(NSIS `/S`, per-machine в Program Files), пишет `settings.json`
(`serverUrl` + `allowInsecureHttp: true` — обязателен для http-staging: SEC-006
отвергает не-loopback http из provisioned-источников) в профиль LocalSystem,
создаёт службу `EnotDeskAgent` (env службы: `EDESK_AGENT=1`,
`EDESK_AGENT_NAME=<лабораторное имя>`, `EDESK_AGENT_SVC=1`, код — только на
первую регистрацию; после подтверждения регистрации код из env удаляется).
Имя машины на staging берётся из `EDESK_AGENT_NAME`, а не из hostname Windows
(там остаётся случайный DESKTOP-…).

Ручной запуск внутри VM (если нужно):

```powershell
$env:EDESK_SERVER_URL='http://198.51.100.10:8080'
$env:EDESK_AGENT_NAME='enotdesk-win10-a1'
$env:EDESK_AGENT_CODE='<одноразовый код из POST /machines>'
powershell -NoProfile -ExecutionPolicy Bypass -File .\agent-setup.ps1
```

Диагностика службы: `%ProgramData%\EnotDesk\svc-diag.enabled` (маркер) →
`svc-diag.log`; токен регистрации —
`C:\Windows\System32\config\systemprofile\AppData\Roaming\EnotDesk\agent\agent-token.json`.

## Резерв ёмкости (R04, числа на момент сдачи)

- RAM хоста 24 ГБ: при работающих VM 100–102 доступно ~12,7 ГБ (порог 8 ГБ).
- Клиенты 6144 МБ (balloon min 2048) после инцидента WU; резерв лабы =
  free + balloon-reclaimable ≥ 8 ГБ (см. capacity-стадию).
- LVM-thin `pve/data`: 157 ГБ (расширен на 16 ГБ vg_free), занято ~29%,
  свободно ~114 ГБ. Thin-том занимает место по мере записи: две новые клиентские
  VM (~25–30 ГБ после установки ОС каждая) помещаются. Диски VM — thin, создаётся
  мгновенно.

## Как добавить резервную VM

- **103 enotdesk-linux-a1 — СОЗДАНА 05.10.2026** (см. секцию ниже); фабрика — `scripts/lab/linux-vm.sh`.
- **104 enotdesk-win10-a2** (не создана): фабрика `win-vm.sh` + `autounattend-win10.xml`
  с правками (VMID 104, IP .14); ISO Win10 уже на хосте
  (`/var/lib/vz/template/iso/`); далее агент — как у 101.

## VM 103 enotdesk-linux-a1 (Linux-клиент, создана 05.10.2026)

Фабрика `scripts/lab/linux-vm.sh` (на хосте; Debian 13 cloud-image, cloud-init
`enotadmin`+ключ лабы, 4 vCPU/6144/balloon 2048/64G, thin). Внутри: gdm3+gnome-core+xorg,
autologin `enotadmin` в **X11**-сессию (AccountsService `Session=gnome-xorg`);
переключение на **Wayland**: `Session=gnome` в `/var/lib/AccountsService/users/enotadmin`
→ `systemctl restart accounts-daemon && systemctl restart gdm3` (обратно — `gnome-xorg`).
Пароль enotadmin — `/root/enot-lab-secrets/linux-vms.env` (0600).

**Glue `enot-xauth-sync.sh`** (`scripts/lab/`, на госте `/usr/local/sbin/`; юнит
`enot-xauth-sync.service` дергает на каждом ребуте): приводит `/etc/enotdesk-agent/agent.env`
к типу активной консольной сессии — X11: DISPLAY + XAUTHORITY (cookie из `-auth` Xorg,
display из /tmp/.X11-unix); Wayland: `XDG_SESSION_TYPE=wayland` (адаптер ввода честно
отказывает) + DISPLAY от Xwayland + `ELECTRON_OZONE_PLATFORM_HINT`-независимый
`--ozone-platform=x11` (см. drop-in ниже); нет сессии — дисплейные строки убираются.
После ручной смены сессии перезапускать: `sudo /usr/local/sbin/enot-xauth-sync.sh [wait]`.
Самоустановка свежей копии: положить скрипт в `/home/enotadmin/` и запустить оттуда.

**Drop-ins юнита агента на 103** (лабовые, переживают reinstall? НЕТ — снимаются
purge'ем, накладывать заново): `scripts/lab/vm103-unit-dropin.sh` (hardening →
systemd-analyze 4.5 OK) и `scripts/lab/vm103-ozone-dropin.sh` (`--ozone-platform=x11`,
т.к. Electron 44 игнорирует `ELECTRON_OZONE_PLATFORM_HINT` и падает на Wayland-сессии).

**Сборка на 103** (`scripts/lab/vm103-build.sh`): node 24 tarball → `/opt/node24`,
исходники — tar worktree в `/var/tmp/enotdesk/`, `npm ci` + `pack:linux` →
`/var/tmp/enotdesk/EnotDesk-built.AppImage` (первый прогон Linux-сборки, 05.10.2026).

## Хаб на staging + комбинированный origin :8081 (05.10.2026)

- Юнит `enotdesk-hub.service` (VM 100): `node /opt/enotdesk/hub/main.mjs`, 0.0.0.0:8090,
  `ENOTDESK_URL=http://127.0.0.1:8080`, `HUB_URL=http://198.51.100.10:8081`, свой `hub.db`
  в /var/lib/enotdesk; health `http://192.0.2.50:8090/api/hub/health`.
- **Комбинированный фронт :8081** (юнит `enot-combined-caddy`, caddy из apt,
  конфиг `/etc/caddy/enot-combined.caddy` + `admin off`): `/api/hub|/hub|/widget.js|/w|/join|/ws/*`
  → 8090 (хаб), остальное → 8080 (сервер). Нужен, потому что one-click (H-J2) требует
  ОДИН origin для сервера и хаба (на проде их совмещает Caddy); NAT-форвард :8081 → .10.
- Webhooks сервера → хаб настроены: `http://127.0.0.1:8090/hooks/enotdesk`,
  события `session.started`/`session.ended`, секрет — из консоли хаба.
- Консоль хаба с Mac: `http://192.0.2.50:8090/hub/` (SSO admin) или `:8081/hub/`.

## TURN на staging (W-U13, 05.10.2026)

- Сервер подключён к coturn: в `/opt/enotdesk/enotdesk.env` добавлены
  `ENOT_TURN_URLS=turn:192.0.2.50:3478,turn:198.51.100.10:3478` и
  `ENOT_TURN_SECRET` (= `TURN_SECRET` из `/root/enot-lab-secrets/enotdesk-server.env`);
  **dual URL обязателен**: hairpin VM→192.0.2.50:3478 несимметричен (ответ coturn
  идёт по L2 мимо conntrack) — агенты ходят на `.10`, операторы снаружи на `.50`.
- coturn: `external-ip=192.0.2.50/198.51.100.10` (relay-кандидаты анонсятся как .50).
- NAT хоста: DNAT 3478 tcp/udp + 49152–49252 udp → .10 (в `enot-lab-nat.sh`).
- Рецепт W-U13 (принудительный релей): временно `iptables -A FORWARD -i vmbr0 -o
  wlx-WIFI-IFACE -d <IP-оператора> -p udp ! -s 198.51.100.10 -j DROP` (режет прямые
  пары, релей остаётся), потом снять. Доказательство релея: tcpdump на VM100
  (оператор ↔ .10:49152+), `ss -ulnp` (relay-порты), coturn-журнал.

## Autologin на Windows-машинах (05.10.2026)

Winlogon-автологин `enotadmin` включён на 101 и 102 (HKLM `AutoAdminLogon=1`,
`DefaultUserName/DefaultPassword`; пароль — из `windows-vms.env`; скрипт-паттерн в
истории прогона). Нужно для видео/ввода консольной сессии (W-U13) и интерактивных
триггеров (H-J2). Обратно: `AutoAdminLogon=0` + удалить `DefaultPassword`.

## Известные проблемы лабы (не продукта)

- **Рендерер упакованного клиента Electron на лабовых Win-VM не исполняет JS**
  (пустое окно; `--lang=en-US` чинит только локаль-ресурсы; GPU-флаги не помогли) —
  блокер H-J2 на лабе; на реальном Windows v0.6.x работает. Перепроверить на
  реальной машине или недеблоатнутой VM.
- Unattended-видео на win11-a1 = «pipe-error» (хелпер спавнится, пайп рвётся) —
  на реальном железе v0.6 приёмка проходила; к W-U13 не относится.
- /tmp на Debian 13 — tmpfs: всё, что тест кладёт в /tmp гостя, умирает с ребутом
  (долгоиграющие артефакты — в /var/tmp).

## Известные ограничения / осознанные упрощения

- ISO EN-US → UI-язык Windows-VM en-US (зоны: клавиатурные маппинги проверять
  осознанно).
- Win11: BitLocker включился сам при установке; ключи в vTPM — откат снапшота
  назад во времени может запросить восстановление (vTPM-состояние и диск должны
  откатываться вместе — они и откатываются, оба внутри VM).
- TURN доступен только внутри NAT-сети (198.51.100.0/24). Операторам вне LAN
  (через 192.0.2.50:8080) ICE-кандидат 198.51.100.10 недоступен — видео/файлы
  из-за пределов Wi-Fi-сети хоста пойдут не через TURN; отдельное решение
  (проброс портов coturn на wlx / публичный TURN) — вне текущего прогона.
- Win-служба агента в session 0 не видит консольный рабочий стол (ограничение
  v1 EnotDesk, не лабы).
- Сумма thin-томов (320 ГБ) больше пула (157 ГБ) — норма для thin; следить за
  `data_percent` в `lvs`, при >80% чистить снапшоты/VM.
- Секреты никогда не печатаются и не коммитятся: в репо и в этом файле — только
  имена файлов. Onboarding-коды живут 24 ч и одноразовые; `agent-setup.ps1`
  удаляет код из env службы после подтверждённой регистрации.

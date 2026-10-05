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
- Порт-форвард: `192.0.2.50:8080` → `198.51.100.10:8080` (staging для
  браузера оператора с Mac/телефона). Правила — `/usr/local/sbin/enot-lab-nat.sh`,
  юнит `enot-lab-nat.service` (на хосте, переживает ребут).
- Панель Proxmox: `https://192.0.2.50:8006`.

## VM

| VMID | Имя | IP | Роль | Спецификация |
|---|---|---|---|---|
| 100 | enotdesk-server | 198.51.100.10 | staging EnotDesk + coturn (TURN) | Debian 13, 2 vCPU / 2 ГБ / 32 ГБ, cloud-init |
| 101 | enotdesk-win10-a1 | 198.51.100.11 | клиент Win10 22H2, агент-служба | 4 vCPU / 4 ГБ / 64 ГБ, UEFI, virtio |
| 102 | enotdesk-win11-a1 | 198.51.100.12 | клиент Win11, агент-служба | 4 vCPU / 4 ГБ / 64 ГБ, UEFI + vTPM 2.0 + Secure Boot |
| 103 | enotdesk-linux-a1 (резерв, не создана) | 198.51.100.13 | Debian с десктопом (X11 + отдельный вход Wayland) — под приёмку L4/L5 | как клиенты: 4 vCPU / 4 ГБ / 64 ГБ |
| 104 | enotdesk-win10-a2 (резерв, не создана) | 198.51.100.14 | Windows 10, конфигурация как win10-a1 | как клиенты |

Все клиентские VM — «равные» (4 vCPU / 4 ГБ / 64 ГБ); сервер — служебная роль.
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

## Деблоат Windows-VM (G01)

Обе клиентские VM дeблоачены скриптом `scripts/lab/win-debloat.ps1` (репо — источник
истины; копия на гостях `%USERPROFILE%\win-debloat.ps1`, на хосте `/tmp/win-debloat.ps1`).
Снапшот `clean` переснят ПОСЛЕ деблоата (2026-10-05): откат `qm rollback <vmid> clean`
возвращает уже дeблоаченное состояние.

Запуск (с хоста, scp + `powershell -File` — stdin-режим не использовать):

```sh
scp -i /root/enot-lab-keys/enot-lab-ed25519 /tmp/win-debloat.ps1 enotadmin@198.51.100.11:win-debloat.ps1
ssh … enotadmin@198.51.100.11 "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/enotadmin/win-debloat.ps1"             # применить
ssh … enotadmin@198.51.100.11 "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/enotadmin/win-debloat.ps1 -VerifyOnly" # только проверить факты
```

Что отключено (идемпотентно, на 101 и 102):

- **Службы**: `DiagTrack` (Connected User Experiences) и `dmwappushservice` → Disabled.
- **CEIP/Feedback-задачи**: Consolidator, UsbCeip, QueueReporting → Disabled
  (KernelCeipTask и Microsoft-Windows-Feedback* на этих сборках отсутствуют).
- **AppX-мусор** (развлекательное/промо, снято с текущего профиля и deprovisioned —
  новым профилям не возвращается): Solitaire Collection, Feedback Hub, Get Started,
  Xbox-набор (XboxApp, GameOverlay, GamingOverlay, SpeechToTextOverlay, GamingApp),
  Cortana, Office Hub, News (Win11). Clipchamp/King.*/Copilot отсутствовали на этих
  сборках — скрипт снимает их, если появятся.
- **OneDrive**: автозапуск выключен (Run-ключи, Startup-ярлыки, OneDrive*-задачи
  в планировщике); само приложение и каталоги оставлены.
- **Delivery Optimization**: `DODownloadMode=1` (HTTP-only, без P2P-раздачи наружу;
  политика + конфиг-ветка).
- **Consumer-фичи**: 13 флагов `ContentDeliveryManager` = 0 (silent-установка приложений,
  советы/реклама в Пуске) + политика `DisableWindowsConsumerFeatures=1`.
- **Телеметрия**: политика `AllowTelemetry=0` (Security на Pro) + автологгер
  `Diagtrack-Listener` Start=0.

Намеренно НЕ тронуто («штатный рабочий ПК клиента»): Windows Update (`wuauserv`),
Defender, Store, StickyNotes, Weather, YourPhone, каталоги OneDrive,
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
- LVM-thin `pve/data`: 157 ГБ (расширен на 16 ГБ vg_free), занято ~29%,
  свободно ~114 ГБ. Thin-том занимает место по мере записи: две новые клиентские
  VM (~25–30 ГБ после установки ОС каждая) помещаются. Диски VM — thin, создаётся
  мгновенно.

## Как добавить резервную VM

- **103 enotdesk-linux-a1** (Debian десктоп): образ `debian-13-generic-amd64.qcow2`
  уже на хосте (`/root/images/`); скопировать фабрику из `server-vm.sh` с правками
  (VMID 103, 4 vCPU / 4 ГБ / 64 ГБ, ipconfig0 .13), внутрь — десктоп (X11-сессия +
  отдельный вход Wayland), `EDESK_AGENT=1`-агент как systemd-юнит по образцу
  `enotdesk-server.service` (адрес staging из `SERVER_URL`). Зарегистрировать:
  `POST /machines` → код → регистрация агента. Снапшот `clean` после проверки.
- **104 enotdesk-win10-a2**: фабрика `win-vm.sh` + `autounattend-win10.xml`
  с правками (VMID 104, IP .14); ISO Win10 уже на хосте
  (`/var/lib/vz/template/iso/`); далее агент — как у 101.

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

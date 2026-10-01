@echo off
REM ============================================================
REM EnotDesk agent - service install (Windows 10+/Server 2019+)
REM Запускать из cmd с правами администратора.
REM Сначала заполните переменные ниже (APP_EXE обязателен).
REM ============================================================
setlocal

REM --- Параметры (проверьте и при необходимости поправьте) ---
REM Путь к исполняемому файлу агента (распакованная сборка клиента).
set "APP_EXE=C:\Program Files\EnotDesk\EnotDesk.exe"
REM Адрес сервера EnotDesk (обязателен).
set "SERVER_URL=https://enotdesk.example.com"
REM Имя машины в списке (по умолчанию - имя компьютера).
set "AGENT_NAME=%COMPUTERNAME%"
REM Имя службы Windows.
set "SVC_NAME=EnotDeskAgent"

if not exist "%APP_EXE%" (
  echo [ошибка] не найден %APP_EXE% - укажите APP_EXE и повторите.
  exit /b 1
)
if "%SERVER_URL%"=="" (
  echo [ошибка] задайте SERVER_URL - адрес вашего сервера EnotDesk.
  exit /b 1
)

REM --- Настройки агента пишутся в профиль LocalSystem, потому что
REM --- службу запускает SCM от имени LocalSystem, а не текущего админа.
REM --- WriteAllText (в отличие от Set-Content -Encoding UTF8 в PowerShell 5.1)
REM --- пишет UTF-8 БЕЗ BOM: JSON.parse клиента падает на BOM-файле (ревью 28.09).
set "AGENT_PROFILE=%SystemRoot%\System32\config\systemprofile\AppData\Roaming\EnotDesk\agent"
powershell.exe -NoProfile -Command "$d='%AGENT_PROFILE%'; New-Item -ItemType Directory -Force -Path $d | Out-Null; [System.IO.File]::WriteAllText((Join-Path $d 'settings.json'), (@{serverUrl='%SERVER_URL%'} | ConvertTo-Json) + [Environment]::NewLine); icacls $d /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' /grant '*S-1-5-32-544:(OI)(CI)F' | Out-Null; exit $LASTEXITCODE"
REM Права выдаются по well-known SID (SYSTEM=*S-1-5-18, Администраторы=*S-1-5-32-544):
REM имена групп локализованы — на русской Windows 'Administrators' не резолвится
REM (живой сеанс 28.09: «Сопоставление между именами и SID не было произведено»).
REM exit $LASTEXITCODE в конце обязателен: без него код выхода powershell.exe
REM определяется успешным Out-Null, а не провалившимся icacls (ревью 28.09).
if errorlevel 1 (
  echo [ошибка] не удалось записать settings.json в %AGENT_PROFILE%.
  exit /b 1
)

REM --- Создание/обновление службы: автостарт, описание. Идемпотентно:
REM --- повторный запуск по существующей службе ОБНОВЛЯЕТ конфиг (апгрейд
REM --- бинарников), а не падает на «already exists» (наблюдение 01.10:
REM --- апгрейд оставлял службу Stopped, т.к. create падал и до start
REM --- дело не доходило).
sc.exe query "%SVC_NAME%" >nul 2>&1
if errorlevel 1 (
  sc.exe create "%SVC_NAME%" binPath= "\"%APP_EXE%\"" start= auto obj= LocalSystem DisplayName= "EnotDesk Agent"
  if errorlevel 1 goto :fail
) else (
  sc.exe config "%SVC_NAME%" binPath= "\"%APP_EXE%\"" start= auto obj= LocalSystem DisplayName= "EnotDesk Agent"
  if errorlevel 1 goto :fail
)
sc.exe description "%SVC_NAME%" "EnotDesk: unattended agent. Auto-registers on the EnotDesk server, waits for operator claims. No window by design; managed via this service (see docs/AGENT.md)."
if errorlevel 1 goto :fail

REM --- Переменные окружения для процесса службы. EDESK_AGENT_SVC=1 включает
REM --- родительский SCM-режим (win-service.mjs): служебный процесс сам отвечает
REM --- диспетчеру служб (StartServiceCtrlDispatcher) и держит живым дочерний
REM --- агент; без него SCM убивает процесс по 1053 (дефект №4, сеанс 28.09).
REM --- Пишем ОБА значения: Environment читает сам services.exe (нативный
REM --- механизм SCM), AppEnvironment оставлен для совместимости с обёртками
REM --- srvany/nssm и старой документацией (ревью 28.09: AppEnvironment SCM
REM --- не читает — раньше из-за этого переменные до процесса не доходили).
REM --- Разделитель строк в REG_MULTI_SZ - \0.
reg add "HKLM\SYSTEM\CurrentControlSet\Services\%SVC_NAME%" /v Environment /t REG_MULTI_SZ /d "EDESK_AGENT=1\0EDESK_AGENT_NAME=%AGENT_NAME%\0EDESK_AGENT_SVC=1" /f
if errorlevel 1 goto :fail
reg add "HKLM\SYSTEM\CurrentControlSet\Services\%SVC_NAME%" /v AppEnvironment /t REG_MULTI_SZ /d "EDESK_AGENT=1\0EDESK_AGENT_NAME=%AGENT_NAME%\0EDESK_AGENT_SVC=1" /f
if errorlevel 1 goto :fail

REM --- Автоперезапуск при сбое: 5с, 10с, затем каждые 30с в течение суток ---
sc.exe failure "%SVC_NAME%" reset= 86400 actions= restart/5000/restart/10000/restart/30000
if errorlevel 1 goto :fail

REM --- Гарантированный старт (и рестарт при апгрейде: новые файлы подхватит
REM --- только новый процесс). Остановка перед стартом — только если бежит.
sc.exe query "%SVC_NAME%" 2>nul | find.exe /i "RUNNING" >nul
if errorlevel 1 goto :ensure-started
sc.exe stop "%SVC_NAME%" >nul 2>&1
set WAITN=0
:wait-stop-loop
timeout.exe /t 2 /nobreak >nul
sc.exe query "%SVC_NAME%" 2>nul | find.exe /i "RUNNING" >nul
if errorlevel 1 goto :ensure-started
set /a WAITN=%WAITN%+1
if %WAITN% lss 10 goto :wait-stop-loop
echo [предупреждение] служба не остановилась за 20 с - продолжаем со стартом поверх.
:ensure-started
sc.exe start "%SVC_NAME%"
if errorlevel 1 (
  echo [ошибка] служба создана, но не запустилась - см. Event Viewer ^(System^) и "sc query %SVC_NAME%".
  exit /b 1
)
echo.
echo Готово. Служба %SVC_NAME% создана/обновлена и запущена (start= auto).
echo Повторный запуск скрипта безопасен: конфиг обновляется, служба перезапускается.
echo Логи в v1 не пишутся на диск (см. docs/AGENT.md, раздел "Логи").
echo Регистрация машины проверяется на сервере: список машин / journal-стиль диагностики -
REM Диагностика: остановите службу и запустите в консоли:
REM   set EDESK_AGENT=1 && set EDESK_AGENT_NAME=%AGENT_NAME% && "%APP_EXE%"
exit /b 0

:fail
echo [ошибка] команда завершилась с ошибкой (нужны права администратора?).
exit /b 1

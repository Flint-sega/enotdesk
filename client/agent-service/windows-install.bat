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
set "AGENT_PROFILE=%SystemRoot%\System32\config\systemprofile\AppData\Roaming\EnotDesk\agent"
powershell.exe -NoProfile -Command "$d='%AGENT_PROFILE%'; New-Item -ItemType Directory -Force -Path $d | Out-Null; @{serverUrl='%SERVER_URL%'} | ConvertTo-Json | Set-Content -Encoding UTF8 -Path (Join-Path $d 'settings.json'); icacls $d /inheritance:r /grant 'SYSTEM:(OI)(CI)F' /grant 'Administrators:(OI)(CI)F' | Out-Null"
if errorlevel 1 (
  echo [ошибка] не удалось записать settings.json в %AGENT_PROFILE%.
  exit /b 1
)

REM --- Создание службы: автостарт, описание ---
sc.exe create "%SVC_NAME%" binPath= "\"%APP_EXE%\"" start= auto obj= LocalSystem DisplayName= "EnotDesk Agent"
if errorlevel 1 goto :fail
sc.exe description "%SVC_NAME%" "EnotDesk: unattended agent. Auto-registers on the EnotDesk server, waits for operator claims. No window by design; managed via this service (see docs/AGENT.md)."
if errorlevel 1 goto :fail

REM --- Переменные окружения для процесса службы (EDESK_AGENT=1 включает headless-режим).
REM --- AppEnvironment читается SCM при запуске процесса службы; разделитель строк - \0.
reg add "HKLM\SYSTEM\CurrentControlSet\Services\%SVC_NAME%" /v AppEnvironment /t REG_MULTI_SZ /d "EDESK_AGENT=1\0EDESK_AGENT_NAME=%AGENT_NAME%" /f
if errorlevel 1 goto :fail

REM --- Автоперезапуск при сбое: 5с, 10с, затем каждые 30с в течение суток ---
sc.exe failure "%SVC_NAME%" reset= 86400 actions= restart/5000/restart/10000/restart/30000
if errorlevel 1 goto :fail

sc.exe start "%SVC_NAME%"
echo.
echo Готово. Служба %SVC_NAME% создана и запущена (start= auto).
echo Логи в v1 не пишутся на диск (см. docs/AGENT.md, раздел "Логи").
echo Регистрация машины проверяется на сервере: список машин / journal-стиль диагностики -
REM Диагностика: остановите службу и запустите в консоли:
REM   set EDESK_AGENT=1 && set EDESK_AGENT_NAME=%AGENT_NAME% && "%APP_EXE%"
exit /b 0

:fail
echo [ошибка] команда завершилась с ошибкой (нужны права администратора?).
exit /b 1

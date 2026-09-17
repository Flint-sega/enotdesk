@echo off
REM ============================================================
REM EnotDesk agent - service remove (Windows 10+/Server 2019+)
REM Запускать из cmd с правами администратора.
REM ============================================================
setlocal

set "SVC_NAME=EnotDeskAgent"
REM Профиль агента (LocalSystem) - токен машины лежит здесь.
set "AGENT_PROFILE=%SystemRoot%\System32\config\systemprofile\AppData\Roaming\EnotDesk\agent"

sc.exe stop "%SVC_NAME%" >nul 2>&1
sc.exe delete "%SVC_NAME%"
if errorlevel 1 (
  echo [ошибка] не удалось удалить службу (нужны права администратора?).
  exit /b 1
)

echo Служба %SVC_NAME% остановлена и удалена.
echo.
echo Токен машины остался в %AGENT_PROFILE%\agent-token.json
set /p PURGE="Удалить токен и настройки машины окончательно? [y/N] "
if /i "%PURGE%"=="y" (
  rmdir /s /q "%AGENT_PROFILE%"
  echo Профиль агента удалён: %AGENT_PROFILE%
  echo Не забудьте также удалить/отозвать машину на сервере (список машин), иначе запись останется.
) else (
  echo Профиль сохранён. При повторной установке служба подхватит прежний токен.
)
exit /b 0

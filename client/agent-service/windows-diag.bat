@echo off
rem ================================================================
rem  EnotDesk service DIAG (W-U2): enables the file log of the
rem  service parent/child, restarts EnotDeskAgent and collects state.
rem  Run AS ADMINISTRATOR. Then send svc-diag.log to support.
rem ================================================================
setlocal EnableExtensions
set "ENOT_DIR=%ProgramData%\EnotDesk"
if not exist "%ENOT_DIR%" mkdir "%ENOT_DIR"

echo [1/4] Enabling diag log marker...
type nul > "%ENOT_DIR%\svc-diag.enabled"
echo       marker: %ENOT_DIR%\svc-diag.enabled

echo [2/4] Restarting EnotDeskAgent service...
net stop EnotDeskAgent >nul 2>&1
timeout /t 2 /nobreak >nul
net start EnotDeskAgent
echo       waiting 12 s for the service to settle...
timeout /t 12 /nobreak >nul

echo [3/4] Service state (sc query):
sc query EnotDeskAgent
sc qc EnotDeskAgent | findstr /i "BINARY_PATH_NAME START_TYPE SERVICE_NAME"

echo [4/4] Recent Service Control Manager events:
wevtutil qe System /q:"*[System[Provider[@Name='Service Control Manager']]]" /c:8 /rd:true /f:text 2>nul

echo.
echo ------- diag log tail (%ENOT_DIR%\svc-diag.log) -------
if exist "%ENOT_DIR%\svc-diag.log" (
  powershell -NoProfile -Command "Get-Content -LiteralPath $env:ProgramData'\EnotDesk\svc-diag.log' -Tail 60"
) else (
  echo log file not created - the service process never started or the marker path is wrong
)
echo -----------------------------------------------------
echo.
echo Done. Send this file to support: %ENOT_DIR%\svc-diag.log
pause

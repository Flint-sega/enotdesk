@echo off
rem ================================================================
rem  EnotDesk service DIAG (W-U2): enables the file log of the
rem  service parent/child, restarts EnotDeskAgent and collects state.
rem  Run AS ADMINISTRATOR. Then send svc-diag.log to support.
rem  To DISABLE diag collection later, run:  windows-diag.bat off
rem ================================================================
setlocal EnableExtensions
set "ENOT_DIR=%ProgramData%\EnotDesk"

rem "off" turns diag collection off (marker removed, log stays for support)
if /i "%~1"=="off" (
  if exist "%ENOT_DIR%\svc-diag.enabled" (
    del "%ENOT_DIR%\svc-diag.enabled"
    if errorlevel 1 (
      echo [error] could not remove the marker - run this AS ADMINISTRATOR.
    ) else (
      echo [off] diag collection disabled: marker %ENOT_DIR%\svc-diag.enabled removed.
    )
  ) else (
    echo [off] marker not present - diag collection is already off.
  )
  echo        Old log kept at %ENOT_DIR%\svc-diag.log - delete it if not needed.
  pause
  exit /b 0
)

rem Administrator rights are REQUIRED (service restart + marker in ProgramData):
rem without them every step below fails silently and the report misleads support.
rem fltmc, not "net session": the latter false-negatives an admin when the
rem Server (LanmanServer) service is stopped on hardened machines.
fltmc >nul 2>&1
if errorlevel 1 (
  echo [error] Run this script AS ADMINISTRATOR - nothing was changed.
  echo         To just disable diag: run as admin:  windows-diag.bat off
  pause
  exit /b 1
)

if not exist "%ENOT_DIR%" mkdir "%ENOT_DIR%"

echo [1/4] Enabling diag log marker...
type nul > "%ENOT_DIR%\svc-diag.enabled"
if errorlevel 1 (
  echo [error] cannot create the marker - check permissions on %ENOT_DIR%
  pause
  exit /b 1
)
echo       marker: %ENOT_DIR%\svc-diag.enabled

echo [2/4] Restarting EnotDeskAgent service...
net stop EnotDeskAgent >nul 2>&1
timeout /t 2 /nobreak >nul
net start EnotDeskAgent
if errorlevel 1 echo [warn] service did not start - see the error above, state is collected below anyway
echo       waiting 12 s for the service to settle...
timeout /t 12 /nobreak >nul

echo [3/4] Service state:
rem no findstr on sc qc field labels: they are localized on non-English Windows
rem and the filter silently produced an empty section (review v0.4.6)
sc query EnotDeskAgent
sc qc EnotDeskAgent

echo [4/4] Recent Service Control Manager events:
wevtutil qe System /q:"*[System[Provider[@Name='Service Control Manager']]]" /c:8 /rd:true /f:text 2>nul

echo.
echo ------- diag log tail (%ENOT_DIR%\svc-diag.log) -------
if exist "%ENOT_DIR%\svc-diag.log" (
  powershell -NoProfile -Command "Get-Content -LiteralPath $env:ProgramData'\EnotDesk\svc-diag.log' -Tail 60"
  echo.
  echo Done. Send this file to support: %ENOT_DIR%\svc-diag.log
) else (
  echo log file not created. If "sc query" above shows RUNNING, the service was
  echo not restarted by this script ^(no admin rights or start failed^) - the log
  echo is only written on service start.
)
echo -----------------------------------------------------
echo When the ticket is closed, disable diag:  windows-diag.bat off
pause

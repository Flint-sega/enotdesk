@echo off
rem GDI-fallback lab test orchestrator (ticket 02). Run ON THE VM as the
rem console user:  gdi-run.cmd <hex-token>
rem Starts the helper in the CONSOLE session via an interactive scheduled task
rem (schtasks /IT), talks to its pipe from this session with the PS client,
rem saves the first JPEG frame, then kills the helper and cleans up the task.
rem stdout of the helper is captured to stdout.log (ticks show "mode").

set DIR=C:\Users\enotadmin\gditest
set TOKEN=%~1
if "%TOKEN%"=="" if exist %DIR%\token.txt set /p TOKEN=<%DIR%\token.txt
if "%TOKEN%"=="" ( echo usage: gdi-run.cmd ^<hex-token^> or %DIR%\token.txt & exit /b 2 )

schtasks /Create /TN EnotGdiTest /TR "cmd /c %DIR%\enotdesk-video.exe --token %TOKEN% > %DIR%\stdout.log 2>&1" /SC ONCE /ST 23:59 /F /IT
if errorlevel 1 ( echo TASK-CREATE-FAIL & exit /b 2 )
schtasks /Run /TN EnotGdiTest
if errorlevel 1 ( echo TASK-RUN-FAIL & schtasks /Delete /TN EnotGdiTest /F & exit /b 2 )
echo HELPER-LAUNCHED

powershell -NoProfile -ExecutionPolicy Bypass -File %DIR%\gdi-test.ps1 -Token %TOKEN% -Seconds 60 -OutJpeg %DIR%\frame.jpg
set RC=%ERRORLEVEL%

taskkill /F /IM enotdesk-video.exe /T >nul 2>&1
schtasks /Delete /TN EnotGdiTest /F >nul 2>&1
echo CLIENT-RC=%RC%
exit /b %RC%

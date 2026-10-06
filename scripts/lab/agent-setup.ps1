# EnotDesk agent one-shot setup for Windows (lab T04).
# Adapted from agent-setup-v043.bat (proven SCM setup) to parameterized PowerShell:
# server url, one-time onboarding code and machine name come from environment
# variables so no secret is ever hardcoded in the repo.
#
# Required env:
#   EDESK_SERVER_URL   staging base url, e.g. http://198.51.100.10:8080
#   EDESK_AGENT_CODE   one-time onboarding code (burned at registration,
#                      then removed from the service environment)
#   EDESK_AGENT_NAME   machine name on staging (lab IP-plan name)
# Optional env:
#   EDESK_VERSION      release tag to download if the app is not installed
#                      (default v0.6.4)
#
# Steps:
#   1) locate (or silently install) EnotDesk.exe
#   2) enotdesk-server.txt next to the exe (first-run server url)
#   3) settings.json (no BOM) in the LocalSystem agent profile
#   4) EnotDeskAgent service (auto, restart on crash), SCM-parent mode via
#      EDESK_AGENT_SVC=1; registration happens with the one-time code, then
#      the code is stripped from the service environment.
#
# Run: elevated PowerShell ->
#   $env:EDESK_SERVER_URL='...'; $env:EDESK_AGENT_CODE='...'; $env:EDESK_AGENT_NAME='...';
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\agent-setup.ps1
# Lab usage: lab-finalize.sh pipes this file via SSH stdin after the env prelude,
# so the code never lands on the VM disk.

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  Write-Output "[agent-setup] FAIL: $msg"
  exit 1
}

$ServerUrl = $env:EDESK_SERVER_URL
$AgentCode = $env:EDESK_AGENT_CODE
$AgentName = $env:EDESK_AGENT_NAME
$AppVersion = if ($env:EDESK_VERSION) { $env:EDESK_VERSION } else { 'v0.6.5' }

if (-not $ServerUrl) { Fail 'EDESK_SERVER_URL is empty' }
if (-not $AgentCode) { Fail 'EDESK_AGENT_CODE is empty' }
if (-not $AgentName) { Fail 'EDESK_AGENT_NAME is empty' }
if ($AgentCode.Length -gt 200) { Fail 'EDESK_AGENT_CODE looks malformed (too long)' }
if ($ServerUrl -notmatch '^https?://') { Fail 'EDESK_SERVER_URL must start with http(s)://' }

# elevated token required for sc.exe create
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'not elevated (Administrator token required)' }

$SvcName = 'EnotDeskAgent'

# --- 1) locate or install the app ---
$AppExe = $null
foreach ($p in @(
  "$env:ProgramFiles\EnotDesk\EnotDesk.exe",
  "${env:ProgramFiles(x86)}\EnotDesk\EnotDesk.exe",
  "$env:LOCALAPPDATA\Programs\enotdesk\EnotDesk.exe"
)) {
  if ($p -and (Test-Path $p)) { $AppExe = $p; break }
}

if (-not $AppExe) {
  $setupUrl = "https://github.com/Flint-sega/enotdesk/releases/download/$AppVersion/EnotDesk-win-x64-setup.exe"
  $setupPath = Join-Path $env:TEMP 'EnotDesk-win-x64-setup.exe'
  Write-Output "[agent-setup] app not found, downloading $setupUrl"
  & curl.exe -sSfL --ssl-no-revoke -o $setupPath $setupUrl
  if ($LASTEXITCODE -ne 0) { Fail "download failed (curl exit $LASTEXITCODE)" }
  $size = (Get-Item $setupPath).Length
  if ($size -lt 50MB) { Fail "downloaded setup is too small ($size bytes)" }
  Write-Output "[agent-setup] silent install (NSIS /S, per-machine -> Program Files)"
  $proc = Start-Process -FilePath $setupPath -ArgumentList '/S' -PassThru -Wait
  if ($proc.ExitCode -ne 0) { Fail "setup exit code $($proc.ExitCode)" }
  # NSIS-стаб может выйти раньше, чем elevation-хелпер допишет файлы —
  # ждём появления exe в любом из стандартных мест до 5 минут
  $found = $false
  foreach ($i in 1..150) {
    foreach ($p in @(
      "$env:ProgramFiles\EnotDesk\EnotDesk.exe",
      "${env:ProgramFiles(x86)}\EnotDesk\EnotDesk.exe",
      "$env:LOCALAPPDATA\Programs\enotdesk\EnotDesk.exe"
    )) {
      if ($p -and (Test-Path $p)) { $AppExe = $p; $found = $true; break }
    }
    if ($found) { break }
    Start-Sleep -Seconds 2
  }
  Remove-Item -Force $setupPath -ErrorAction SilentlyContinue
  if (-not $found) { Fail 'installer finished but EnotDesk.exe did not appear' }
}
Write-Output "[agent-setup] using exe: $AppExe"
$AppDir = Split-Path -Parent $AppExe

# --- 2) server url next to the exe (informational for https deployments; the
# agent rejects non-loopback http from provisioned sources, see SEC-006) ---
Set-Content -Path (Join-Path $AppDir 'enotdesk-server.txt') -Value $ServerUrl -NoNewline -Encoding ASCII
Write-Output "[agent-setup] server url written next to exe"

# --- 3) settings.json in the LocalSystem agent profile (systemprofile).
# allowInsecureHttp:true is REQUIRED for a plain-http staging server
# (e.g. http://198.51.100.10:8080 in the lab): SEC-006 rejects non-loopback
# http from saved settings unless the flag is set. ---
$AgentProfile = "$env:SystemRoot\System32\config\systemprofile\AppData\Roaming\EnotDesk\agent"
New-Item -ItemType Directory -Force -Path $AgentProfile | Out-Null
$settings = (@{ serverUrl = $ServerUrl; allowInsecureHttp = $true } | ConvertTo-Json) + [Environment]::NewLine
[System.IO.File]::WriteAllText((Join-Path $AgentProfile 'settings.json'), $settings,
  (New-Object System.Text.UTF8Encoding($false)))
# ACL: SYSTEM + Administrators only (same hardening as the v043 bat)
icacls $AgentProfile /inheritance:r /grant '*S-1-5-18:(OI)(CI)F' /grant '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Write-Output "[agent-setup] settings.json written ($AgentProfile, allowInsecureHttp=true)"

# --- 4) service ---
$svc = Get-Service -Name $SvcName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Output "[agent-setup] removing existing service $SvcName"
  & sc.exe stop $SvcName | Out-Null
  Start-Sleep -Seconds 3
  & sc.exe delete $SvcName | Out-Null
  Start-Sleep -Seconds 2
}

& sc.exe create $SvcName binPath= "`"$AppExe`"" start= auto obj= LocalSystem DisplayName= 'EnotDesk Agent' | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "sc create exit $LASTEXITCODE" }
& sc.exe description $SvcName 'EnotDesk: unattended agent (lab). Auto-registers with a one-time code, waits for operator claims.' | Out-Null

# services.exe reads REG_MULTI_SZ Environment natively; AppEnvironment kept for
# srvany/nssm compatibility (same as the reference bat).
# NOTE: reg.exe parses the LITERAL two-character sequence \0 inside /d as the
# REG_MULTI_SZ separator. Do NOT embed real NUL bytes (PowerShell `0) in the
# argument - process args cannot contain NUL and the value gets truncated
# (seen live: only "EDESK_AGENT=1" survived, service then failed with 1053).
$envBlock = 'EDESK_AGENT=1\0EDESK_AGENT_NAME=' + $AgentName + '\0EDESK_AGENT_SVC=1\0EDESK_AGENT_CODE=' + $AgentCode
$envBlockNoCode = 'EDESK_AGENT=1\0EDESK_AGENT_NAME=' + $AgentName + '\0EDESK_AGENT_SVC=1'
foreach ($valueName in @('Environment', 'AppEnvironment')) {
  & reg.exe add "HKLM\SYSTEM\CurrentControlSet\Services\$SvcName" /v $valueName /t REG_MULTI_SZ /d $envBlock /f | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "reg add $valueName exit $LASTEXITCODE" }
}
# verify the MULTI_SZ actually split (guards against silent truncation)
$envCheck = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$SvcName").Environment
if ($envCheck.Count -lt 4 -or -not ($envCheck -contains "EDESK_AGENT_CODE=$AgentCode")) {
  Fail "service Environment incomplete: $($envCheck.Count) value(s)"
}
& sc.exe failure $SvcName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

Write-Output '[agent-setup] starting service'
& sc.exe start $SvcName | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "sc start exit $LASTEXITCODE (check Event Viewer System)" }

# registration: the child agent writes agent-token.json on success. Poll for it
# and confirm with /agent/session (200) BEFORE stripping the code - a fixed
# sleep stripped the code too early on a cold start (Defender scanning the
# 246MB exe) and the machine never registered.
$TokenPath = Join-Path $AgentProfile 'agent-token.json'
$registered = $false
foreach ($i in 1..72) {
  Start-Sleep -Seconds 5
  if (Test-Path $TokenPath) {
    # curl.exe, not Invoke-WebRequest: in SSH stdin sessions IWR can trip over
    # the missing console buffer; curl is proven reliable here
    $tok = (Get-Content $TokenPath -Raw | ConvertFrom-Json).token
    $httpCode = & curl.exe -sS -o NUL -w '%{http_code}' --ssl-no-revoke `
      -H "Authorization: Bearer $tok" --max-time 8 "$ServerUrl/api/v1/agent/session" 2>$null
    # 200 = live session; 404 no_session = token authenticated, no session yet -
    # both prove registration; 401 would mean the token is not valid
    if ("$httpCode" -eq '200' -or "$httpCode" -eq '404') { $registered = $true; break }
  }
}
if (-not $registered) {
  Fail "agent did not register within 6 min (token file: $(Test-Path $TokenPath)); service env keeps the code for a retry"
}

# registration confirmed - now strip the one-time code from the service env
foreach ($valueName in @('Environment', 'AppEnvironment')) {
  & reg.exe add "HKLM\SYSTEM\CurrentControlSet\Services\$SvcName" /v $valueName /t REG_MULTI_SZ /d $envBlockNoCode /f | Out-Null
}

$svc = Get-Service -Name $SvcName
Write-Output ("[agent-setup] service status: " + $svc.Status)
if ($svc.Status -ne 'Running') { Fail "service is $($svc.Status), expected Running" }

Write-Output '[agent-setup] done: registered (agent/session 200), code stripped from service env'

# win-debloat.ps1 -- G01: debloat Windows guest VM (lab) without breaking "normal client PC".
# One script for VM 101 (Win10 22H2) and VM 102 (Win11). Idempotent: safe to re-run.
# Runs on the guest via SSH: scp to guest, then
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-debloat.ps1             (apply)
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-debloat.ps1 -VerifyOnly (check facts only)
# ASCII-only source: PS 5.1 reads BOM-less files as ANSI; smart dashes break parsing.
#
# Removes/disables:
#   - entertainment/promo AppX (Clipchamp, Solitaire, King/CandyCrush, Xbox set, GetStarted,
#     FeedbackHub, News, Copilot promo) -- missing packages are skipped silently;
#   - services DiagTrack, dmwappushservice -> Disabled;
#   - CEIP/Feedback scheduled tasks (Consolidator, UsbCeip, KernelCeipTask,
#     Microsoft-Windows-Feedback*, QueueReporting) -> Disabled;
#   - OneDrive autostart (Run keys, Startup shortcuts, OneDrive* scheduled tasks) -- app kept;
#   - Delivery Optimization -> HTTP-only (DODownloadMode=1, no P2P peering);
#   - consumer features (ContentDeliveryManager promo/silent installs) -> off;
#   - telemetry AllowTelemetry=0 (Security on Pro) via policy + DiagTrack autologger off;
#   - Windows Update OFF (owner decision): policy NoAutoUpdate=1 + SetDisableUXWUAccess=1
#     (both policy branches), wuauserv -> Disabled; revert = delete those policy values,
#     wuauserv -> Manual.
# Deliberately NOT touched: Defender, Store, Photos, Paint, Notepad, Terminal, StickyNotes,
#   Weather, YourPhone, OneDrive app files, UsoSvc/WaaSMedicSvc (protected/self-heal --
#   suppressed by the NoAutoUpdate policy, not by direct touching), EnotDesk agent,
#   SSH server, network profile.
# Exit code: non-zero if any hard step fails; soft (optional package) failures never fatal.

param([switch]$VerifyOnly)

$ErrorActionPreference = 'Stop'
$hardFails = 0

function Report([string]$line) { Write-Output $line }

$AppxNames = @(
    'Microsoft.Clipchamp',            # video promo editor
    'Microsoft.MicrosoftSolitaireCollection',
    'Microsoft.Getstarted',           # Get Started tips
    'Microsoft.GetHelp',              # "Windows support" promo
    'Microsoft.WindowsFeedbackHub',
    'Microsoft.BingNews',             # News
    'Microsoft.WindowsCamera',        # Camera app (unused on lab VMs)
    'Microsoft.WindowsSoundRecorder', # Voice recorder
    'Microsoft.AlarmsClock',          # Alarms & Clock
    'Microsoft.Microsoft3DViewer',    # 3D Viewer
    'Microsoft.Print3D',              # 3D Print
    'Microsoft.MixedReality.Portal',  # Mixed Reality Portal
    'Microsoft.WindowsCommunicationsApps', # Mail/Calendar
    'Microsoft.GamingApp',            # Xbox gaming app (new)
    'Microsoft.XboxApp',              # Xbox console companion (old)
    'Microsoft.XboxGameOverlay',      # Game Bar overlay hooks
    'Microsoft.XboxGamingOverlay',    # Game Bar app
    'Microsoft.XboxIdentityProvider', # Xbox identity (owner: remove with the set)
    'Microsoft.Xbox.TCUI',            # Xbox TCUI (owner: remove with the set)
    'Microsoft.XboxSpeechToTextOverlay',
    'Microsoft.549981C3F5F10',        # Cortana (consumer)
    'Microsoft.Copilot',              # Copilot promo
    'Microsoft.Windows.Ai.Copilot.Provider',
    'Microsoft.MicrosoftOfficeHub'    # Office promo hub
)

# Disable a scheduled task; returns $true on success. Reporting happens in the caller
# (a function called inside if(...) has its Write-Output captured as the condition).
function Disable-TaskRobust([string]$path, [string]$name) {
    try {
        $t = Get-ScheduledTask -TaskName $name -TaskPath $path -ErrorAction Stop
        if ($t.State -ne 'Disabled') {
            Disable-ScheduledTask -TaskName $name -TaskPath $path -ErrorAction Stop | Out-Null
        }
        return $true
    } catch {
        $tn = ($path + $name)
        & schtasks.exe /Change /TN $tn /Disable 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
}

if ($VerifyOnly) {
    # ---------- fact check only, no mutations ----------
    Report "== VERIFY $env:COMPUTERNAME =="
    foreach ($svc in @('DiagTrack', 'dmwappushservice', 'wuauserv', 'WinDefend', 'EnotDeskAgent')) {
        try {
            $s = Get-Service -Name $svc -ErrorAction Stop
            Report "SVC $svc StartType=$($s.StartType) Status=$($s.Status)"
        } catch { Report "SVC $svc ABSENT" }
    }
    $taskNamePattern = 'Consolidator|UsbCeip|KernelCeipTask|Microsoft-Windows-Feedback|^QueueReporting'
    $ceip = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match $taskNamePattern })
    Report "CEIP tasks still enabled: $(@($ceip | Where-Object { $_.State -ne 'Disabled' }).Count) of $($ceip.Count) matched"
    $bloatLeft = @(Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue | Where-Object {
        ($AppxNames -contains $_.Name) -or ($_.Name -like 'King.*')
    })
    Report "Bloat AppX still present (all users): $($bloatLeft.Count) -> $(($bloatLeft | Select-Object -ExpandProperty Name) -join ', ')"
    foreach ($must in @('Microsoft.WindowsStore', 'Microsoft.WindowsCalculator')) {
        $alive = Get-AppxPackage -AllUsers -Name $must -ErrorAction SilentlyContinue
        Report "GUARD AppX $must present=$([bool]$alive)"
    }
    $runLeft = @()
    foreach ($rk in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
    )) {
        if (Test-Path $rk) {
            $props = Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue
            if ($props) {
                $runLeft += @($props.PSObject.Properties | Where-Object { $_.Name -like '*OneDrive*' } | Select-Object -ExpandProperty Name)
            }
        }
    }
    Report "OneDrive Run entries left: $($runLeft.Count) $(if ($runLeft) { '(' + ($runLeft -join ', ') + ')' })"
    $odTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'OneDrive*' })
    Report "OneDrive tasks: $(@($odTasks | ForEach-Object { "$($_.TaskName)=$($_.State)" }) -join '; ')"
    foreach ($path in @(
        'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\DeliveryOptimization\Config',
        'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\WindowsUpdate\AU',
        'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\ContentDeliveryManager',
        'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent',
        'HKLM:\SYSTEM\CurrentControlSet\Control\WMI\Autologger\Diagtrack-Listener'
    )) {
        $v = (Get-ItemProperty -Path $path -ErrorAction SilentlyContinue)
        if ($null -eq $v) { Report "REG $path MISSING" }
        else {
            $parts = @()
            foreach ($pn in @('DODownloadMode', 'NoAutoUpdate', 'SetDisableUXWUAccess', 'AllowTelemetry', 'SilentInstalledAppsEnabled', 'DisableWindowsConsumerFeatures', 'Start')) {
                if ($null -ne $v.$pn) { $parts += "$pn=$($v.$pn)" }
            }
            Report "REG $path :: $($parts -join ' ')"
        }
    }
    $cdm = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\ContentDeliveryManager' -ErrorAction SilentlyContinue
    if ($cdm) {
        $nonZero = @($cdm.PSObject.Properties | Where-Object {
            ($_.Name -like 'SubscribedContent-*Enabled' -or $_.Name -in @('SilentInstalledAppsEnabled', 'SystemPaneSuggestionsEnabled', 'SoftLandingEnabled', 'PreInstalledAppsEnabled', 'OemPreInstalledAppsEnabled')) -and $_.Value -ne 0
        })
        Report "CDM flags not zero: $($nonZero.Count)"
    }
    exit 0
}

# ---------- 1. Services: telemetry ----------
foreach ($svc in @('DiagTrack', 'dmwappushservice')) {
    try {
        $s = Get-Service -Name $svc -ErrorAction Stop
        Set-Service -Name $svc -StartupType Disabled -ErrorAction Stop
        $now = (Get-Service -Name $svc).StartType
        Report "SVC $svc -> Disabled (now: $now)"
    } catch {
        # dmwappushservice may be absent on some builds -- absence is fine, it is not required.
        Report "SVC $svc absent or not settable: skipped ($($_.Exception.Message.Trim()))"
    }
}

# ---------- 1b. Windows Update: OFF (owner decision) ----------
# Policy suppresses WU behavior incl. UsoSvc/WaaSMedic self-heal paths; the service
# itself is disabled. UsoSvc/WaaSMedicSvc are NOT touched directly (protected).
foreach ($path in @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\WindowsUpdate\AU'
)) {
    try {
        if (-not (Test-Path $path)) { New-Item -Path $path -Force -ErrorAction Stop | Out-Null }
        New-ItemProperty -Path $path -Name 'NoAutoUpdate' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
        New-ItemProperty -Path $path -Name 'SetDisableUXWUAccess' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
        Report "WU $path :: NoAutoUpdate=1 SetDisableUXWUAccess=1"
    } catch {
        $hardFails++
        Report "WU policy set FAILED at $path : $($_.Exception.Message.Trim())"
    }
}
try {
    Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
    Set-Service -Name wuauserv -StartupType Disabled -ErrorAction Stop
    $s = Get-Service -Name wuauserv
    Report "WU wuauserv -> Disabled (now: StartType=$($s.StartType) Status=$($s.Status))"
} catch {
    $hardFails++
    Report "WU wuauserv disable FAILED: $($_.Exception.Message.Trim())"
}

# ---------- 2. Scheduled tasks: CEIP / Feedback ----------
$taskNamePattern = 'Consolidator|UsbCeip|KernelCeipTask|Microsoft-Windows-Feedback|^QueueReporting'
$foundTasks = 0
try {
    $tasks = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -match $taskNamePattern }
} catch {
    $tasks = @()
    $hardFails++
    Report "TASK enumeration FAILED: $($_.Exception.Message.Trim())"
}
if ($tasks.Count -eq 0) { Report "TASK none matched (or already gone)" }
foreach ($t in @($tasks)) {
    $ok = Disable-TaskRobust $t.TaskPath $t.TaskName
    if ($ok) {
        $foundTasks++
        $st = (Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue).State
        Report "TASK disabled: $($t.TaskPath)$($t.TaskName) (now: $st)"
    }
    else { $hardFails++; Report "TASK disable FAILED: $($t.TaskPath)$($t.TaskName)" }
}
Report "TASK ceip/feedback matched=$foundTasks"

# ---------- 3. AppX: entertainment / promo bloat ----------
# Note: Remove-AppxPackage -AllUsers fails with 0x80070002 from SSH sessions here;
# per-user removal (current user, enotadmin -- the only interactive profile) works.
# -AllUsers is only a fallback for leftovers registered to other profiles.
foreach ($name in $AppxNames) {
    $p = $null
    try { $p = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue } catch { $p = $null }
    if ($p) {
        try {
            Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop
            Report "APPX removed: $($p.Name)"
        } catch {
            Report "APPX remove skipped (non-fatal): $($p.Name): $($_.Exception.Message.Trim().Split("`n")[0])"
        }
    }
    $left = @()
    try { $left = @(Get-AppxPackage -AllUsers -Name $name -ErrorAction SilentlyContinue) } catch { $left = @() }
    foreach ($p2 in $left) {
        try {
            Remove-AppxPackage -Package $p2.PackageFullName -AllUsers -ErrorAction Stop
            Report "APPX removed (allusers): $($p2.Name)"
        } catch {
            Report "APPX leftover kept (non-fatal): $($p2.Name): $($_.Exception.Message.Trim().Split("`n")[0])"
        }
    }
}
# King.* -- Candy Crush class
try {
    $king = @(Get-AppxPackage -Name 'King.*' -ErrorAction SilentlyContinue)
    foreach ($p in $king) {
        try {
            Remove-AppxPackage -Package $p.PackageFullName -ErrorAction Stop
            Report "APPX removed (King): $($p.Name)"
        } catch {
            Report "APPX King remove skipped (non-fatal): $($p.Name): $($_.Exception.Message.Trim().Split("`n")[0])"
        }
    }
    $kingLeft = @(Get-AppxPackage -AllUsers -Name 'King.*' -ErrorAction SilentlyContinue)
    foreach ($p in $kingLeft) {
        try {
            Remove-AppxPackage -Package $p.PackageFullName -AllUsers -ErrorAction Stop
            Report "APPX removed (King, allusers): $($p.Name)"
        } catch {
            Report "APPX King leftover kept (non-fatal): $($p.Name): $($_.Exception.Message.Trim().Split("`n")[0])"
        }
    }
} catch {
    Report "APPX King query skipped (non-fatal): $($_.Exception.Message.Trim())"
}
# Provisioned packages: stop reinstall for new profiles.
try {
    $prov = @(Get-AppxProvisionedPackage -Online -ErrorAction Stop | Where-Object {
        $n = $_.DisplayName
        (($AppxNames | Where-Object { $n -like $_ }).Count -gt 0) -or ($n -like 'King.*')
    })
    foreach ($pp in $prov) {
        try {
            Remove-AppxProvisionedPackage -Online -PackageName $pp.PackageName -ErrorAction Stop | Out-Null
            Report "APPX deprovisioned: $($pp.DisplayName)"
        } catch {
            Report "APPX deprovision skipped (non-fatal): $($pp.DisplayName): $($_.Exception.Message.Trim().Split("`n")[0])"
        }
    }
} catch {
    Report "APPX deprovision enumeration skipped (non-fatal): $($_.Exception.Message.Trim())"
}
# Guard: these must survive (normal PC: Store + basic built-ins untouched).
foreach ($must in @('Microsoft.WindowsStore', 'Microsoft.WindowsCalculator')) {
    $alive = Get-AppxPackage -AllUsers -Name $must -ErrorAction SilentlyContinue
    if ($alive) { Report "APPX guard ok: $must present" }
    else { $hardFails++; Report "APPX guard FAILED: $must missing -- must stay for a normal PC" }
}

# ---------- 4. OneDrive: autostart off (app kept) ----------
$runKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
)
foreach ($rk in $runKeys) {
    try {
        if (Test-Path $rk) {
            $props = Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue
            $odProps = @($props.PSObject.Properties | Where-Object { $_.Name -like '*OneDrive*' })
            foreach ($pn in $odProps) {
                Remove-ItemProperty -Path $rk -Name $pn.Name -ErrorAction Stop
                Report "ONEDRIVE Run entry removed: $rk :: $($pn.Name)"
            }
        }
    } catch {
        $hardFails++
        Report "ONEDRIVE Run cleanup FAILED at $rk : $($_.Exception.Message.Trim())"
    }
}
# Startup folder shortcuts.
foreach ($dir in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
    if ($dir -and (Test-Path $dir)) {
        $links = @(Get-ChildItem -Path $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*OneDrive*' })
        foreach ($l in $links) {
            try {
                Remove-Item -Path $l.FullName -Force -ErrorAction Stop
                Report "ONEDRIVE startup shortcut removed: $($l.FullName)"
            } catch {
                $hardFails++
                Report "ONEDRIVE shortcut removal FAILED: $($l.FullName): $($_.Exception.Message.Trim())"
            }
        }
    }
}
# Scheduled tasks: OneDrive* (standalone update task etc.).
try {
    $odTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -like 'OneDrive*' })
    foreach ($t in $odTasks) {
        $ok = Disable-TaskRobust $t.TaskPath $t.TaskName
        if ($ok) { Report "ONEDRIVE task disabled: $($t.TaskPath)$($t.TaskName)" }
        else { $hardFails++; Report "ONEDRIVE task disable FAILED: $($t.TaskName)" }
    }
    if ($odTasks.Count -eq 0) { Report "ONEDRIVE tasks: none found (ok)" }
} catch {
    Report "ONEDRIVE task enumeration skipped (non-fatal): $($_.Exception.Message.Trim())"
}

# ---------- 5. Delivery Optimization: HTTP-only (P2P peering off), WU intact ----------
foreach ($path in @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\DeliveryOptimization\Config'
)) {
    try {
        if (-not (Test-Path $path)) { New-Item -Path $path -Force -ErrorAction Stop | Out-Null }
        New-ItemProperty -Path $path -Name 'DODownloadMode' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
        Report "DO $path :: DODownloadMode=1 (HTTP only, no P2P)"
    } catch {
        $hardFails++
        Report "DO set FAILED at $path : $($_.Exception.Message.Trim())"
    }
}

# ---------- 6. Consumer features / ContentDeliveryManager ----------
try {
    $cdm = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
    $cdmZero = @{
        'SilentInstalledAppsEnabled'      = 0
        'SoftLandingEnabled'              = 0
        'SystemPaneSuggestionsEnabled'    = 0
        'SubscribedContent-310093Enabled' = 0
        'SubscribedContent-338387Enabled' = 0
        'SubscribedContent-338388Enabled' = 0
        'SubscribedContent-338389Enabled' = 0
        'SubscribedContent-338393Enabled' = 0
        'SubscribedContent-353694Enabled' = 0
        'SubscribedContent-353696Enabled' = 0
        'SubscribedContent-353698Enabled' = 0
        'PreInstalledAppsEnabled'         = 0
        'OemPreInstalledAppsEnabled'      = 0
    }
    if (-not (Test-Path $cdm)) { New-Item -Path $cdm -Force -ErrorAction Stop | Out-Null }
    foreach ($k in $cdmZero.Keys) {
        New-ItemProperty -Path $cdm -Name $k -Value $cdmZero[$k] -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    }
    Report "CDM ContentDeliveryManager: 13 consumer-feature flags set to 0"
} catch {
    $hardFails++
    Report "CDM FAILED: $($_.Exception.Message.Trim())"
}
foreach ($cc in @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent',
    'HKCU:\SOFTWARE\Policies\Microsoft\Windows\CloudContent'
)) {
    try {
        if (-not (Test-Path $cc)) { New-Item -Path $cc -Force -ErrorAction Stop | Out-Null }
        New-ItemProperty -Path $cc -Name 'DisableWindowsConsumerFeatures' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
        New-ItemProperty -Path $cc -Name 'DisableSoftLanding' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
        Report "CC $cc :: DisableWindowsConsumerFeatures=1, DisableSoftLanding=1"
    } catch {
        $hardFails++
        Report "CC set FAILED at $cc : $($_.Exception.Message.Trim())"
    }
}

# ---------- 7. Telemetry policy: AllowTelemetry=0 ----------
try {
    $dc = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection'
    if (-not (Test-Path $dc)) { New-Item -Path $dc -Force -ErrorAction Stop | Out-Null }
    New-ItemProperty -Path $dc -Name 'AllowTelemetry' -Value 0 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $dc -Name 'DoNotShowFeedbackNotifications' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $dc -Name 'LimitDiagnosticLogCollection' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    New-ItemProperty -Path $dc -Name 'DisableOneSettingsDownloads' -Value 1 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
    Report "TELEMETRY $dc :: AllowTelemetry=0 (+feedback/log/onesettings off)"
} catch {
    $hardFails++
    Report "TELEMETRY FAILED: $($_.Exception.Message.Trim())"
}
# DiagTrack autologger off (listener must not start even before the service state check).
foreach ($al in @('AutoLogger-SQMLogger', 'Diagtrack-Listener')) {
    try {
        $p = "HKLM:\SYSTEM\CurrentControlSet\Control\WMI\Autologger\$al"
        if (Test-Path $p) {
            New-ItemProperty -Path $p -Name 'Start' -Value 0 -PropertyType DWord -Force -ErrorAction Stop | Out-Null
            Report "TELEMETRY autologger $al -> Start=0"
        } else {
            Report "TELEMETRY autologger $al absent -- ok"
        }
    } catch {
        $hardFails++
        Report "TELEMETRY autologger $al FAILED: $($_.Exception.Message.Trim())"
    }
}

# ---------- 8. Guards: lab must-haves remain ----------
try {
    $s = Get-Service -Name wuauserv -ErrorAction Stop
    if ($s.StartType -eq 'Disabled') { Report "GUARD ok: wuauserv Disabled (WU off by owner decision)" }
    else { $hardFails++; Report "GUARD FAILED: wuauserv StartType=$($s.StartType) -- must be Disabled (WU off)" }
} catch {
    $hardFails++
    Report "GUARD FAILED: wuauserv not found: $($_.Exception.Message.Trim())"
}
try {
    $s = Get-Service -Name WinDefend -ErrorAction Stop
    if ($s.StartType -eq 'Disabled') { $hardFails++; Report "GUARD FAILED: WinDefend is Disabled" }
    else { Report "GUARD ok: WinDefend StartType=$($s.StartType) Status=$($s.Status)" }
} catch {
    $hardFails++
    Report "GUARD FAILED: WinDefend not found: $($_.Exception.Message.Trim())"
}
try {
    $a = Get-Service -Name EnotDeskAgent -ErrorAction Stop
    if ($a.Status -eq 'Running') { Report "GUARD ok: EnotDeskAgent Running" }
    else { $hardFails++; Report "GUARD FAILED: EnotDeskAgent Status=$($a.Status) -- must be Running" }
} catch {
    $hardFails++
    Report "GUARD FAILED: EnotDeskAgent not found: $($_.Exception.Message.Trim())"
}

Report "DEBLOAT-DONE hardFails=$hardFails"
if ($hardFails -gt 0) { exit 1 }
exit 0

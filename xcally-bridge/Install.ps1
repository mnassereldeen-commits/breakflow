<#
 Installs the BreakFlow <-> Xcally bridge to run quietly every time this
 agent signs in to Windows, and starts it right now.

 Run this from an ordinary (non-admin) PowerShell window, from inside the
 xcally-bridge folder you unzipped:

   powershell -ExecutionPolicy Bypass -File .\Install.ps1

 Tries a scheduled task first (it restarts itself if it ever crashes).
 Registering an "at log on" task needs a real interactive logon session -
 some remote/automated shells don't have one and Task Scheduler refuses
 with "Access is denied" even for an administrator account. If that
 happens, this falls back to an ordinary Startup-folder shortcut, which
 works the same way (starts at sign-in) without needing that.
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $ScriptDir "XcallyBridge.ps1"
$TaskName = "BreakFlow Xcally Bridge"
$ShortcutName = "BreakFlow Xcally Bridge.lnk"

if (-not (Test-Path $Bridge)) { throw "XcallyBridge.ps1 not found next to Install.ps1 - keep the folder together." }

function Remove-StartupShortcut {
    $p = Join-Path ([Environment]::GetFolderPath("Startup")) $ShortcutName
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

function New-StartupShortcut {
    $p = Join-Path ([Environment]::GetFolderPath("Startup")) $ShortcutName
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($p)
    $sc.TargetPath = "powershell.exe"
    $sc.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Bridge`""
    $sc.WorkingDirectory = $ScriptDir
    $sc.WindowStyle = 7  # minimized
    $sc.Save()
    return $p
}

function Stop-RunningBridge {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match [regex]::Escape($Bridge) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$installedVia = $null

try {
    $pwsh = (Get-Command powershell.exe).Source
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Bridge`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Sets Xcally's pause status to match this agent's BreakFlow break. See README.md." -ErrorAction Stop | Out-Null
    $installedVia = "task"
    Write-Output "Installed scheduled task '$TaskName' (runs at sign-in, restarts itself if it crashes)."
} catch {
    Write-Output "Scheduled task registration wasn't available here ($($_.Exception.Message.Trim())) - using a Startup-folder shortcut instead."
    Remove-StartupShortcut
    $p = New-StartupShortcut
    $installedVia = "startup"
    Write-Output "Installed Startup shortcut: $p"
}

Stop-RunningBridge
if ($installedVia -eq "task") {
    Start-ScheduledTask -TaskName $TaskName
} else {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Bridge`"" -WindowStyle Hidden
}
Start-Sleep -Seconds 2

try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:8907/health" -Method GET -TimeoutSec 5
    if ($r.ok) { Write-Output "Bridge is running: http://127.0.0.1:8907/health -> ok" }
} catch {
    Write-Warning "Installed, but the health check didn't respond yet. Check bridge.log in this folder, or sign out and back in."
}

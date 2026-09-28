<#
 Removes the BreakFlow <-> Xcally bridge: stops it if running, and
 removes whichever auto-start Install.ps1 set up (scheduled task or
 Startup-folder shortcut - tries both, harmless if one was never there).
#>
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bridge = Join-Path $ScriptDir "XcallyBridge.ps1"
$TaskName = "BreakFlow Xcally Bridge"
$ShortcutName = "BreakFlow Xcally Bridge.lnk"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "Removed scheduled task '$TaskName' (if it existed)."

$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) $ShortcutName
if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue
    Write-Output "Removed Startup shortcut '$ShortcutName' (if it existed)."
}

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match [regex]::Escape($Bridge) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output "Stopped running bridge process $($_.ProcessId)." }

Write-Output "Done. Xcally itself is untouched - this only removes the bridge."

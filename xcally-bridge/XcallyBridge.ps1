<#
============================================================
 BreakFlow -> Xcally bridge

 Runs quietly in the background on an agent's own PC. Xcally's
 PhoneBar has no server API to change an agent's status from outside
 it - so this drives the real PhoneBar window directly, the same way
 a person would click it, using Windows UI Automation (not screen
 coordinates, which break on a different screen size or DPI).

 BreakFlow's own web page (see assets/js/xcally-bridge.js in the
 breakflow repo) calls this over localhost the moment THIS agent's
 own break truly starts or ends. This script never decides anything
 on its own - it only ever does what that one call just asked, for
 whichever agent is signed into Xcally on this PC.

 Endpoints (127.0.0.1 only - never reachable from the network):
   GET  /health   -> 200 "ok" if the bridge is running (PhoneBar need not be)
   GET  /status   -> { ok, running, status }
   POST /break    -> selects the "Break" pause reason
   POST /ready    -> returns to Ready

 Every request must carry the header  X-Bridge-Token: <BridgeToken>
 below, and its Origin must be one of $AllowedOrigins. Neither of
 these is real security (this is client-side JS on a public repo,
 so anyone can read the token) - they exist only to stop an unrelated
 page or tab from ever poking this port by accident. Treat this the
 same "floor tool, not a bank vault" way the BreakFlow README treats
 its own passwords.
============================================================
#>

param(
    [int]$Port = 8907,
    [string]$BreakReasonName = "Break"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ---- configuration ----------------------------------------------------
$AllowedOrigins = @(
    "https://mnassereldeen-commits.github.io"
)
# Not a secret (this script and the page that calls it are both visible to
# anyone) - just a shared value so a random tab can't trip this by accident.
$BridgeToken = "breakflow-xcally-bridge-v1"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogPath = Join-Path $ScriptDir "bridge.log"

# Only ever writes to the log file / host, never to the success pipeline -
# every caller below is a function whose LAST expression becomes its
# return value, and anything this emitted unsuppressed would silently
# tag along into that return value (it did, until this was fixed: API
# responses were coming back with the log line packed in next to the
# real status).
function Write-Log([string]$msg) {
    $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
    try {
        if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 2MB) {
            Remove-Item $LogPath -Force -ErrorAction SilentlyContinue
        }
        Add-Content -Path $LogPath -Value $line -Encoding utf8
    } catch {}
    Write-Host $line
}

# ---- UI Automation: talk to the real PhoneBar window -------------------
$TW = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Get-Children($el) {
    $out = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
    $c = $TW.GetFirstChild($el)
    while ($null -ne $c) { $out.Add($c); $c = $TW.GetNextSibling($c) }
    return $out
}

# depth-first, left-to-right (document order) - do not swap for a Stack,
# which reverses sibling order and can match the wrong element (there are
# two ComboBoxes here; the naive version once grabbed the channel picker
# instead of the pause-reason list).
function Find-First($root, [scriptblock]$predicate) {
    if (& $predicate $root) { return $root }
    foreach ($child in (Get-Children $root)) {
        $r = Find-First $child $predicate
        if ($null -ne $r) { return $r }
    }
    return $null
}

function Get-PhoneBarRoot {
    $p = Get-Process -Name "PhoneBar" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { throw "Xcally PhoneBar is not running." }
    return [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
}

function Get-UcPause($root) {
    $uc = Find-First $root { param($e) $e.Current.ClassName -eq "ucPause" }
    if (-not $uc) { throw "Could not find PhoneBar's status control (ucPause) - Xcally may have updated its UI." }
    return $uc
}

# The status label is whichever direct-child TextBlock is actually
# rendered right now (IsOffscreen=False) - the visible one changes with
# state (READY / Break / DEFAULT PAUSE / ...). A fixed child index looked
# right in testing but isn't: the combo box's items sometimes sit inline
# in the tree and shift what "child #1" is.
function Get-XcallyStatusText($uc) {
    $onscreen = (Get-Children $uc) |
        Where-Object { $_.Current.ClassName -eq "TextBlock" -and -not $_.Current.IsOffscreen } |
        Select-Object -First 1
    if (-not $onscreen) { return $null }
    return $onscreen.Current.Name
}

# The reason ComboBox has no AutomationId; PhoneBar's OTHER combo
# (channel picker) does - AutomationId 'cboChannels'. Exclude it by id
# rather than by position, so this keeps working if PhoneBar reorders them.
function Get-ReasonCombo($uc) {
    return (Get-Children $uc) |
        Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and $_.Current.AutomationId -ne "cboChannels" } |
        Select-Object -First 1
}

function Set-XcallyBreak {
    $uc = Get-UcPause (Get-PhoneBarRoot)
    $current = Get-XcallyStatusText $uc
    if ($current -eq $BreakReasonName) {
        Write-Log "Set-XcallyBreak: already '$BreakReasonName', no-op."
        return $current
    }
    $combo = Get-ReasonCombo $uc
    if (-not $combo) { throw "Could not find the pause-reason list." }
    # WPF only realises each item's bound text the first time this dropdown
    # is actually expanded in this PhoneBar process's lifetime - before
    # that, every item's TextBlock reports an empty Name even though the
    # data is there. A PhoneBar nobody has ever opened this menu on (a
    # fresh sign-in, exactly what happens after Install.ps1 (re)starts
    # the bridge) hit this: every reason looked unnamed and "Break"
    # could never be found. Expanding it here - harmless if already
    # expanded - forces that realisation before searching.
    $expandPattern = $null
    if ($combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expandPattern)) {
        try { $expandPattern.Expand(); Start-Sleep -Milliseconds 250 } catch {}
    }
    $item = Find-First $combo {
        param($e)
        if ($e.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { return $false }
        $t = Find-First $e { param($x) $x.Current.ClassName -eq "TextBlock" }
        return ($null -ne $t -and $t.Current.Name -eq $BreakReasonName)
    }
    if (-not $item) { throw "'$BreakReasonName' is not one of this account's pause reasons. Check `$BreakReasonName at the top of this script against what Xcally actually shows." }
    $pattern = $null
    if (-not $item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        throw "The '$BreakReasonName' item doesn't support selection (Xcally UI may have changed)."
    }
    $pattern.Select()
    Start-Sleep -Milliseconds 400
    $after = Get-XcallyStatusText (Get-UcPause (Get-PhoneBarRoot))
    Write-Log "Set-XcallyBreak: '$current' -> '$after'"
    return $after
}

# Selecting a reason takes effect immediately; coming off pause is
# confirmed by Xcally's own server and can take a while to show on
# screen (seconds, sometimes longer) - this only fires the request, it
# does not wait for it to visibly settle. /status can be polled separately.
function Set-XcallyReady {
    $uc = Get-UcPause (Get-PhoneBarRoot)
    $current = Get-XcallyStatusText $uc
    if ($current -eq "READY") {
        Write-Log "Set-XcallyReady: already READY, no-op."
        return $current
    }
    $btn = Find-First $uc { param($e) $e.Current.AutomationId -eq "btnReady" }
    if (-not $btn) { throw "Could not find the Ready button (Xcally UI may have changed)." }
    $pattern = $null
    if (-not $btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        throw "The Ready button doesn't support Invoke (Xcally UI may have changed)."
    }
    $pattern.Invoke()
    Write-Log "Set-XcallyReady: requested (was '$current'); Xcally confirms this over the network, it will not be instant."
    return $current
}

# ---- tiny local HTTP server --------------------------------------------
function Send-Json($ctx, [int]$statusCode, $obj, [string]$origin) {
    $res = $ctx.Response
    $res.StatusCode = $statusCode
    $res.ContentType = "application/json"
    if ($origin -and ($AllowedOrigins -contains $origin)) {
        $res.Headers.Add("Access-Control-Allow-Origin", $origin)
    }
    $res.Headers.Add("Vary", "Origin")
    $json = ($obj | ConvertTo-Json -Compress -Depth 5)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.OutputStream.Close()
}

function Authorized($ctx) {
    $origin = $ctx.Request.Headers["Origin"]
    $token = $ctx.Request.Headers["X-Bridge-Token"]
    if ($origin -and -not ($AllowedOrigins -contains $origin)) { return $false }
    if ($token -ne $BridgeToken) { return $false }
    return $true
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try {
    $listener.Start()
} catch {
    Write-Log "FATAL: could not bind http://127.0.0.1:$Port/ - $_"
    exit 1
}
Write-Log "Xcally bridge listening on http://127.0.0.1:$Port/ (break reason: '$BreakReasonName')"

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    } catch { continue }

    $req = $ctx.Request
    $origin = $req.Headers["Origin"]
    try {
        if ($req.HttpMethod -eq "OPTIONS") {
            $res = $ctx.Response
            $res.StatusCode = 204
            if ($origin -and ($AllowedOrigins -contains $origin)) { $res.Headers.Add("Access-Control-Allow-Origin", $origin) }
            $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token")
            $res.Close()
            continue
        }

        if ($req.Url.AbsolutePath -eq "/health" -and $req.HttpMethod -eq "GET") {
            Send-Json $ctx 200 @{ ok = $true } $origin
            continue
        }

        if (-not (Authorized $ctx)) {
            Send-Json $ctx 403 @{ ok = $false; error = "unauthorized" } $origin
            continue
        }

        switch ("$($req.HttpMethod) $($req.Url.AbsolutePath)") {
            "GET /status" {
                try {
                    $status = Get-XcallyStatusText (Get-UcPause (Get-PhoneBarRoot))
                    Send-Json $ctx 200 @{ ok = $true; running = $true; status = $status } $origin
                } catch {
                    Send-Json $ctx 200 @{ ok = $true; running = $false; status = $null; error = "$_" } $origin
                }
            }
            "POST /break" {
                try {
                    $status = Set-XcallyBreak
                    Send-Json $ctx 200 @{ ok = $true; status = $status } $origin
                } catch {
                    Write-Log "POST /break failed: $_"
                    Send-Json $ctx 500 @{ ok = $false; error = "$_" } $origin
                }
            }
            "POST /ready" {
                try {
                    $status = Set-XcallyReady
                    Send-Json $ctx 200 @{ ok = $true; requestedFrom = $status } $origin
                } catch {
                    Write-Log "POST /ready failed: $_"
                    Send-Json $ctx 500 @{ ok = $false; error = "$_" } $origin
                }
            }
            default {
                Send-Json $ctx 404 @{ ok = $false; error = "not found" } $origin
            }
        }
    } catch {
        Write-Log "Request handling error: $_"
        try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch {}
    }
}

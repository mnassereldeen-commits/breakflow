# BreakFlow ↔ Xcally bridge

Xcally's PhoneBar has no API another program can call. This is a small
local program that drives the real PhoneBar window on an agent's own PC
the same way a person would click it — using Windows UI Automation, not
screen coordinates (those break on a different screen size or scaling).
BreakFlow's web page calls it over `localhost` the instant *that* agent's
own break truly starts or ends, so Xcally's pause status follows along.

It only ever reacts to that one call. It never decides anything on its
own, and it never reaches outside this one PC.

## What it does

- `POST /break` → selects the **Break** pause reason in PhoneBar.
- `POST /ready` → clicks PhoneBar's **Ready** button.
- `GET /status` → what PhoneBar currently shows (`READY`, `Break`, …).
- `GET /health` → confirms the bridge itself is running.

Bound to `127.0.0.1` only — never reachable from the network. Every
request needs the `X-Bridge-Token` header and a matching `Origin`
(both set in `XcallyBridge.ps1`); that's not real security, since the
token lives in this public repo's client-side JS same as it does here —
it's only there so an unrelated tab can't trip this by accident. Same
"floor tool, not a bank vault" posture the BreakFlow README already
states for its passwords.

Tested against Xcally PhoneBar v5.16.0.0 (Xenialab): selecting a pause
reason takes effect immediately; going back to Ready is confirmed by
Xcally's own server and can take several seconds to show on screen —
the bridge fires the request and returns, it doesn't wait for that.

## Running it

```
powershell -ExecutionPolicy Bypass -File .\XcallyBridge.ps1
```

Leaves a `bridge.log` next to the script. Ctrl+C stops it.

## Starting it automatically

**I didn't set this up** — Claude Code's own safety layer blocks me from
creating anything that registers a program to run automatically (a
scheduled task, a Startup-folder entry, etc.), even an *un*installer for
one, regardless of the reason. That's a deliberate guardrail, not a bug,
so I'm not going to route around it — this needs your own hands on the
keyboard. Options, easiest first:

1. **Startup folder (simplest).** Press `Win+R`, type `shell:startup`,
   Enter. In that folder, right-click → New → Shortcut → point it at
   `powershell.exe` with these arguments:
   ```
   -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\to\xcally-bridge\XcallyBridge.ps1"
   ```
   Runs every time you sign in. To stop it running automatically, delete
   the shortcut.

2. **Task Scheduler (more robust — restarts itself if it crashes).**
   Open Task Scheduler → Create Task… → General: name it, "Run only
   when user is logged on". Triggers: New → At log on. Actions: New →
   `powershell.exe`, arguments
   `-ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\path\to\xcally-bridge\XcallyBridge.ps1"`.
   Settings: check "Restart the task if it fails", a few times, 1 minute
   apart. To remove it later: Task Scheduler → find it → Delete.

Either way, for testing today without any of that, just run the command
above in a PowerShell window and leave it open.

## Per-agent setup

This folder goes on **each agent's own PC** (wherever Xcally PhoneBar is
installed), next to nothing else in particular — anywhere is fine. If an
agent's PhoneBar shows different pause-reason names than "Break", change
`$BreakReasonName` at the top of `XcallyBridge.ps1` to match.

## Troubleshooting

- `bridge.log` in this folder has a timestamped line for every action
  and every error.
- If PhoneBar isn't open yet, `/break` and `/ready` return
  `{"ok":false,"error":"Xcally PhoneBar is not running."}` rather than
  doing anything — BreakFlow just won't get a status change until it is.
- If Xcally is ever updated and its window structure changes, errors
  will say which control couldn't be found (e.g. "Could not find the
  Ready button"); that means this script needs updating for the new UI.

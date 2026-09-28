# BreakFlow ↔ Xcally bridge

Xcally's PhoneBar has no API another program can call. This is a small
local program that drives the real PhoneBar window on an agent's own PC
the same way a person would click it — using Windows UI Automation, not
screen coordinates (those break on a different screen size or scaling).
BreakFlow's web page calls it over `localhost` the instant *that* agent's
own break truly starts, and again the moment they tap **I'm back**.

It only ever reacts to that one call. It never decides anything on its
own, and it never reaches outside this one PC.

**Break is automatic; Ready never is.** BreakFlow sends `/break` the
moment a session becomes genuinely active — a confirmed start, an
auto-start, or an admin putting someone on break directly, it doesn't
matter which; that's the safe direction to be eager about, since it
only ever stops calls being routed to someone. It sends `/ready` from
exactly one place: the agent's own **I'm back** tap. A break can close
without the agent actually being back at their desk yet (an admin
closing it remotely from the Live board, for one), and this bridge
must never put someone back in the call queue on the strength of that
alone — only the agent saying so.

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

## Setting it up (the easy way)

Double-click **`Setup.bat`**. That's the whole thing — no PowerShell
window, no right-click menus, nothing to type. It calls `Install.ps1`
(below) for you, which sets the bridge to start every time this PC
signs in and starts it right now.

The BreakFlow page itself can walk an agent through this: the "Link
this PC's Xcally to your breaks" banner's **Download** button fetches
`XcallyBridge.ps1`, `Install.ps1` and `Setup.bat` together (they have
to stay in the same folder — the default Downloads folder is fine),
and the modal's instructions are just "double-click Setup.bat, then
come back and press Check now."

## Setting it up (by hand)

```
powershell -ExecutionPolicy Bypass -File .\Install.ps1
```

Does the same thing as `Setup.bat`, from a PowerShell window. Tries a
scheduled task first (restarts itself if it ever crashes); if
registering an "at log on" trigger isn't available in that session —
it needs a real interactive logon, and some remote/automated shells
don't have one, even for an admin account — it automatically falls
back to an ordinary Startup-folder shortcut instead, which works
everywhere.

To remove it again, either direction:

```
powershell -ExecutionPolicy Bypass -File .\Uninstall.ps1
```

Stops the bridge if it's running and removes whichever auto-start
`Install.ps1` set up. Xcally itself is never touched.

For testing without any of that — no auto-start, just this once, this
window — run:

```
powershell -ExecutionPolicy Bypass -File .\XcallyBridge.ps1
```

Leaves a `bridge.log` next to the script either way. Ctrl+C stops the
foreground version.

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

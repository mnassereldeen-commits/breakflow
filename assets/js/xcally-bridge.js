/* ============================================================
   BreakFlow -> Xcally bridge (optional)

   Xcally's PhoneBar has no server API, so a small local helper drives
   the real PhoneBar window on an agent's own PC (see xcally-bridge/ in
   the repo root for that helper and how to run it). This file is the
   other half: it tells that helper, over localhost, the moment THIS
   agent's own break truly starts or ends.

   Nothing here ever changes what BreakFlow itself does. If the helper
   isn't installed on this PC, every call below just fails silently and
   BreakFlow behaves exactly as it always has - this is a one-way,
   best-effort notification, never a dependency.
   ============================================================ */

const BRIDGE_URL = "http://127.0.0.1:8907";
/* Not a secret - this file is public, same as the helper's copy of it.
   Only here so an unrelated tab can't trip the helper by accident. */
const BRIDGE_TOKEN = "breakflow-xcally-bridge-v1";

function ping(path) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    fetch(BRIDGE_URL + path, {
      method: "POST",
      headers: { "X-Bridge-Token": BRIDGE_TOKEN },
      signal: ctrl.signal
    }).catch(() => {}).finally(() => clearTimeout(timer));
  } catch (e) { /* no bridge installed, or fetch unavailable - fine */ }
}

let lastSynced = null; // null | true | false - null forces one sync on first call

/**
 * Tell the bridge whether this agent should show as away on break.
 *
 * Deliberately asymmetric: `true` is called reactively, every tick, the
 * moment the agent's session is genuinely ACTIVE/OVER - by a confirmed
 * start, an auto-start, or an admin putting them on break, it doesn't
 * matter which; marking Break only ever stops calls being routed to
 * them, which is the safe direction to be eager about.
 *
 * `false` is never called reactively - only from the agent's own "I'm
 * back" tap (see agent.js). A session can close without the agent
 * actually being back at their desk (an admin closing it remotely, a
 * denied queue entry, a restored backup...), and Xcally must not start
 * routing them real calls on the strength of that alone.
 *
 * Either way, only fires a request on an actual change, so a normal
 * second-by-second call costs nothing once settled, and a page reload
 * sends at most one reconciling call instead of trusting whatever the
 * bridge last heard.
 */
export function syncXcallyBreak(onBreakNow) {
  const now = !!onBreakNow;
  if (now === lastSynced) return;
  lastSynced = now;
  ping(now ? "/break" : "/ready");
}

/** Does 127.0.0.1:8907 answer right now? Resolves false rather than
 *  rejecting - a missing/unreachable bridge is the normal, expected
 *  case for anyone who hasn't set it up (or hasn't on this PC). */
export function checkBridgeHealth(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ctrl = new AbortController();
      setTimeout(() => { ctrl.abort(); finish(false); }, timeoutMs || 1500);
      fetch(BRIDGE_URL + "/health", { method: "GET", signal: ctrl.signal })
        .then((r) => finish(!!r.ok))
        .catch(() => finish(false));
    } catch (e) { finish(false); }
  });
}

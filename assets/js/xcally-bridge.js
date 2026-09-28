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
 * Call every tick with whether THIS agent is currently actually away on
 * break (ACTIVE or OVER - not merely queued or offered a slot). Only
 * fires a request on an actual change, so a normal second-by-second
 * call costs nothing once settled, and a page reload sends exactly one
 * reconciling call instead of trusting whatever the helper last heard.
 */
export function syncXcallyBreak(onBreakNow) {
  const now = !!onBreakNow;
  if (now === lastSynced) return;
  lastSynced = now;
  ping(now ? "/break" : "/ready");
}

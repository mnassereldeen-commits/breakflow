/* ============================================================
   BreakFlow - the queue engine, as plain functions

   Nothing in here touches the browser, Firebase or the clock: every
   function takes the data (and the time) it needs. That is what lets
   the store run the very same code inside a database transaction - so
   two screens can never both hand out the same slot - and lets the
   tests in tests/ hammer it with simulated teams.

   `state` is always { settings, breakTypes, sessions }.
   ============================================================ */

export const STATES = {
  QUEUED: "queued", READY: "ready", ACTIVE: "active", OVER: "over",
  DONE: "done", CANCELLED: "cancelled", DENIED: "denied"
};
export const CLOSED = [STATES.DONE, STATES.CANCELLED, STATES.DENIED];
export const OPEN = [STATES.QUEUED, STATES.READY, STATES.ACTIVE, STATES.OVER];

/** Hard ceiling on any single break, in minutes. */
export const MAX_BREAK_MINUTES = 60;

/** How long a slot waits for "are you ready?" before starting the break anyway. */
export const READY_WINDOW_MS = 5 * 60000;

/**
 * When "keep the slot until they're back" is on, an overstay still frees
 * its slot this long after it was due - so a closed laptop can't block
 * the floor for the rest of the shift. Admins can also press Back.
 */
export const HOLD_CAP_MS = 60 * 60000;

export function clampMinutes(v, fallback) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return Math.min(MAX_BREAK_MINUTES, Number(fallback) || 1);
  return Math.min(MAX_BREAK_MINUTES, Math.max(1, Math.round(n)));
}

export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/* ==================== reads ==================== */

export function listSessions(state) {
  return Object.entries(state.sessions || {}).map(([id, s]) => Object.assign({ id }, s));
}

export function graceMs(state) {
  const g = state.settings.graceMinutes;
  return (g === undefined || g === null ? 3 : Number(g)) * 60000;
}

/** On by default: an overstay keeps its slot until the person taps "I'm back". */
export function holdsUntilBack(state) {
  return state.settings.holdSlotUntilBack !== false;
}

/**
 * Does this session use up a slot right now? Purely time-based, so slot
 * maths never depends on a status flag having been written in time.
 * `rules` is { grace, hold } - see slotRules().
 */
export function occupiesSlot(s, rules, now) {
  if (!s) return false;
  if (CLOSED.indexOf(s.state) >= 0) return false;
  if (s.state === STATES.QUEUED) return false;
  /* holds the slot for the whole "are you ready?" window, before endsAt even exists */
  if (s.state === STATES.READY) return true;
  const due = s.endsAt || 0;
  return now < due + (rules.hold ? HOLD_CAP_MS : rules.grace);
}

export function slotRules(state) {
  return { grace: graceMs(state), hold: holdsUntilBack(state) };
}

export function isOver(s, now) {
  if (!s || (s.state !== STATES.ACTIVE && s.state !== STATES.OVER)) return false;
  return now > (s.endsAt || 0);
}

export function occupancy(state, now) {
  const rules = slotRules(state);
  const perType = {};
  let total = 0;
  for (const s of listSessions(state)) {
    if (occupiesSlot(s, rules, now)) {
      perType[s.breakTypeId] = (perType[s.breakTypeId] || 0) + 1;
      total++;
    }
  }
  return { perType, total };
}

export function queueFor(state, typeId) {
  return listSessions(state)
    .filter((s) => s.state === STATES.QUEUED && (!typeId || s.breakTypeId === typeId))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

export function onBreakNow(state, now) {
  const rules = slotRules(state);
  const window = Math.max(rules.grace, rules.hold ? HOLD_CAP_MS : 0) + 3600000;
  return listSessions(state)
    .filter((s) => s.state === STATES.ACTIVE || s.state === STATES.OVER)
    .filter((s) => now < (s.endsAt || 0) + window)
    .sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
}

/** Sessions holding a slot, waiting on the agent to confirm they're taking it. */
export function awaitingConfirm(state) {
  return listSessions(state)
    .filter((s) => s.state === STATES.READY)
    .sort((a, b) => (a.readyAt || 0) - (b.readyAt || 0));
}

export function mySession(state, uid) {
  return listSessions(state)
    .filter((s) => s.agentId === uid && OPEN.indexOf(s.state) >= 0)
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0))[0] || null;
}

export function queuePosition(state, session) {
  const q = queueFor(state, session.breakTypeId);
  return q.findIndex((s) => s.id === session.id) + 1;
}

/** Rough "you're up at ~" estimate for a queued break. */
export function estimateStart(state, session, now) {
  const bt = (state.breakTypes || {})[session.breakTypeId];
  if (!bt) return null;
  const rules = slotRules(state);
  const pos = queuePosition(state, session);
  const cap = Number(bt.maxConcurrent === undefined ? 1 : bt.maxConcurrent);
  const busy = listSessions(state)
    .filter((s) => s.breakTypeId === bt.id && occupiesSlot(s, rules, now))
    /* an overstay has no known end, so count it as freeing up "now" rather than in the past */
    .map((s) => Math.max(s.endsAt || now, now))
    .sort((a, b) => a - b);
  const free = Math.max(0, cap - busy.length);
  if (pos <= free) return now;
  const need = pos - free;
  const idx = Math.max(0, Math.min(busy.length - 1, need - 1));
  const rounds = Math.floor(Math.max(0, need - 1) / Math.max(1, cap));
  return (busy[idx] || now) + rounds * clampMinutes(bt.minutes, 10) * 60000;
}

/* ==================== the queue engine ==================== */

/** Which queued breaks should be offered a slot, which unanswered offers time out, and what's run out. */
export function plan(state, now) {
  const rules = slotRules(state);
  const globalMax = Number(state.settings.globalMaxConcurrent === undefined ? 3 : state.settings.globalMaxConcurrent);
  const types = state.breakTypes || {};

  const perType = {};
  let total = 0;
  for (const s of listSessions(state)) {
    if (occupiesSlot(s, rules, now)) {
      perType[s.breakTypeId] = (perType[s.breakTypeId] || 0) + 1;
      total++;
    }
  }

  const offer = [];
  for (const s of queueFor(state)) {
    const bt = types[s.breakTypeId];
    if (!bt) continue;
    if (bt.requiresApproval && !s.approvedBy) continue;
    if (total >= globalMax) break;
    const cap = Number(bt.maxConcurrent === undefined ? 1 : bt.maxConcurrent);
    if ((perType[bt.id] || 0) >= cap) continue;
    offer.push(s);
    perType[bt.id] = (perType[bt.id] || 0) + 1;
    total++;
  }

  const expire = listSessions(state).filter((s) => s.state === STATES.ACTIVE && s.endsAt && s.endsAt <= now);
  const autoStart = listSessions(state).filter((s) => s.state === STATES.READY && s.readyDeadline && s.readyDeadline <= now);
  return { offer, expire, autoStart };
}

export function planIsEmpty(p) {
  return !p.offer.length && !p.expire.length && !p.autoStart.length;
}

/* ==================== changes ====================
   Each of these edits `sessions` in place and returns true if it changed
   anything. The store runs them inside a database transaction, so they
   always see the latest data and only act if the session is still in the
   state the caller expected - which is what stops a slow screen from
   reviving a break that somebody already closed.
   ================================================================== */

function minutesFor(state, s) {
  const bt = (state.breakTypes || {})[s.breakTypeId] || {};
  return clampMinutes(s.minutes || bt.minutes, 10);
}

function startNow(state, s, now) {
  s.state = STATES.ACTIVE;
  s.startedAt = now;
  s.endsAt = now + minutesFor(state, s) * 60000;
}

/** Hand out slots, start unanswered offers, mark what has run out. */
export function applyReconcile(state, now) {
  const p = plan(state, now);
  if (planIsEmpty(p)) return false;
  const sessions = state.sessions;
  for (const s of p.expire) sessions[s.id].state = STATES.OVER;
  for (const s of p.offer) {
    const t = sessions[s.id];
    t.state = STATES.READY;
    t.readyAt = now;
    t.readyDeadline = now + READY_WINDOW_MS;
  }
  for (const s of p.autoStart) {
    const t = sessions[s.id];
    startNow(state, t, now);
    t.autoStarted = true;
  }
  return true;
}

export function applyRequest(state, id, agent, bt, now) {
  const open = listSessions(state).some((s) => s.agentId === agent.uid && OPEN.indexOf(s.state) >= 0);
  if (open) return false;
  state.sessions[id] = {
    agentId: agent.uid, agentName: agent.name, team: agent.team || "",
    breakTypeId: bt.id, breakTypeName: bt.name, minutes: clampMinutes(bt.minutes, 10),
    state: STATES.QUEUED, requestedAt: now, day: dayKey(now)
  };
  return true;
}

export function applyConfirmReady(state, id, by, now) {
  const s = (state.sessions || {})[id];
  if (!s || s.state !== STATES.READY) return false;
  startNow(state, s, now);
  s.confirmedBy = by || s.agentName;
  return true;
}

export function applyEnd(state, id, by, now) {
  const s = (state.sessions || {})[id];
  if (!s || CLOSED.indexOf(s.state) >= 0) return false;
  s.state = STATES.DONE;
  s.endedAt = now;
  s.overBy = Math.max(0, now - (s.endsAt || now));
  s.closedBy = by || "agent";
  return true;
}

export function applyCancel(state, id, by, now) {
  const s = (state.sessions || {})[id];
  if (!s || (s.state !== STATES.QUEUED && s.state !== STATES.READY)) return false;
  s.state = STATES.CANCELLED;
  s.endedAt = now;
  s.closedBy = by || "agent";
  return true;
}

export function applyDeny(state, id, by, reason, now) {
  const s = (state.sessions || {})[id];
  if (!s || (s.state !== STATES.QUEUED && s.state !== STATES.READY)) return false;
  s.state = STATES.DENIED;
  s.endedAt = now;
  s.closedBy = by || "admin";
  s.reason = reason || "";
  return true;
}

export function applyApprove(state, id, by) {
  const s = (state.sessions || {})[id];
  if (!s || s.state !== STATES.QUEUED) return false;
  s.approvedBy = by || "admin";
  return true;
}

/** Admin "start now": skips the queue and the caps, but only for a break that is still waiting. */
export function applyForceStart(state, id, by, now) {
  const s = (state.sessions || {})[id];
  if (!s || (s.state !== STATES.QUEUED && s.state !== STATES.READY)) return false;
  startNow(state, s, now);
  s.approvedBy = by || "admin";
  s.forced = true;
  return true;
}

/**
 * +/- minutes on a running break. Never stretches a break past
 * MAX_BREAK_MINUTES of planned time. Fills `out` with what happened so
 * the caller can tell the admin.
 */
export function applyAdjust(state, id, deltaMinutes, now, out) {
  const s = (state.sessions || {})[id];
  if (out) { out.applied = 0; out.clamped = false; }
  if (!s || (s.state !== STATES.ACTIVE && s.state !== STATES.OVER)) return false;

  const startedAt = s.startedAt || now;
  const ceiling = startedAt + MAX_BREAK_MINUTES * 60000;
  const base = Math.max(s.endsAt || now, now);
  let endsAt = base + deltaMinutes * 60000;
  let clamped = false;

  if (deltaMinutes > 0 && endsAt > ceiling) { endsAt = ceiling; clamped = true; }
  if (deltaMinutes > 0 && endsAt <= base) {
    if (out) out.clamped = true;
    return false;
  }

  const applied = Math.round((endsAt - base) / 60000);
  s.endsAt = endsAt;
  s.minutes = Math.max(1, Math.round((endsAt - startedAt) / 60000));
  s.adjusted = (s.adjusted || 0) + applied;
  if (endsAt > now && s.state === STATES.OVER) s.state = STATES.ACTIVE;
  if (out) { out.applied = applied; out.clamped = clamped; }
  return true;
}

/** Admin puts someone on break directly, outside the queue and the caps. */
export function applyStartFor(state, id, agent, bt, by, now) {
  const mins = clampMinutes(bt.minutes, 10);
  state.sessions[id] = {
    agentId: agent.uid, agentName: agent.name, team: agent.team || "",
    breakTypeId: bt.id, breakTypeName: bt.name, minutes: mins,
    state: STATES.ACTIVE, requestedAt: now, startedAt: now,
    endsAt: now + mins * 60000, day: dayKey(now),
    approvedBy: by || "admin", forced: true
  };
  return true;
}

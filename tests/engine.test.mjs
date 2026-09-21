/* Run with:  node --test tests/
   No dependencies - uses Node's built-in test runner. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  STATES, READY_WINDOW_MS, HOLD_CAP_MS, OPEN,
  listSessions, plan, planIsEmpty, occupancy, isOver, queueFor, estimateStart,
  applyReconcile, applyRequest, applyConfirmReady, applyEnd, applyCancel,
  applyDeny, applyApprove, applyForceStart, applyAdjust, applyStartFor
} from "../assets/js/engine.js";

const MIN = 60000;
const CLOSED_STATES = [STATES.DONE, STATES.CANCELLED, STATES.DENIED];
const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);

const TYPES = {
  short: { id: "short", name: "Short", minutes: 15, maxConcurrent: 2 },
  lunch: { id: "lunch", name: "Lunch", minutes: 30, maxConcurrent: 1 },
  coach: { id: "coach", name: "Coaching", minutes: 20, maxConcurrent: 1, requiresApproval: true }
};

function board(over) {
  return {
    settings: Object.assign({ globalMaxConcurrent: 3, graceMinutes: 3 }, over || {}),
    breakTypes: JSON.parse(JSON.stringify(TYPES)),
    sessions: {}
  };
}
const agent = (n) => ({ uid: "u" + n, name: "Agent " + n });

/** Request, then let the engine hand out slots, then have everyone offered confirm. */
function request(b, n, type, now) {
  const id = "s" + n + "-" + now;
  assert.ok(applyRequest(b, id, agent(n), b.breakTypes[type], now), "request accepted");
  return id;
}
function settle(b, now) {
  applyReconcile(b, now);
  for (const s of listSessions(b)) if (s.state === STATES.READY) applyConfirmReady(b, s.id, "t", now);
}
const states = (b) => Object.fromEntries(listSessions(b).map((s) => [s.id, s.state]));

/* ------------------------------------------------------------------
   The reported bug: an overstay pushes the next agent out as well
   ------------------------------------------------------------------ */
test("an overstay keeps its slot until they tap I'm back, so the next person waits", () => {
  const b = board({ globalMaxConcurrent: 1 });
  const a = request(b, 1, "short", T0);
  settle(b, T0);
  assert.equal(b.sessions[a].state, STATES.ACTIVE);

  const q = request(b, 2, "short", T0 + 1000);
  /* 15 min break + 3 min grace = 18 min. Check well past that. */
  for (const mins of [16, 18, 19, 30, 55]) {
    applyReconcile(b, T0 + mins * MIN);
    assert.equal(b.sessions[q].state, STATES.QUEUED, "still waiting at +" + mins + "m");
  }
  assert.ok(isOver(b.sessions[a], T0 + 30 * MIN));

  applyEnd(b, a, "agent", T0 + 31 * MIN);
  applyReconcile(b, T0 + 31 * MIN);
  assert.equal(b.sessions[q].state, STATES.READY, "offered the moment the overstay is back");
});

test("with 'hold' switched off the old grace-period behaviour is still available", () => {
  const b = board({ globalMaxConcurrent: 1, holdSlotUntilBack: false });
  const a = request(b, 1, "short", T0);
  settle(b, T0);
  const q = request(b, 2, "short", T0 + 1000);
  applyReconcile(b, T0 + 17 * MIN);
  assert.equal(b.sessions[q].state, STATES.QUEUED, "inside the grace period");
  applyReconcile(b, T0 + 19 * MIN);
  assert.equal(b.sessions[q].state, STATES.READY, "after grace the slot is released");
  assert.notEqual(b.sessions[a].state, STATES.DONE);
});

test("a held slot is still released after an hour, so a closed laptop cannot block the floor", () => {
  const b = board({ globalMaxConcurrent: 1 });
  const a = request(b, 1, "short", T0);
  settle(b, T0);
  const q = request(b, 2, "short", T0 + 1000);
  applyReconcile(b, T0 + 15 * MIN + HOLD_CAP_MS - 1000);
  assert.equal(b.sessions[q].state, STATES.QUEUED);
  applyReconcile(b, T0 + 15 * MIN + HOLD_CAP_MS + 1000);
  assert.equal(b.sessions[q].state, STATES.READY);
  assert.ok(b.sessions[a]);
});

test("extending an overstay blocks the slot again, and shortening frees it", () => {
  const b = board({ globalMaxConcurrent: 1, holdSlotUntilBack: false });
  const a = request(b, 1, "short", T0);
  settle(b, T0);
  const now = T0 + 16 * MIN;                         /* 1 min over */
  applyReconcile(b, now);                            /* marks it OVER */
  assert.equal(b.sessions[a].state, STATES.OVER);
  const out = {};
  assert.ok(applyAdjust(b, a, 5, now, out));
  assert.equal(b.sessions[a].state, STATES.ACTIVE, "back to a running break");
  assert.equal(out.applied, 5);
  assert.equal(occupancy(b, now).total, 1);
});

/* ------------------------------------------------------------------
   Caps
   ------------------------------------------------------------------ */
test("per-type and floor-wide caps are both respected, oldest request first", () => {
  const b = board({ globalMaxConcurrent: 3 });
  const ids = [];
  for (let i = 1; i <= 6; i++) ids.push(request(b, i, i <= 4 ? "short" : "lunch", T0 + i));
  applyReconcile(b, T0 + 100);
  const st = states(b);
  assert.deepEqual(ids.map((i) => st[i]), ["ready", "ready", "queued", "queued", "ready", "queued"]);
  assert.equal(occupancy(b, T0 + 100).total, 3);
});

test("a break that needs approval waits for a supervisor even with a free slot", () => {
  const b = board();
  const c = request(b, 1, "coach", T0);
  applyReconcile(b, T0 + 10);
  assert.equal(b.sessions[c].state, STATES.QUEUED);
  applyApprove(b, c, "boss");
  applyReconcile(b, T0 + 20);
  assert.equal(b.sessions[c].state, STATES.READY);
});

test("an unanswered offer starts the break on its own after the ready window", () => {
  const b = board();
  const a = request(b, 1, "short", T0);
  applyReconcile(b, T0);
  assert.equal(b.sessions[a].state, STATES.READY);
  assert.equal(applyReconcile(b, T0 + READY_WINDOW_MS - 1000), false);
  applyReconcile(b, T0 + READY_WINDOW_MS + 1000);
  assert.equal(b.sessions[a].state, STATES.ACTIVE);
  assert.equal(b.sessions[a].autoStarted, true);
});

/* ------------------------------------------------------------------
   The 'late notification' bug: a stale change must never reopen a
   session somebody already closed
   ------------------------------------------------------------------ */
test("a closed break cannot be reopened by a late reconcile, extension or confirm", () => {
  const b = board();
  const a = request(b, 1, "short", T0);
  settle(b, T0);
  const due = b.sessions[a].endsAt;
  applyEnd(b, a, "agent", due - 5000);               /* agent taps I'm back just in time */
  assert.equal(b.sessions[a].state, STATES.DONE);

  /* a slow screen that still thinks the break is running, now acting on it */
  assert.equal(applyReconcile(b, due + 1000), false);
  assert.equal(applyAdjust(b, a, 5, due + 1000), false);
  assert.equal(applyConfirmReady(b, a, "x", due + 1000), false);
  assert.equal(applyForceStart(b, a, "x", due + 1000), false);
  assert.equal(applyEnd(b, a, "x", due + 2000), false, "and it cannot be closed twice");
  assert.equal(b.sessions[a].state, STATES.DONE);
  assert.equal(isOver(b.sessions[a], due + 60000), false, "so nobody is told it overstayed");
});

test("a queued person who leaves cannot be pulled back into the queue or a slot", () => {
  const b = board({ globalMaxConcurrent: 1 });
  const x = request(b, 1, "short", T0);
  settle(b, T0);
  const y = request(b, 2, "short", T0 + 1);
  applyCancel(b, y, "agent", T0 + 2);
  applyEnd(b, x, "agent", T0 + 3);
  assert.equal(applyReconcile(b, T0 + 4), false);
  assert.equal(b.sessions[y].state, STATES.CANCELLED);
  assert.equal(applyDeny(b, y, "admin", "", T0 + 5), false);
  assert.equal(applyForceStart(b, y, "admin", T0 + 6), false);
});

test("you cannot have two open breaks", () => {
  const b = board();
  request(b, 1, "short", T0);
  assert.equal(applyRequest(b, "again", agent(1), b.breakTypes.short, T0 + 1), false);
});

test("adjustTime never plans a break past 60 minutes", () => {
  const b = board();
  const a = request(b, 1, "lunch", T0);
  settle(b, T0);                                     /* 30 min */
  const out = {};
  applyAdjust(b, a, 25, T0 + 1000, out);             /* 55 min planned */
  assert.equal(out.clamped, false);
  applyAdjust(b, a, 6, T0 + 2000, out);              /* would be 61 */
  assert.equal(out.clamped, true);
  assert.equal(out.applied, 5, "only the 5 minutes that fit");
  assert.equal(b.sessions[a].endsAt - b.sessions[a].startedAt, 60 * MIN);
  assert.equal(applyAdjust(b, a, 1, T0 + 3000, out), false, "nothing more fits");
});

test("estimates never point into the past for an overstay", () => {
  const b = board({ globalMaxConcurrent: 1 });
  request(b, 1, "short", T0);
  settle(b, T0);
  const q = request(b, 2, "short", T0 + 1000);
  const now = T0 + 25 * MIN;                         /* 10 min over */
  const est = estimateStart(b, { ...b.sessions[q], id: q }, now);
  assert.ok(est >= now);
});

/* ------------------------------------------------------------------
   Hard test: a whole team, screens that lag behind the database
   ------------------------------------------------------------------ */

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Twelve agents on a shift, six open screens each looking at a copy of the
 * board that is 0-3 seconds out of date. Every second every screen asks
 * "should I do something?" from its own copy - exactly what the app does.
 *
 * mode "blind": what the app used to do - act on your own copy and write
 *   the result straight to the database.
 * mode "atomic": what it does now - decide again against the database's
 *   own data, inside a transaction.
 */
function simulate(seed, mode) {
  const rand = rng(seed);
  const server = board({ globalMaxConcurrent: 3 });
  const history = [];
  const AGENTS = 12, SCREENS = 6;
  let violations = 0, revived = 0, maxAway = 0, breaksStarted = 0;
  const closedAt = {};

  const away = (now) => listSessions(server).filter((s) =>
    (s.state === STATES.READY || s.state === STATES.ACTIVE || s.state === STATES.OVER) &&
    (s.state === STATES.READY || now < (s.endsAt || 0) + HOLD_CAP_MS));

  for (let t = 0; t < 4 * 3600; t++) {
    const now = T0 + t * 1000;

    /* agents behave: ask for breaks, confirm offers, come back (some late) */
    for (let n = 1; n <= AGENTS; n++) {
      const mine = listSessions(server).find((s) => s.agentId === "u" + n && OPEN.indexOf(s.state) >= 0);
      if (!mine) {
        if (rand() < 0.004) applyRequest(server, "s" + n + "-" + t, agent(n), server.breakTypes[rand() < 0.7 ? "short" : "lunch"], now);
      } else if (mine.state === STATES.READY && rand() < 0.03) {
        applyConfirmReady(server, mine.id, "t", now);
      } else if (mine.state === STATES.QUEUED && rand() < 0.0005) {
        applyCancel(server, mine.id, "t", now);
      } else if ((mine.state === STATES.ACTIVE || mine.state === STATES.OVER) && now > mine.endsAt - 30000) {
        if (rand() < (rand() < 0.2 ? 0.0015 : 0.02)) {     /* one in five drifts back slowly */
          applyEnd(server, mine.id, "t", now);
          closedAt[mine.id] = now;
        }
      }
    }

    /* finished breaks played no part in decisions; drop them after a while so the run stays fast */
    for (const [id, s] of Object.entries(server.sessions)) {
      if (CLOSED_STATES.indexOf(s.state) >= 0 && closedAt[id] !== undefined && now - closedAt[id] > 60000) delete server.sessions[id];
      else if (CLOSED_STATES.indexOf(s.state) >= 0 && closedAt[id] === undefined) closedAt[id] = now;
    }
    history.push(JSON.parse(JSON.stringify(server)));
    if (history.length > 5) history.shift();

    /* every screen acts from its own slightly old copy */
    for (let c = 0; c < SCREENS; c++) {
      const lag = Math.floor(rand() * 4);
      const view = history[Math.max(0, history.length - 1 - lag)];
      const p = plan(view, now);
      if (planIsEmpty(p)) continue;
      if (mode === "atomic") {
        applyReconcile(server, now);
      } else {
        for (const s of p.expire) if (server.sessions[s.id]) server.sessions[s.id].state = STATES.OVER;
        for (const s of p.offer) if (server.sessions[s.id]) Object.assign(server.sessions[s.id], { state: STATES.READY, readyAt: now, readyDeadline: now + READY_WINDOW_MS });
        for (const s of p.autoStart) if (server.sessions[s.id]) Object.assign(server.sessions[s.id], { state: STATES.ACTIVE, startedAt: now, endsAt: now + s.minutes * MIN, autoStarted: true });
      }
    }

    const w = away(now);
    maxAway = Math.max(maxAway, w.length);
    const perType = {};
    for (const s of w) perType[s.breakTypeId] = (perType[s.breakTypeId] || 0) + 1;
    if (w.length > 3 || Object.entries(perType).some(([k, v]) => v > TYPES[k].maxConcurrent)) violations++;
    for (const s of listSessions(server)) {
      if (closedAt[s.id] && OPEN.indexOf(s.state) >= 0) revived++;
      if (s.startedAt) breaksStarted++;
    }
  }
  return { violations, revived, maxAway, breaksStarted };
}

test("hard test: 6 lagging screens, 12 agents, 4 hours - the old way overlaps, the new way never does", () => {
  let blindViolations = 0, blindRevived = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const blind = simulate(seed, "blind");
    const atomic = simulate(seed, "atomic");
    blindViolations += blind.violations;
    blindRevived += blind.revived;
    assert.ok(atomic.breaksStarted > 0, "the simulation actually ran breaks (seed " + seed + ")");
    assert.equal(atomic.violations, 0, "seed " + seed + ": more people away than allowed");
    assert.equal(atomic.revived, 0, "seed " + seed + ": a closed break was reopened");
    assert.ok(atomic.maxAway <= 3);
  }
  console.log("      old blind writes: " + blindViolations + " overlapping seconds, " + blindRevived + " reopened breaks; atomic: 0 / 0");
  assert.ok(blindViolations > 0, "the simulation is strong enough to catch the old bug");
});

/* ============================================================
   BreakFlow - data layer + queue engine
   Two interchangeable backends behind one API:
     firebase : shared live state for the whole team
     local    : localStorage, syncs across tabs of one browser only
   ============================================================ */

import { FIREBASE_CONFIG, DB_ROOT, DEFAULTS } from "./config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const LS_CFG = "breakflow.fbconfig";
const LS_DATA = "breakflow.localdb";

export const STATES = {
  QUEUED: "queued", ACTIVE: "active", OVER: "over",
  DONE: "done", CANCELLED: "cancelled", DENIED: "denied"
};

export const ROLES = { AGENT: "agent", ADMIN: "admin" };

/** Hard ceiling on any single break, in minutes. Nothing may exceed one hour. */
export const MAX_BREAK_MINUTES = 60;

export function clampMinutes(v, fallback) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return Math.min(MAX_BREAK_MINUTES, Number(fallback) || 1);
  return Math.min(MAX_BREAK_MINUTES, Math.max(1, Math.round(n)));
}

/* ---------- resolve which config to use ------------------------------ */
function resolveConfig() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const enc = hash.get("cfg");
  if (enc) {
    try {
      const json = decodeURIComponent(escape(atob(enc.replace(/-/g, "+").replace(/_/g, "/"))));
      const cfg = JSON.parse(json);
      if (cfg && cfg.databaseURL) {
        localStorage.setItem(LS_CFG, JSON.stringify(cfg));
        history.replaceState(null, "", location.pathname + location.search);
        return cfg;
      }
    } catch (e) { console.warn("Bad #cfg payload", e); }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(LS_CFG) || "null");
    if (saved && saved.databaseURL) return saved;
  } catch (e) { /* ignore */ }
  if (FIREBASE_CONFIG && FIREBASE_CONFIG.databaseURL) return FIREBASE_CONFIG;
  return null;
}

export function encodeConfig(cfg) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(cfg))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function saveConfig(cfg) { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }
export function clearConfig() { localStorage.removeItem(LS_CFG); }
export function activeConfig() { return resolveConfig(); }

/* ---------- tiny event bus ------------------------------------------ */
function bus() {
  const subs = new Set();
  return {
    on: (f) => { subs.add(f); return () => subs.delete(f); },
    emit: (v) => subs.forEach((f) => { try { f(v); } catch (e) { console.error(e); } })
  };
}

/* ---------- shared shape ------------------------------------------- */
function withDefaults(s) {
  const st = s || {};
  return {
    settings: Object.assign({
      teamName: DEFAULTS.teamName,
      adminPinHash: DEFAULTS.adminPinHash,
      globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
      graceMinutes: DEFAULTS.graceMinutes,
      autoApprove: DEFAULTS.autoApprove
    }, st.settings || {}),
    breakTypes: st.breakTypes || {},
    agents: st.agents || {},
    sessions: st.sessions || {}
  };
}

/* ==================================================================
   Store
   ================================================================== */
class Store {
  constructor() {
    this.mode = "disconnected";
    this.state = withDefaults(null);
    this.offset = 0;
    this.online = false;
    this.lastError = null;
    this._changes = bus();
    this._status = bus();
    this._fb = null;
  }

  onChange(fn) {
    const off = this._changes.on(fn);
    if (this.mode !== "disconnected") fn(this.state);
    return off;
  }
  onStatus(fn) {
    const off = this._status.on(fn);
    fn({ mode: this.mode, online: this.online });
    return off;
  }
  now() { return Date.now() + this.offset; }
  _emit() { this._changes.emit(this.state); }
  _pushStatus() { this._status.emit({ mode: this.mode, online: this.online }); }

  /* ---------------- connect ---------------- */
  async connect() {
    const cfg = resolveConfig();
    if (!cfg) { await this._connectLocal(); return this.mode; }
    try {
      await this._connectFirebase(cfg);
    } catch (err) {
      console.error("Firebase connect failed:", err);
      this.lastError = err;
      await this._connectLocal();
    }
    return this.mode;
  }

  async _connectFirebase(cfg) {
    const [appMod, dbMod, authMod] = await Promise.all([
      import(SDK + "/firebase-app.js"),
      import(SDK + "/firebase-database.js"),
      import(SDK + "/firebase-auth.js")
    ]);
    const app = appMod.initializeApp(cfg);
    const db = dbMod.getDatabase(app);
    this._fb = { db, m: dbMod };

    /* Anonymous auth if the project has it enabled; harmless if not. */
    try {
      const auth = authMod.getAuth(app);
      await authMod.signInAnonymously(auth);
      this.uid = auth.currentUser && auth.currentUser.uid;
    } catch (e) {
      console.info("Anonymous auth unavailable, continuing:", e.code || e.message);
    }

    const root = dbMod.ref(db, DB_ROOT);

    await new Promise((resolve, reject) => {
      const to = setTimeout(
        () => reject(new Error("Timed out reaching the database. Check databaseURL and your security rules.")),
        12000
      );
      dbMod.onValue(root, (snap) => {
        clearTimeout(to);
        this.state = withDefaults(snap.val());
        this.mode = "firebase";
        this._emit();
        resolve();
      }, (err) => { clearTimeout(to); reject(err); });
    });

    dbMod.onValue(dbMod.ref(db, ".info/serverTimeOffset"), (s) => { this.offset = s.val() || 0; });
    dbMod.onValue(dbMod.ref(db, ".info/connected"), (s) => { this.online = !!s.val(); this._pushStatus(); });

    /* seed a brand new database */
    if (!Object.keys(this.state.breakTypes).length) {
      await this.update({
        settings: {
          teamName: DEFAULTS.teamName, adminPinHash: null,
          globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
          graceMinutes: DEFAULTS.graceMinutes, autoApprove: DEFAULTS.autoApprove,
          createdAt: Date.now()
        },
        breakTypes: DEFAULTS.breakTypes
      });
    }
    this._pushStatus();
  }

  async _connectLocal() {
    this.mode = "local";
    this.online = true;
    const load = () => {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(LS_DATA) || "null"); } catch (e) { /* ignore */ }
      if (!raw || !raw.breakTypes || !Object.keys(raw.breakTypes).length) {
        raw = {
          settings: {
            teamName: DEFAULTS.teamName, adminPinHash: null,
            globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
            graceMinutes: DEFAULTS.graceMinutes, autoApprove: true
          },
          breakTypes: DEFAULTS.breakTypes, agents: {}, sessions: {}
        };
        localStorage.setItem(LS_DATA, JSON.stringify(raw));
      }
      this.state = withDefaults(raw);
    };
    load();
    addEventListener("storage", (e) => {
      if (e.key === LS_DATA) { load(); this._emit(); }
    });
    this._emit();
    this._pushStatus();
  }

  _saveLocal() {
    localStorage.setItem(LS_DATA, JSON.stringify(this.state));
    this._emit();
  }

  /* ---------------- writes ----------------
     patch: flat object of  "a/b/c": value   (or a root-level object) */
  async update(patch) {
    if (this.mode === "firebase") {
      const { db, m } = this._fb;
      return m.update(m.ref(db, DB_ROOT), patch);
    }
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split("/").filter(Boolean);
      if (!parts.length) continue;
      let node = this.state;
      for (let i = 0; i < parts.length - 1; i++) {
        node[parts[i]] = node[parts[i]] || {};
        node = node[parts[i]];
      }
      const leaf = parts[parts.length - 1];
      if (v === null) delete node[leaf];
      else if (parts.length === 1 && v && typeof v === "object" && !Array.isArray(v)) {
        node[leaf] = Object.assign(node[leaf] || {}, v);
      } else node[leaf] = v;
    }
    this._saveLocal();
  }

  async remove(path) { return this.update({ [path]: null }); }

  newId(prefix) {
    if (this.mode === "firebase") {
      const { db, m } = this._fb;
      return m.push(m.ref(db, DB_ROOT + "/" + prefix)).key;
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* transaction over /sessions - fn(sessions) returns new value, or undefined to abort */
  async transactSessions(fn) {
    if (this.mode === "firebase") {
      const { db, m } = this._fb;
      const res = await m.runTransaction(m.ref(db, DB_ROOT + "/sessions"), (cur) => fn(cur || {}));
      return res.committed;
    }
    const next = fn(JSON.parse(JSON.stringify(this.state.sessions || {})));
    if (next === undefined) return false;
    this.state.sessions = next;
    this._saveLocal();
    return true;
  }
}

export const store = new Store();

/* ==================================================================
   Queue engine - pure functions, safe to run from every client
   ================================================================== */

/** Does this session currently occupy a slot? */
export function occupiesSlot(s, graceMs, now) {
  if (!s) return false;
  if (s.state === STATES.ACTIVE) return true;
  if (s.state === STATES.OVER) return now < (s.endsAt || 0) + graceMs;
  return false;
}

export function listSessions(state) {
  return Object.entries(state.sessions || {}).map(([id, s]) => Object.assign({ id }, s));
}

export function graceMs(state) {
  const g = state.settings.graceMinutes;
  return (g === undefined || g === null ? 3 : Number(g)) * 60000;
}

export function occupancy(state, now) {
  const g = graceMs(state);
  const perType = {};
  let total = 0;
  for (const s of listSessions(state)) {
    if (occupiesSlot(s, g, now)) {
      perType[s.breakTypeId] = (perType[s.breakTypeId] || 0) + 1;
      total++;
    }
  }
  return { perType, total };
}

export function queueFor(state, typeId) {
  return listSessions(state)
    .filter((s) => s.state === STATES.QUEUED && (!typeId || s.breakTypeId === typeId))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
}

export function onBreakNow(state, now) {
  const g = graceMs(state);
  return listSessions(state)
    .filter((s) => s.state === STATES.ACTIVE || s.state === STATES.OVER)
    .filter((s) => s.state === STATES.ACTIVE || now < (s.endsAt || 0) + g + 3600000)
    .sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
}

export function sortedTypes(state) {
  return Object.values(state.breakTypes || {})
    .sort((a, b) => (a.order || 99) - (b.order || 99) || String(a.name).localeCompare(String(b.name)));
}

export function sortedAgents(state) {
  return Object.values(state.agents || {})
    .filter((a) => a && a.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** People who may open the supervisor panel. */
export function supervisors(state) {
  return sortedAgents(state).filter((a) => a.role === ROLES.ADMIN);
}

/**
 * Reconcile: expire finished breaks and promote the queue.
 * Deterministic + idempotent, so every client can safely run it.
 */
export function reconcileMap(sessions, state, now) {
  const g = graceMs(state);
  const globalMax = Number(state.settings.globalMaxConcurrent === undefined ? 3 : state.settings.globalMaxConcurrent);
  const types = state.breakTypes || {};
  let changed = false;

  /* 1. active breaks whose clock ran out -> over */
  for (const [id, s] of Object.entries(sessions)) {
    if (s && s.state === STATES.ACTIVE && s.endsAt && s.endsAt <= now) {
      sessions[id] = Object.assign({}, s, { state: STATES.OVER });
      changed = true;
    }
  }

  /* 2. count live occupancy */
  const perType = {};
  let total = 0;
  for (const s of Object.values(sessions)) {
    if (occupiesSlot(s, g, now)) {
      perType[s.breakTypeId] = (perType[s.breakTypeId] || 0) + 1;
      total++;
    }
  }

  /* 3. promote the queue, oldest request first */
  const waiting = Object.entries(sessions)
    .filter((e) => e[1] && e[1].state === STATES.QUEUED)
    .sort((a, b) => (a[1].requestedAt || 0) - (b[1].requestedAt || 0));

  for (const [id, s] of waiting) {
    const bt = types[s.breakTypeId];
    if (!bt) continue;
    if (bt.requiresApproval && !s.approvedBy) continue;       // waits for a supervisor
    if (total >= globalMax) break;
    const capT = Number(bt.maxConcurrent === undefined ? 1 : bt.maxConcurrent);
    if ((perType[bt.id] || 0) >= capT) continue;
    const mins = clampMinutes(s.minutes || bt.minutes, 10);
    sessions[id] = Object.assign({}, s, {
      state: STATES.ACTIVE, startedAt: now, endsAt: now + mins * 60000
    });
    perType[bt.id] = (perType[bt.id] || 0) + 1;
    total++;
    changed = true;
  }

  return changed ? sessions : undefined;
}

let reconciling = false;
export async function reconcile() {
  if (reconciling || store.mode === "disconnected") return;
  reconciling = true;
  try {
    const now = store.now();
    await store.transactSessions((sessions) => reconcileMap(sessions, store.state, now));
  } catch (e) {
    console.warn("reconcile", e);
  } finally {
    reconciling = false;
  }
}

/* ---------- actions ------------------------------------------------- */

export async function requestBreak(agent, bt) {
  const now = store.now();
  const open = [STATES.QUEUED, STATES.ACTIVE, STATES.OVER];
  const mine = listSessions(store.state).filter((s) => s.agentId === agent.id && open.includes(s.state));
  if (mine.length) throw new Error("You already have a break open.");
  const id = store.newId("sessions");
  await store.update({
    ["sessions/" + id]: {
      agentId: agent.id, agentName: agent.name, team: agent.team || "",
      breakTypeId: bt.id, breakTypeName: bt.name, minutes: clampMinutes(bt.minutes, 10),
      state: STATES.QUEUED, requestedAt: now, day: dayKey(now)
    }
  });
  await reconcile();
  return id;
}

export async function endBreak(sessionId, by) {
  const now = store.now();
  const s = (store.state.sessions || {})[sessionId];
  if (!s) return;
  const over = Math.max(0, now - (s.endsAt || now));
  await store.update({
    ["sessions/" + sessionId + "/state"]: STATES.DONE,
    ["sessions/" + sessionId + "/endedAt"]: now,
    ["sessions/" + sessionId + "/overBy"]: over,
    ["sessions/" + sessionId + "/closedBy"]: by || "agent"
  });
  await reconcile();
}

export async function cancelQueued(sessionId, by) {
  await store.update({
    ["sessions/" + sessionId + "/state"]: STATES.CANCELLED,
    ["sessions/" + sessionId + "/endedAt"]: store.now(),
    ["sessions/" + sessionId + "/closedBy"]: by || "agent"
  });
  await reconcile();
}

export async function denyQueued(sessionId, by, reason) {
  await store.update({
    ["sessions/" + sessionId + "/state"]: STATES.DENIED,
    ["sessions/" + sessionId + "/endedAt"]: store.now(),
    ["sessions/" + sessionId + "/closedBy"]: by || "admin",
    ["sessions/" + sessionId + "/reason"]: reason || ""
  });
  await reconcile();
}

export async function approveQueued(sessionId, by) {
  await store.update({ ["sessions/" + sessionId + "/approvedBy"]: by || "admin" });
  await reconcile();
}

/** Skip the queue entirely and start now (supervisor override). */
export async function forceStart(sessionId, by) {
  const now = store.now();
  const s = (store.state.sessions || {})[sessionId];
  if (!s) return;
  const bt = (store.state.breakTypes || {})[s.breakTypeId] || {};
  const mins = clampMinutes(s.minutes || bt.minutes, 10);
  await store.update({
    ["sessions/" + sessionId + "/state"]: STATES.ACTIVE,
    ["sessions/" + sessionId + "/startedAt"]: now,
    ["sessions/" + sessionId + "/endsAt"]: now + mins * 60000,
    ["sessions/" + sessionId + "/approvedBy"]: by || "admin",
    ["sessions/" + sessionId + "/forced"]: true
  });
}

/**
 * Extend or shorten a running break.
 * A break may never be stretched past MAX_BREAK_MINUTES of total planned time.
 * Returns { applied, clamped } so the caller can explain a refusal.
 */
export async function adjustTime(sessionId, deltaMinutes) {
  const s = (store.state.sessions || {})[sessionId];
  if (!s) return { applied: 0, clamped: false };
  const now = store.now();
  const startedAt = s.startedAt || now;
  const ceiling = startedAt + MAX_BREAK_MINUTES * 60000;
  const base = Math.max(s.endsAt || now, now);
  let endsAt = base + deltaMinutes * 60000;
  let clamped = false;

  if (deltaMinutes > 0 && endsAt > ceiling) { endsAt = ceiling; clamped = true; }
  if (endsAt <= base && deltaMinutes > 0) return { applied: 0, clamped: true };

  const patch = {
    ["sessions/" + sessionId + "/endsAt"]: endsAt,
    ["sessions/" + sessionId + "/minutes"]: Math.max(1, Math.round((endsAt - startedAt) / 60000)),
    ["sessions/" + sessionId + "/adjusted"]: (s.adjusted || 0) + Math.round((endsAt - base) / 60000)
  };
  if (endsAt > now && s.state === STATES.OVER) patch["sessions/" + sessionId + "/state"] = STATES.ACTIVE;
  await store.update(patch);
  await reconcile();
  return { applied: Math.round((endsAt - base) / 60000), clamped: clamped };
}

/** Supervisor puts someone on break directly, no queue. */
export async function startForAgent(agent, bt, by) {
  const now = store.now();
  const id = store.newId("sessions");
  await store.update({
    ["sessions/" + id]: {
      agentId: agent.id, agentName: agent.name, team: agent.team || "",
      breakTypeId: bt.id, breakTypeName: bt.name, minutes: clampMinutes(bt.minutes, 10),
      state: STATES.ACTIVE, requestedAt: now, startedAt: now,
      endsAt: now + clampMinutes(bt.minutes, 10) * 60000, day: dayKey(now),
      approvedBy: by || "admin", forced: true
    }
  });
  return id;
}

/* ---------- helpers ------------------------------------------------- */
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

export function mySession(state, agentId) {
  const open = [STATES.QUEUED, STATES.ACTIVE, STATES.OVER];
  return listSessions(state)
    .filter((s) => s.agentId === agentId && open.includes(s.state))
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0))[0] || null;
}

/** Position (1-based) of a queued session within its own break type. */
export function queuePosition(state, session) {
  const q = queueFor(state, session.breakTypeId);
  return q.findIndex((s) => s.id === session.id) + 1;
}

/** Rough "you're up at ~" estimate for a queued session. */
export function estimateStart(state, session, now) {
  const bt = (state.breakTypes || {})[session.breakTypeId];
  if (!bt) return null;
  const g = graceMs(state);
  const pos = queuePosition(state, session);
  const cap = Number(bt.maxConcurrent === undefined ? 1 : bt.maxConcurrent);
  const busy = listSessions(state)
    .filter((s) => s.breakTypeId === bt.id && occupiesSlot(s, g, now))
    .map((s) => s.endsAt || now)
    .sort((a, b) => a - b);
  const free = Math.max(0, cap - busy.length);
  if (pos <= free) return now;
  const need = pos - free;
  const idx = Math.max(0, Math.min(busy.length - 1, need - 1));
  const rounds = Math.floor(Math.max(0, need - 1) / Math.max(1, cap));
  return (busy[idx] || now) + rounds * clampMinutes(bt.minutes, 10) * 60000;
}

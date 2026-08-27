/* ============================================================
   BreakFlow - accounts, data and the queue engine

   Everything lives in this browser's localStorage. No server, no
   third-party service, nothing to set up: put the site on one shared
   break-board PC, create the accounts, and the team uses that machine.

   Consequences, stated plainly:
     * Data does not leave this browser. Another computer sees an
       empty app. Take backups (Admin -> Settings -> Backup).
     * Login stops people acting as each other by accident or mischief.
       It is not real security: anyone with developer tools on this PC
       can read or edit the stored data directly.
   ============================================================ */

import { DEFAULTS, SEED_ADMIN } from "./config.js";

const LS_DATA = "breakflow.db";
const LS_SESSION = "breakflow.session";
const LS_ACTIVE = "breakflow.lastActive";

export const STATES = {
  QUEUED: "queued", ACTIVE: "active", OVER: "over",
  DONE: "done", CANCELLED: "cancelled", DENIED: "denied"
};
const CLOSED = [STATES.DONE, STATES.CANCELLED, STATES.DENIED];
const OPEN = [STATES.QUEUED, STATES.ACTIVE, STATES.OVER];

export const ROLES = { AGENT: "agent", ADMIN: "admin" };

/** Hard ceiling on any single break, in minutes. */
export const MAX_BREAK_MINUTES = 60;

export function clampMinutes(v, fallback) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return Math.min(MAX_BREAK_MINUTES, Number(fallback) || 1);
  return Math.min(MAX_BREAK_MINUTES, Math.max(1, Math.round(n)));
}

/* ---------- passwords ----------------------------------------------
   PBKDF2-SHA256 via the built-in Web Crypto, so no libraries. Needs a
   secure context, which https and localhost both are.
   ------------------------------------------------------------------ */
const PBKDF2_ROUNDS = 120000;

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  const out = new Uint8Array(String(hex).length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(String(hex).substr(i * 2, 2), 16);
  return out;
}

export async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" }, key, 256
  );
  return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)) };
}

async function verifyPassword(password, saltHex, hashHex) {
  if (!saltHex || !hashHex) return false;
  const { hash } = await hashPassword(password, saltHex);
  /* length-safe comparison; not timing-critical here but cheap to do */
  if (hash.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

export function normUsername(u) {
  return String(u || "").trim().toLowerCase().replace(/\s+/g, "");
}

/* ---------- event bus ----------------------------------------------- */
function bus() {
  const subs = new Set();
  return {
    on: (f) => { subs.add(f); return () => subs.delete(f); },
    emit: (v) => subs.forEach((f) => { try { f(v); } catch (e) { console.error(e); } })
  };
}

/**
 * The owner's account, ready to sign into on a fresh machine.
 * Returns {} if config.js has no SEED_ADMIN, which falls back to the
 * "create the first admin" setup screen.
 */
function seededAdmin() {
  const s = SEED_ADMIN;
  if (!s || !s.username || !s.salt || !s.hash) return {};
  const uid = "owner";
  return {
    [uid]: {
      uid: uid,
      username: String(s.username).trim().toLowerCase(),
      name: s.name || s.username,
      team: s.team || "",
      role: ROLES.ADMIN,
      salt: s.salt,
      hash: s.hash,
      seeded: true,
      createdAt: Date.now()
    }
  };
}

function withDefaults(s) {
  const st = s || {};
  return {
    settings: Object.assign({
      teamName: DEFAULTS.teamName,
      globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
      graceMinutes: DEFAULTS.graceMinutes,
      kioskTimeoutSec: DEFAULTS.kioskTimeoutSec
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
    this.state = withDefaults(null);
    this.user = null;              // signed-in account record
    this.access = "unknown";       // unknown | setup | signed-out | ok
    this._changes = bus();
    this._status = bus();
    this._errors = bus();
  }

  onChange(fn) { const off = this._changes.on(fn); fn(this.state); return off; }
  onStatus(fn) { const off = this._status.on(fn); fn(this.statusSnapshot()); return off; }
  onError(fn) { return this._errors.on(fn); }

  statusSnapshot() { return { access: this.access, user: this.user }; }
  now() { return Date.now(); }
  isAdmin() { return !!(this.user && this.user.role === ROLES.ADMIN); }
  uid() { return this.user ? this.user.uid : null; }
  get member() { return this.user; }

  _emit() { this._changes.emit(this.state); }
  _pushStatus() { this._status.emit(this.statusSnapshot()); }
  _fail(err, what) {
    this._errors.emit({ error: err, what: what });
    console.warn("BreakFlow:", what, err);
  }

  /* ---------------- load / save ---------------- */
  async connect() {
    this._load();
    /* another tab changed things - pick it up */
    addEventListener("storage", (e) => {
      if (e.key === LS_DATA) { this._load(true); this._emit(); this._pushStatus(); }
      if (e.key === LS_SESSION) { this._resume(); this._pushStatus(); this._emit(); }
    });
    this._resume();
    this._pushStatus();
    this._emit();
    return "local";
  }

  _load(keepSession) {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_DATA) || "null"); } catch (e) { /* ignore */ }
    if (!raw) {
      raw = {
        settings: {
          teamName: DEFAULTS.teamName,
          globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
          graceMinutes: DEFAULTS.graceMinutes,
          kioskTimeoutSec: DEFAULTS.kioskTimeoutSec,
          createdAt: Date.now()
        },
        breakTypes: DEFAULTS.breakTypes,
        agents: seededAdmin(),
        sessions: {}
      };
      localStorage.setItem(LS_DATA, JSON.stringify(raw));
    }
    this.state = withDefaults(raw);
    this._repair();
    if (!keepSession && !Object.keys(this.state.agents).length) this.access = "setup";
  }

  /**
   * Bring a database that already exists up to a usable state.
   *
   * Both of these used to happen only when the database was created
   * from scratch, which left any browser that had already visited
   * stranded: it kept its old contents and never got the owner account
   * or the break types.
   */
  _repair() {
    let changed = this._ensureSeededAdmin();
    if (!Object.keys(this.state.breakTypes || {}).length) {
      this.state.breakTypes = JSON.parse(JSON.stringify(DEFAULTS.breakTypes));
      changed = true;
    }
    if (changed) {
      try { localStorage.setItem(LS_DATA, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
    }
    return changed;
  }

  /**
   * Make sure there is always a way in.
   *
   * Whenever there is no admin at all, put the seeded owner back. A
   * working board always has at least one admin, so this never touches
   * a real setup or undoes a changed password.
   */
  _ensureSeededAdmin() {
    const s = SEED_ADMIN;
    if (!s || !s.username || !s.salt || !s.hash) return false;
    if (admins(this.state).length) return false;

    const uname = normUsername(s.username);
    const existing = sortedAgents(this.state).find((a) => normUsername(a.username) === uname);
    if (existing) {
      /* promote rather than duplicate the username - and leave their
         own password alone, since it is not ours to overwrite */
      existing.role = ROLES.ADMIN;
    } else {
      Object.assign(this.state.agents, seededAdmin());
    }
    return true;
  }

  _save() {
    try { localStorage.setItem(LS_DATA, JSON.stringify(this.state)); }
    catch (e) { this._fail(e, "save to this browser"); throw e; }
    this._emit();
  }

  /** Restore the signed-in account from the last session, if any. */
  _resume() {
    const uid = localStorage.getItem(LS_SESSION);
    if (!Object.keys(this.state.agents).length) { this.user = null; this.access = "setup"; return; }
    if (uid && this.state.agents[uid]) {
      this.user = this.state.agents[uid];
      this.access = "ok";
    } else {
      this.user = null;
      this.access = "signed-out";
    }
  }

  /* ---------------- accounts ---------------- */
  needsSetup() { return !Object.keys(this.state.agents || {}).length; }

  findByUsername(username) {
    const u = normUsername(username);
    return sortedAgents(this.state).find((a) => normUsername(a.username) === u) || null;
  }

  async signIn(username, password) {
    const rec = this.findByUsername(username);
    if (!rec) throw new Error("No account with that username.");
    const ok = await verifyPassword(password, rec.salt, rec.hash);
    if (!ok) throw new Error("Wrong password.");
    localStorage.setItem(LS_SESSION, rec.uid);
    this.touch();
    this.user = rec;
    this.access = "ok";
    this._pushStatus();
    this._emit();
    return rec;
  }

  signOut() {
    localStorage.removeItem(LS_SESSION);
    this.user = null;
    this.access = this.needsSetup() ? "setup" : "signed-out";
    this._pushStatus();
    this._emit();
  }

  touch() { try { localStorage.setItem(LS_ACTIVE, String(Date.now())); } catch (e) { /* ignore */ } }
  lastActive() { return Number(localStorage.getItem(LS_ACTIVE) || 0); }

  newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Create an account. First one is forced to admin so you can't lock yourself out. */
  async createAccount(opts) {
    const username = normUsername(opts.username);
    if (!username) throw new Error("A username is required.");
    if (!/^[a-z0-9._-]{2,32}$/.test(username)) {
      throw new Error("Usernames can use letters, numbers, dot, dash and underscore (2-32 characters).");
    }
    if (this.findByUsername(username)) throw new Error("That username is already taken.");
    if (String(opts.password || "").length < 4) throw new Error("Password must be at least 4 characters.");

    const first = this.needsSetup();
    if (!first && !this.isAdmin()) throw new Error("Only an admin can create accounts.");

    const { salt, hash } = await hashPassword(opts.password);
    const uid = this.newId();
    this.state.agents[uid] = {
      uid: uid,
      username: username,
      name: String(opts.name || "").trim() || username,
      team: String(opts.team || "").trim(),
      role: first ? ROLES.ADMIN : (opts.role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.AGENT),
      salt: salt, hash: hash,
      createdAt: Date.now()
    };
    this._save();
    return this.state.agents[uid];
  }

  /**
   * Admin sets someone's password, or you change your own.
   *
   * If a currentPassword is supplied it is ALWAYS checked, admin or
   * not - otherwise the "change your password" dialog would ask for it
   * and then ignore it for admins. Admins resetting somebody else (the
   * Accounts tab) pass nothing and skip the check, which is also how an
   * admin who forgot their own password gets back in.
   */
  async setPassword(uid, password, currentPassword) {
    const rec = this.state.agents[uid];
    if (!rec) throw new Error("No such account.");
    const isSelf = this.user && this.user.uid === uid;
    if (!this.isAdmin() && !isSelf) throw new Error("Not allowed.");

    const gaveCurrent = currentPassword !== undefined && currentPassword !== null;
    if (isSelf && !this.isAdmin() && !gaveCurrent) throw new Error("Enter your current password.");
    if (gaveCurrent) {
      const ok = await verifyPassword(currentPassword, rec.salt, rec.hash);
      if (!ok) throw new Error("Your current password is wrong.");
    }
    if (String(password || "").length < 4) throw new Error("Password must be at least 4 characters.");
    const { salt, hash } = await hashPassword(password);
    rec.salt = salt;
    rec.hash = hash;
    rec.passwordChangedAt = Date.now();
    delete rec.seeded;          /* no longer the one shipped in config.js */
    this._save();
    if (this.user && this.user.uid === uid) { this.user = rec; this._pushStatus(); }
  }

  /** True while this account still uses the password published in config.js. */
  usingSeededPassword() {
    return !!(this.user && this.user.seeded);
  }

  async updateAccount(uid, patch) {
    const rec = this.state.agents[uid];
    if (!rec) throw new Error("No such account.");
    const isSelf = this.user && this.user.uid === uid;
    if (!this.isAdmin() && !isSelf) throw new Error("Not allowed.");

    if (patch.username !== undefined) {
      const username = normUsername(patch.username);
      if (!username) throw new Error("A username is required.");
      const clash = this.findByUsername(username);
      if (clash && clash.uid !== uid) throw new Error("That username is already taken.");
      rec.username = username;
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error("A name is required.");
      rec.name = name;
    }
    if (patch.team !== undefined) rec.team = String(patch.team).trim();
    if (patch.role !== undefined) {
      if (!this.isAdmin()) throw new Error("Only an admin can change roles.");
      const next = patch.role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.AGENT;
      if (next === ROLES.AGENT && rec.role === ROLES.ADMIN && admins(this.state).length <= 1) {
        throw new Error("Keep at least one admin.");
      }
      rec.role = next;
    }
    this._save();
    if (isSelf) { this.user = rec; this._pushStatus(); }
    return rec;
  }

  async deleteAccount(uid) {
    if (!this.isAdmin()) throw new Error("Only an admin can remove accounts.");
    const rec = this.state.agents[uid];
    if (!rec) return;
    if (rec.role === ROLES.ADMIN && admins(this.state).length <= 1) {
      throw new Error("Keep at least one admin.");
    }
    delete this.state.agents[uid];
    this._save();
    if (this.user && this.user.uid === uid) this.signOut();
  }

  /* ---------------- writes ---------------- */
  /** patch: { "a/b/c": value }  - null deletes. */
  update(patch) {
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
    this._save();
  }

  /* ---------------- backup ---------------- */
  exportJSON() {
    return JSON.stringify({
      breakflow: 1,
      exportedAt: new Date().toISOString(),
      data: this.state
    }, null, 2);
  }

  /** Replace everything with a backup file. Signs out afterwards. */
  importJSON(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error("That file isn't valid JSON."); }
    const data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== "object" || !data.agents || !data.breakTypes) {
      throw new Error("That doesn't look like a BreakFlow backup.");
    }
    this.state = withDefaults(data);
    this._save();
    this.signOut();
  }

  wipeEverything() {
    localStorage.removeItem(LS_DATA);
    localStorage.removeItem(LS_SESSION);
    localStorage.removeItem(LS_ACTIVE);
  }
}

export const store = new Store();

/* ==================================================================
   Reads / derived state
   ================================================================== */

export function listSessions(state) {
  return Object.entries(state.sessions || {}).map(([id, s]) => Object.assign({ id }, s));
}

export function graceMs(state) {
  const g = state.settings.graceMinutes;
  return (g === undefined || g === null ? 3 : Number(g)) * 60000;
}

/** Time-based, so slot maths never depends on a status flag being written. */
export function occupiesSlot(s, g, now) {
  if (!s) return false;
  if (CLOSED.indexOf(s.state) >= 0) return false;
  if (s.state === STATES.QUEUED) return false;
  return now < (s.endsAt || 0) + g;
}

export function isOver(s, now) {
  return !!s && OPEN.indexOf(s.state) >= 0 && s.state !== STATES.QUEUED && now > (s.endsAt || 0);
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
    .filter((s) => s.state !== STATES.QUEUED && CLOSED.indexOf(s.state) < 0)
    .filter((s) => now < (s.endsAt || 0) + g + 3600000)
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

export function admins(state) {
  return sortedAgents(state).filter((a) => a.role === ROLES.ADMIN);
}
export const supervisors = admins;

export function mySession(state, uid) {
  return listSessions(state)
    .filter((s) => s.agentId === uid && OPEN.indexOf(s.state) >= 0)
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0))[0] || null;
}

export function queuePosition(state, session) {
  const q = queueFor(state, session.breakTypeId);
  return q.findIndex((s) => s.id === session.id) + 1;
}

/* ==================================================================
   Queue engine
   ================================================================== */

/** Which queued breaks should start now, and which have run out. */
export function plan(state, now) {
  const g = graceMs(state);
  const globalMax = Number(state.settings.globalMaxConcurrent === undefined ? 3 : state.settings.globalMaxConcurrent);
  const types = state.breakTypes || {};

  const perType = {};
  let total = 0;
  for (const s of listSessions(state)) {
    if (occupiesSlot(s, g, now)) {
      perType[s.breakTypeId] = (perType[s.breakTypeId] || 0) + 1;
      total++;
    }
  }

  const start = [];
  for (const s of queueFor(state)) {
    const bt = types[s.breakTypeId];
    if (!bt) continue;
    if (bt.requiresApproval && !s.approvedBy) continue;
    if (total >= globalMax) break;
    const cap = Number(bt.maxConcurrent === undefined ? 1 : bt.maxConcurrent);
    if ((perType[bt.id] || 0) >= cap) continue;
    start.push(s);
    perType[bt.id] = (perType[bt.id] || 0) + 1;
    total++;
  }

  const expire = listSessions(state).filter((s) => s.state === STATES.ACTIVE && s.endsAt && s.endsAt <= now);
  return { start, expire };
}

export function reconcile() {
  const now = store.now();
  const p = plan(store.state, now);
  if (!p.start.length && !p.expire.length) return;
  const patch = {};
  for (const s of p.expire) patch["sessions/" + s.id + "/state"] = STATES.OVER;
  for (const s of p.start) {
    const bt = (store.state.breakTypes || {})[s.breakTypeId] || {};
    const mins = clampMinutes(s.minutes || bt.minutes, 10);
    patch["sessions/" + s.id + "/state"] = STATES.ACTIVE;
    patch["sessions/" + s.id + "/startedAt"] = now;
    patch["sessions/" + s.id + "/endsAt"] = now + mins * 60000;
  }
  store.update(patch);
}

/* ---------- actions ------------------------------------------------- */

export function requestBreak(agent, bt) {
  const now = store.now();
  const open = listSessions(store.state).filter((s) => s.agentId === agent.uid && OPEN.indexOf(s.state) >= 0);
  if (open.length) throw new Error("You already have a break open.");
  const id = store.newId();
  store.update({
    ["sessions/" + id]: {
      agentId: agent.uid, agentName: agent.name, team: agent.team || "",
      breakTypeId: bt.id, breakTypeName: bt.name, minutes: clampMinutes(bt.minutes, 10),
      state: STATES.QUEUED, requestedAt: now, day: dayKey(now)
    }
  });
  reconcile();
  return id;
}

export function endBreak(sessionId, by) {
  const now = store.now();
  const s = (store.state.sessions || {})[sessionId];
  if (!s) return;
  store.update({
    ["sessions/" + sessionId + "/state"]: STATES.DONE,
    ["sessions/" + sessionId + "/endedAt"]: now,
    ["sessions/" + sessionId + "/overBy"]: Math.max(0, now - (s.endsAt || now)),
    ["sessions/" + sessionId + "/closedBy"]: by || "agent"
  });
  reconcile();
}

export function cancelQueued(sessionId, by) {
  store.update({
    ["sessions/" + sessionId + "/state"]: STATES.CANCELLED,
    ["sessions/" + sessionId + "/endedAt"]: store.now(),
    ["sessions/" + sessionId + "/closedBy"]: by || "agent"
  });
  reconcile();
}

export function denyQueued(sessionId, by, reason) {
  store.update({
    ["sessions/" + sessionId + "/state"]: STATES.DENIED,
    ["sessions/" + sessionId + "/endedAt"]: store.now(),
    ["sessions/" + sessionId + "/closedBy"]: by || "admin",
    ["sessions/" + sessionId + "/reason"]: reason || ""
  });
  reconcile();
}

export function approveQueued(sessionId, by) {
  store.update({ ["sessions/" + sessionId + "/approvedBy"]: by || "admin" });
  reconcile();
}

export function forceStart(sessionId, by) {
  const now = store.now();
  const s = (store.state.sessions || {})[sessionId];
  if (!s) return;
  const bt = (store.state.breakTypes || {})[s.breakTypeId] || {};
  const mins = clampMinutes(s.minutes || bt.minutes, 10);
  store.update({
    ["sessions/" + sessionId + "/state"]: STATES.ACTIVE,
    ["sessions/" + sessionId + "/startedAt"]: now,
    ["sessions/" + sessionId + "/endsAt"]: now + mins * 60000,
    ["sessions/" + sessionId + "/approvedBy"]: by || "admin",
    ["sessions/" + sessionId + "/forced"]: true
  });
}

/** Never stretches a break past MAX_BREAK_MINUTES of planned time. */
export function adjustTime(sessionId, deltaMinutes) {
  const s = (store.state.sessions || {})[sessionId];
  if (!s) return { applied: 0, clamped: false };
  const now = store.now();
  const startedAt = s.startedAt || now;
  const ceiling = startedAt + MAX_BREAK_MINUTES * 60000;
  const base = Math.max(s.endsAt || now, now);
  let endsAt = base + deltaMinutes * 60000;
  let clamped = false;

  if (deltaMinutes > 0 && endsAt > ceiling) { endsAt = ceiling; clamped = true; }
  if (deltaMinutes > 0 && endsAt <= base) return { applied: 0, clamped: true };

  const patch = {
    ["sessions/" + sessionId + "/endsAt"]: endsAt,
    ["sessions/" + sessionId + "/minutes"]: Math.max(1, Math.round((endsAt - startedAt) / 60000)),
    ["sessions/" + sessionId + "/adjusted"]: (s.adjusted || 0) + Math.round((endsAt - base) / 60000)
  };
  if (endsAt > now && s.state === STATES.OVER) patch["sessions/" + sessionId + "/state"] = STATES.ACTIVE;
  store.update(patch);
  reconcile();
  return { applied: Math.round((endsAt - base) / 60000), clamped: clamped };
}

export function startForAgent(agent, bt, by) {
  const now = store.now();
  const id = store.newId();
  const mins = clampMinutes(bt.minutes, 10);
  store.update({
    ["sessions/" + id]: {
      agentId: agent.uid, agentName: agent.name, team: agent.team || "",
      breakTypeId: bt.id, breakTypeName: bt.name, minutes: mins,
      state: STATES.ACTIVE, requestedAt: now, startedAt: now,
      endsAt: now + mins * 60000, day: dayKey(now),
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

/** Rough "you're up at ~" estimate for a queued break. */
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

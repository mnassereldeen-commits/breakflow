/* ============================================================
   BreakFlow - accounts, data and the queue engine

   The shared data (accounts, break policies, live sessions) lives in
   Firebase Realtime Database and is synced to every PC that opens the
   site - that's what makes one live board possible across separate
   machines. Only one thing stays local: which account is signed in on
   this tab, kept in sessionStorage rather than localStorage so it
   clears itself when the browser closes - no idle timer, no "kiosk"
   behaviour, just sign in and sign out like any other site. Take
   backups (Admin -> Settings -> Backup) in case the database is ever
   wiped or misconfigured.

   Login stops people acting as each other by accident or mischief. It
   is not real security: anyone with developer tools and the Firebase
   config (which is public, by design - see config.js) can read or
   write the database directly.
   ============================================================ */

import { DEFAULTS, SEED_ADMIN } from "./config.js";
import { connectFirebase, watchRoot, writePatch, transactSessions, readServerOffset } from "./firebase.js";
import {
  STATES, OPEN, MAX_BREAK_MINUTES, READY_WINDOW_MS, HOLD_CAP_MS, clampMinutes,
  listSessions, plan, planIsEmpty,
  applyReconcile, applyRequest, applyConfirmReady, applyEnd, applyCancel, applyDeny,
  applyApprove, applyForceStart, applyAdjust, applyStartFor
} from "./engine.js";

export { STATES, MAX_BREAK_MINUTES, READY_WINDOW_MS, HOLD_CAP_MS, clampMinutes };

const LS_SESSION = "breakflow.session";

export const ROLES = { AGENT: "agent", ADMIN: "admin" };

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

/* ------------------------------------------------------------------
   Can this browser store anything at all? Private Browsing and
   "block cookies and site data" both let reads through but reject
   writes, which used to crash the app on a first visit and show a
   blank page - a common way for a phone to look simply broken.
   ------------------------------------------------------------------ */
function storageWorks() {
  try {
    const k = "__breakflow_probe__";
    sessionStorage.setItem(k, "1");
    sessionStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
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
      graceMinutes: DEFAULTS.graceMinutes
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
    this.access = "unknown";       // unknown | no-storage | no-connection | setup | signed-out | ok
    this.clockOffset = 0;          // server time minus this PC's clock, so every screen agrees on "now"
    this._changes = bus();
    this._status = bus();
    this._errors = bus();
  }

  onChange(fn) { const off = this._changes.on(fn); fn(this.state); return off; }
  onStatus(fn) { const off = this._status.on(fn); fn(this.statusSnapshot()); return off; }
  onError(fn) { return this._errors.on(fn); }

  statusSnapshot() { return { access: this.access, user: this.user }; }
  /** The database server's clock, not this PC's - PCs disagree by minutes more often than you'd think. */
  now() { return Date.now() + this.clockOffset; }
  isAdmin() { return !!(this.user && this.user.role === ROLES.ADMIN); }
  uid() { return this.user ? this.user.uid : null; }
  get member() { return this.user; }

  _emit() { this._changes.emit(this.state); }
  _pushStatus() { this._status.emit(this.statusSnapshot()); }
  _fail(err, what) {
    this._errors.emit({ error: err, what: what });
    console.warn("BreakFlow:", what, err);
  }

  /** Local-only write (which account is signed in on this tab), so blocked storage is survivable. */
  _write(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch (e) {
      this.storageOk = false;
      this._fail(e, "remember your sign-in in this tab");
      return false;
    }
  }

  /** Push a sparse patch to the shared database. Fire-and-forget; errors surface as toasts. */
  _writeRemote(patch) {
    return writePatch(patch).catch((e) => this._fail(e, "save to the shared board"));
  }

  /* ---------------- load / save ---------------- */
  async connect() {
    this.storageOk = storageWorks();
    if (!this.storageOk) {
      this.access = "no-storage";
      this._pushStatus();
      return "no-storage";
    }

    try {
      await connectFirebase();
      this.clockOffset = await readServerOffset(3000);
    } catch (e) {
      this.access = "no-connection";
      this._fail(e, "connect to the shared board");
      this._pushStatus();
      return "no-connection";
    }

    return new Promise((resolve) => {
      let settled = false;
      watchRoot(
        (raw) => {
          this._applySnapshot(raw);
          if (!settled) { settled = true; resolve("cloud"); }
        },
        (e) => {
          if (settled) return;
          settled = true;
          this.access = "no-connection";
          this._fail(e, "read the shared board");
          this._pushStatus();
          resolve("no-connection");
        }
      );
    });
  }

  /** Runs on the first snapshot and on every change from any PC on the team. */
  _applySnapshot(raw) {
    if (!raw) {
      /* the database is empty - this is the very first run for the whole team */
      raw = {
        settings: {
          teamName: DEFAULTS.teamName,
          globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
          graceMinutes: DEFAULTS.graceMinutes,
          createdAt: Date.now()
        },
        breakTypes: DEFAULTS.breakTypes,
        agents: seededAdmin(),
        sessions: {}
      };
      this._writeRemote(raw);
    }
    this.state = withDefaults(raw);
    this._repair();
    this._resume();
    this._pushStatus();
    this._emit();
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
      this._writeRemote({ agents: this.state.agents, breakTypes: this.state.breakTypes });
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

  /** Account changes push the whole (small) roster + break types, not the fast-moving sessions. */
  _save() {
    this._writeRemote({ agents: this.state.agents, breakTypes: this.state.breakTypes });
    this._emit();
  }

  /** Restore the signed-in account from this tab's session, if any. */
  _resume() {
    const uid = sessionStorage.getItem(LS_SESSION);
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
    this._write(LS_SESSION, rec.uid);
    this.user = rec;
    this.access = "ok";
    this._pushStatus();
    this._emit();
    return rec;
  }

  /** Also clears on its own when the tab or browser closes, since the session lives in sessionStorage. */
  signOut() {
    sessionStorage.removeItem(LS_SESSION);
    this.user = null;
    this.access = this.needsSetup() ? "setup" : "signed-out";
    this._pushStatus();
    this._emit();
  }

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
  /**
   * patch: { "a/b/c": value } - null deletes. Applied to local state right
   * away (so the UI never waits on a round trip) and pushed to the shared
   * database as the same sparse patch, so it can never race a session
   * another PC is writing the way a full-tree overwrite would.
   */
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
    this._writeRemote(patch);
    this._emit();
  }

  /**
   * Change the live sessions atomically. `fn(state, now)` edits
   * `state.sessions` in place and returns true if it changed anything; it
   * is re-run against the latest data if another PC got there first, so it
   * must decide from `state` alone. Resolves { changed, aborted }.
   */
  mutate(fn) {
    let changed = false;
    return transactSessions((sessions) => {
      const view = { settings: this.state.settings, breakTypes: this.state.breakTypes, sessions: sessions };
      changed = !!fn(view, this.now());
      return changed;
    }).then(
      (res) => ({ changed: changed && !!(res && res.committed), aborted: !(res && res.committed) }),
      (e) => { this._fail(e, "save to the shared board"); return { changed: false, aborted: true, error: e }; }
    );
  }

  /* ---------------- backup ---------------- */
  exportJSON() {
    return JSON.stringify({
      breakflow: 1,
      exportedAt: new Date().toISOString(),
      data: this.state
    }, null, 2);
  }

  /** Replace everything on the shared board with a backup file. Signs out afterwards. */
  async importJSON(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error("That file isn't valid JSON."); }
    const data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== "object" || !data.agents || !data.breakTypes) {
      throw new Error("That doesn't look like a BreakFlow backup.");
    }
    this.state = withDefaults(data);
    await this._writeRemote({
      settings: this.state.settings,
      breakTypes: this.state.breakTypes,
      agents: this.state.agents,
      sessions: this.state.sessions
    });
    this._emit();
    this.signOut();
  }

  /** Erases the shared board for the whole team, not just this PC. */
  async wipeEverything() {
    await this._writeRemote({ settings: null, breakTypes: null, agents: null, sessions: null });
    sessionStorage.removeItem(LS_SESSION);
  }
}

export const store = new Store();

/* ==================================================================
   Reads / derived state - plain functions, shared with the tests
   ================================================================== */

export {
  listSessions, graceMs, holdsUntilBack, occupiesSlot, isOver, occupancy, queueFor,
  onBreakNow, awaitingConfirm, mySession, queuePosition, estimateStart, plan, dayKey
} from "./engine.js";

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

/* ==================================================================
   Actions on sessions

   Every one of these runs inside a database transaction (see
   Store.mutate): it re-checks the session against the latest data and
   only acts if it is still in the state the caller expected. Screens
   used to write their own copy of "what should happen next" straight to
   the database, which let two PCs hand out the same slot and let a
   stale one reopen a break somebody had just closed.
   ================================================================== */

let reconciling = false;

/** Hand out free slots, start unanswered offers, mark what has run out. */
export function reconcile() {
  if (reconciling || store.access === "no-connection") return;
  /* cheap local look first, so an idle board costs no database round trips */
  if (planIsEmpty(plan(store.state, store.now()))) return;
  reconciling = true;
  store.mutate((state, now) => applyReconcile(state, now))
    .finally(() => { reconciling = false; });
}

export function confirmReady(sessionId, by) {
  store.mutate((state, now) => applyConfirmReady(state, sessionId, by, now));
}

export function requestBreak(agent, bt) {
  const open = listSessions(store.state).some((s) => s.agentId === agent.uid && OPEN.indexOf(s.state) >= 0);
  if (open) throw new Error("You already have a break open.");
  const id = store.newId();
  store.mutate((state, now) => applyRequest(state, id, agent, bt, now)).then((res) => {
    if (res && res.aborted) store._fail(new Error("You already have a break open."), "request a break");
    reconcile();
  });
  return id;
}

export function endBreak(sessionId, by) {
  store.mutate((state, now) => applyEnd(state, sessionId, by, now)).then(reconcile);
}

export function cancelQueued(sessionId, by) {
  store.mutate((state, now) => applyCancel(state, sessionId, by, now)).then(reconcile);
}

export function denyQueued(sessionId, by, reason) {
  store.mutate((state, now) => applyDeny(state, sessionId, by, reason, now)).then(reconcile);
}

export function approveQueued(sessionId, by) {
  store.mutate((state) => applyApprove(state, sessionId, by)).then(reconcile);
}

export function forceStart(sessionId, by) {
  store.mutate((state, now) => applyForceStart(state, sessionId, by, now));
}

/**
 * Never stretches a break past MAX_BREAK_MINUTES of planned time.
 * Returns straight away with what the change will be (worked out on the
 * screen's copy); the real change is made against the latest data.
 */
export function adjustTime(sessionId, deltaMinutes) {
  const preview = { applied: 0, clamped: false };
  const copy = JSON.parse(JSON.stringify({
    settings: store.state.settings, breakTypes: store.state.breakTypes, sessions: store.state.sessions
  }));
  applyAdjust(copy, sessionId, deltaMinutes, store.now(), preview);
  store.mutate((state, now) => applyAdjust(state, sessionId, deltaMinutes, now)).then(reconcile);
  return preview;
}

export function startForAgent(agent, bt, by) {
  const id = store.newId();
  store.mutate((state, now) => applyStartFor(state, id, agent, bt, by, now));
  return id;
}
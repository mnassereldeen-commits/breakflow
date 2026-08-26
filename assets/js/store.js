/* ============================================================
   BreakFlow - identity, data layer and queue engine

   Agents sign in with a username and password that an admin created
   for them. The database rules are the real gate: you may only write
   your OWN break, admins may write anyone's.

   Two backends behind one API:
     firebase : shared live state, real sign-in, rules enforced
     local    : localStorage demo, no sign-in, one browser only
   ============================================================ */

import { FIREBASE_CONFIG, DB_ROOT, DEFAULTS, LOGIN_DOMAIN } from "./config.js";

/* ------------------------------------------------------------------
   Usernames. Firebase Auth only speaks email, so a bare username is
   mapped onto a synthetic address. Anything with an "@" is a real
   address and passes through untouched (so reset emails can work).
   ------------------------------------------------------------------ */
export function loginEmail(username) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return "";
  return u.includes("@") ? u : u + "@" + LOGIN_DOMAIN;
}
export function isSyntheticEmail(email) {
  return String(email || "").toLowerCase().endsWith("@" + LOGIN_DOMAIN);
}
/** What to show a human: the username, or the real address. */
export function displayLogin(emailOrAgent) {
  const email = typeof emailOrAgent === "string"
    ? emailOrAgent
    : (emailOrAgent && emailOrAgent.email) || "";
  return isSyntheticEmail(email) ? email.split("@")[0] : email;
}

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const LS_CFG = "breakflow.fbconfig";
const LS_DATA = "breakflow.localdb";
const LS_DEMO = "breakflow.demo";

export const STATES = {
  QUEUED: "queued", ACTIVE: "active", OVER: "over",
  DONE: "done", CANCELLED: "cancelled", DENIED: "denied"
};
const CLOSED = [STATES.DONE, STATES.CANCELLED, STATES.DENIED];
const OPEN = [STATES.QUEUED, STATES.ACTIVE, STATES.OVER];

/* ------------------------------------------------------------------
   Admins are decided by EMAIL, held in /admins as { emailKey: true }.
   Nothing about an agent's own record can make them an admin, so there
   is no promotion path to abuse - the same check runs in the rules.
   ------------------------------------------------------------------ */
export function emailKey(email) {
  return String(email || "").trim().toLowerCase().replace(/\./g, ",");
}
export function isAdminEmail(state, email) {
  if (!email) return false;
  return (state.admins || {})[emailKey(email)] === true;
}
export function isAdminAgent(state, agent) {
  return !!agent && isAdminEmail(state, agent.email);
}
export function adminEmails(state) {
  return Object.keys(state.admins || {})
    .filter((k) => state.admins[k] === true)
    .map((k) => k.replace(/,/g, "."))
    .sort();
}

/** Hard ceiling on any single break, in minutes. */
export const MAX_BREAK_MINUTES = 60;

/** An agent must have checked in this recently to be handed a slot. */
export const PRESENCE_TIMEOUT_MS = 90000;
const HEARTBEAT_MS = 25000;

export function clampMinutes(v, fallback) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return Math.min(MAX_BREAK_MINUTES, Number(fallback) || 1);
  return Math.min(MAX_BREAK_MINUTES, Math.max(1, Math.round(n)));
}

/* ---------- config resolution --------------------------------------- */
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

/* ---------- event bus ----------------------------------------------- */
function bus() {
  const subs = new Set();
  return {
    on: (f) => { subs.add(f); return () => subs.delete(f); },
    emit: (v) => subs.forEach((f) => { try { f(v); } catch (e) { console.error(e); } })
  };
}

function withDefaults(s) {
  const st = s || {};
  return {
    settings: Object.assign({
      teamName: DEFAULTS.teamName,
      globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
      graceMinutes: DEFAULTS.graceMinutes,
      hasAdmin: false
    }, st.settings || {}),
    admins: st.admins || {},
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
    this.mode = "connecting";      // connecting | firebase | local | error
    this.state = withDefaults(null);
    this.offset = 0;
    this.online = false;
    this.lastError = null;

    /* auth */
    this.user = null;              // { uid, email, name, photo }  (null = signed out)
    this.member = null;            // roster record for this.user, once resolved
    this.access = "unknown";       // unknown | signed-out | ok | no-account | error

    this._changes = bus();
    this._status = bus();
    this._errors = bus();
    this._fb = null;
    this._subscribed = false;
  }

  onChange(fn) {
    const off = this._changes.on(fn);
    if (this._subscribed || this.mode === "local") fn(this.state);
    return off;
  }
  onStatus(fn) { const off = this._status.on(fn); fn(this.statusSnapshot()); return off; }
  onError(fn) { return this._errors.on(fn); }

  statusSnapshot() {
    return {
      mode: this.mode, online: this.online, access: this.access,
      user: this.user, member: this.member
    };
  }
  now() { return Date.now() + this.offset; }
  isAdmin() { return !!(this.user && isAdminEmail(this.state, this.user.email)); }
  uid() { return this.user ? this.user.uid : null; }

  _emit() { this._changes.emit(this.state); }
  _pushStatus() { this._status.emit(this.statusSnapshot()); }
  _fail(err, what) {
    this.lastError = err;
    const denied = /permission|PERMISSION_DENIED/i.test(err && (err.message || err.code) || "");
    this._errors.emit({ error: err, what: what, denied: denied });
    console.warn("BreakFlow write failed:", what, err);
  }

  /* ---------------- connect ---------------- */
  async connect() {
    const cfg = resolveConfig();
    if (!cfg) {
      /* Don't quietly pretend to work. Demo mode is opt-in, and it
         remembers the choice so a reload doesn't kick you out of it. */
      if (localStorage.getItem(LS_DEMO) === "1") { await this._connectLocal(); return this.mode; }
      this.mode = "unconfigured";
      this.access = "unconfigured";
      this._pushStatus();
      return this.mode;
    }
    try {
      await this._connectFirebase(cfg);
    } catch (err) {
      console.error("Firebase connect failed:", err);
      this.lastError = err;
      this.mode = "error";
      this.access = "error";
      this._pushStatus();
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
    const auth = authMod.getAuth(app);
    this._fb = { db, m: dbMod, auth, am: authMod, app };
    this.mode = "firebase";

    /* a redirect sign-in may be completing right now */
    try { await authMod.getRedirectResult(auth); } catch (e) { this._fail(e, "sign-in"); }

    dbMod.onValue(dbMod.ref(db, ".info/serverTimeOffset"), (s) => { this.offset = s.val() || 0; });
    dbMod.onValue(dbMod.ref(db, ".info/connected"), (s) => { this.online = !!s.val(); this._pushStatus(); });

    await new Promise((resolve) => {
      let first = true;
      authMod.onAuthStateChanged(auth, async (u) => {
        this.user = u ? { uid: u.uid, email: u.email || "", name: u.displayName || (u.email || "").split("@")[0], photo: u.photoURL || "" } : null;
        if (!u) {
          this.member = null;
          this.access = "signed-out";
          this._detach();
          this.state = withDefaults(null);
          this._pushStatus();
          this._emit();
        } else {
          await this._afterSignIn();
        }
        if (first) { first = false; resolve(); }
      });
    });
  }

  _detach() {
    if (this._off) { try { this._off(); } catch (e) { /* ignore */ } this._off = null; }
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
    this._subscribed = false;
  }

  /** Subscribe to the board, then make sure this user has a roster record. */
  async _afterSignIn() {
    const { db, m } = this._fb;
    const root = m.ref(db, DB_ROOT);

    await new Promise((resolve) => {
      let settled = false;
      this._off = m.onValue(root, (snap) => {
        this.state = withDefaults(snap.val());
        this._subscribed = true;
        this.member = (this.state.agents || {})[this.user.uid] || null;
        if (this.access !== "no-account") this.access = this.member ? "ok" : this.access;
        this._pushStatus();
        this._emit();
        if (!settled) { settled = true; resolve(); }
      }, (err) => {
        /* rules refused the read: not a member and the roster is locked */
        this._subscribed = false;
        this.access = /permission/i.test(err.message || "") ? "no-account" : "error";
        this.lastError = err;
        this._pushStatus();
        if (!settled) { settled = true; resolve(); }
      });
    });

    if (!this._subscribed) return;
    await this._ensureMembership();
    await this._seedIfEmpty();

    this._heartbeat = setInterval(() => this.touch(), HEARTBEAT_MS);
    this.touch();
  }

  /**
   * Find this user's roster record. Nobody self-enrols: accounts are
   * created by an admin, which writes the record at the same time.
   * The single exception is the very first account on a fresh board.
   */
  async _ensureMembership() {
    const uid = this.user.uid;
    const email = this.user.email || "";

    if (this.state.agents[uid]) {
      this.member = this.state.agents[uid];
      this.access = "ok";
      this._pushStatus();
      return;
    }

    /* Fresh database: this account claims it as the owner. */
    const bootstrap = !Object.keys(this.state.admins || {}).length;
    if (!bootstrap) {
      this.access = "no-account";
      this._pushStatus();
      return;
    }

    const rec = {
      uid: uid,
      name: (this._pendingProfile && this._pendingProfile.name) || displayLogin(email) || "Owner",
      email: email,
      team: "",
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    try {
      await this.update({
        ["agents/" + uid]: rec,
        ["admins/" + emailKey(email)]: true,
        setupDone: true
      }, "set up the board");
      this.member = rec;
      this.access = "ok";
      this.bootstrapped = true;
    } catch (e) {
      this.access = "no-account";
    }
    this._pendingProfile = null;
    this._pushStatus();
  }

  /**
   * First run only: put the default break policies in place.
   * Writes individual keys rather than a whole settings object - a
   * blind overwrite could reset hasAdmin and leave the board claimable.
   */
  async _seedIfEmpty() {
    if (Object.keys(this.state.breakTypes || {}).length) return;
    if (!this.isAdmin()) return;
    await this.update({
      "settings/hasAdmin": true,
      "settings/teamName": this.state.settings.teamName || DEFAULTS.teamName,
      "settings/globalMaxConcurrent": DEFAULTS.globalMaxConcurrent,
      "settings/graceMinutes": DEFAULTS.graceMinutes,
      "settings/createdAt": Date.now(),
      breakTypes: DEFAULTS.breakTypes
    }, "set up the board");
  }

  /** Presence heartbeat: an absent agent is passed over in the queue. */
  async touch() {
    if (!this.user || !this.member) return;
    try { await this.update({ ["agents/" + this.user.uid + "/lastSeen"]: Date.now() }); }
    catch (e) { /* not fatal */ }
  }

  /* ---------------- sign in / out ---------------- */
  async signIn(username, password) {
    if (this.mode === "local") return;
    const { auth, am } = this._fb;
    await am.signInWithEmailAndPassword(auth, loginEmail(username), password);
  }

  /** Has anyone claimed this board yet? Readable before signing in. */
  async setupDone() {
    if (this.mode !== "firebase") return true;
    const { db, m } = this._fb;
    try {
      const snap = await m.get(m.ref(db, DB_ROOT + "/setupDone"));
      return snap.exists() && snap.val() === true;
    } catch (e) {
      /* can't tell - assume set up, so we never show setup to an agent */
      return true;
    }
  }

  /** One-time: create the owner account on a fresh database. */
  async createFirstAdmin(username, name, password) {
    const { auth, am } = this._fb;
    if (await this.setupDone()) throw new Error("This board has already been set up.");
    this._pendingProfile = { name: name };
    await am.createUserWithEmailAndPassword(auth, loginEmail(username), password);
  }

  /**
   * Admin creates an account for someone else.
   *
   * The client SDK's createUser signs you in as the new user, which
   * would kick the admin out of their own session. Doing it on a
   * second app instance keeps auth state separate, so the admin stays
   * exactly where they were.
   */
  async createAccount(opts) {
    if (this.mode !== "firebase") throw new Error("Connect a Firebase database first — the local demo has no accounts.");
    if (!this.isAdmin()) throw new Error("Admins only.");
    const email = loginEmail(opts.username);
    if (!email) throw new Error("A username is required.");
    if (sortedAgents(this.state).some((a) => (a.email || "").toLowerCase() === email)) {
      throw new Error("That username is already taken.");
    }
    const [appMod, authMod] = await Promise.all([
      import(SDK + "/firebase-app.js"),
      import(SDK + "/firebase-auth.js")
    ]);
    const alias = "provision-" + Date.now().toString(36);
    const secondary = appMod.initializeApp(this._fb.app.options, alias);
    const auth2 = authMod.getAuth(secondary);
    try {
      const cred = await authMod.createUserWithEmailAndPassword(auth2, email, opts.password);
      const uid = cred.user.uid;
      const patch = {
        ["agents/" + uid]: {
          uid: uid,
          name: opts.name || displayLogin(email),
          email: email,
          team: opts.team || "",
          createdAt: Date.now(),
          lastSeen: 0
        }
      };
      if (opts.makeAdmin) patch["admins/" + emailKey(email)] = true;
      await this.update(patch, "create the account");
      return { uid: uid, email: email };
    } finally {
      try { await authMod.signOut(auth2); } catch (e) { /* ignore */ }
      try { await appMod.deleteApp(secondary); } catch (e) { /* ignore */ }
    }
  }

  /** Change your own password (you must know the current one). */
  async changeMyPassword(current, next) {
    const { auth, am } = this._fb;
    const u = auth.currentUser;
    if (!u) throw new Error("Not signed in.");
    const cred = am.EmailAuthProvider.credential(u.email, current);
    await am.reauthenticateWithCredential(u, cred);
    await am.updatePassword(u, next);
  }

  /** Only possible for real email addresses, not synthetic usernames. */
  async sendResetEmail(email) {
    if (isSyntheticEmail(email)) throw new Error("That account uses a username, not an email address, so there is nowhere to send a reset link.");
    const { auth, am } = this._fb;
    await am.sendPasswordResetEmail(auth, email);
  }

  async signOut() {
    if (this.mode === "local") return;
    this._detach();
    try { await this._fb.am.signOut(this._fb.auth); } catch (e) { this._fail(e, "sign-out"); }
  }

  /* ---------------- local demo ---------------- */
  startLocalDemo() { localStorage.setItem(LS_DEMO, "1"); location.reload(); }
  exitLocalDemo() {
    localStorage.removeItem(LS_DEMO);
    localStorage.removeItem(LS_DATA);
    location.reload();
  }

  async _connectLocal() {
    this.mode = "local";
    this.online = true;
    this.user = { uid: "local-user", email: "you@breakflow.local", name: "You (local demo)", photo: "" };
    const load = () => {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(LS_DATA) || "null"); } catch (e) { /* ignore */ }
      const demoUser = {
        uid: "local-user", name: "You (local demo)", email: "you@breakflow.local",
        team: "", createdAt: Date.now(), lastSeen: Date.now()
      };
      if (!raw || !raw.breakTypes || !Object.keys(raw.breakTypes).length) {
        raw = {
          settings: {
            teamName: DEFAULTS.teamName, globalMaxConcurrent: DEFAULTS.globalMaxConcurrent,
            graceMinutes: DEFAULTS.graceMinutes, hasAdmin: true
          },
          admins: { [emailKey(demoUser.email)]: true },
          breakTypes: DEFAULTS.breakTypes,
          agents: { "local-user": demoUser },
          sessions: {}
        };
        localStorage.setItem(LS_DATA, JSON.stringify(raw));
      }
      this.state = withDefaults(raw);
      /* keep the demo usable against data saved by an older version */
      let repair = false;
      if (!this.state.agents["local-user"]) { this.state.agents["local-user"] = demoUser; repair = true; }
      if (!this.state.admins[emailKey(demoUser.email)]) {
        this.state.admins[emailKey(demoUser.email)] = true;
        repair = true;
      }
      if (repair) localStorage.setItem(LS_DATA, JSON.stringify(this.state));
      this.member = this.state.agents["local-user"];
      this.access = "ok";
    };
    load();
    addEventListener("storage", (e) => { if (e.key === LS_DATA) { load(); this._emit(); } });
    this._subscribed = true;
    setInterval(() => this.touch(), HEARTBEAT_MS);
    this._emit();
    this._pushStatus();
  }

  _saveLocal() {
    localStorage.setItem(LS_DATA, JSON.stringify(this.state));
    this._emit();
  }

  /* ---------------- writes ---------------- */
  /** patch: { "a/b/c": value }  — value null deletes. Throws on refusal. */
  async update(patch, what) {
    if (this.mode === "firebase") {
      const { db, m } = this._fb;
      try {
        return await m.update(m.ref(db, DB_ROOT), patch);
      } catch (e) {
        this._fail(e, what || "save");
        throw e;
      }
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

/**
 * Purely time-based, so slot maths never depends on someone's browser
 * having written the "over" flag. A break holds its slot until its end
 * time plus the grace period.
 */
export function occupiesSlot(s, g, now) {
  if (!s) return false;
  if (CLOSED.indexOf(s.state) >= 0) return false;
  if (s.state === STATES.QUEUED) return false;
  return now < (s.endsAt || 0) + g;
}

/** Is this break past its end time (regardless of what the flag says)? */
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

export function supervisors(state) {
  return sortedAgents(state).filter((a) => isAdminAgent(state, a));
}

export function isPresent(state, uid, now) {
  const a = (state.agents || {})[uid];
  return !!(a && a.lastSeen && now - a.lastSeen < PRESENCE_TIMEOUT_MS);
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

/* ==================================================================
   Queue engine

   plan() is a pure function of (state, now). Every client computes the
   same answer from the same snapshot, so clients can each write only
   their own session and still agree on who goes next - no shared
   transaction, which is what lets the security rules be strict.
   ================================================================== */

/**
 * Decide which queued sessions should start now.
 * Absent agents (no recent heartbeat) are passed over without losing
 * their place, so a closed laptop can't hold up the floor.
 */
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
  const skipped = [];
  for (const s of queueFor(state)) {
    const bt = types[s.breakTypeId];
    if (!bt) continue;
    if (bt.requiresApproval && !s.approvedBy) continue;
    if (total >= globalMax) break;
    const cap = Number(bt.maxConcurrent === undefined ? 1 : bt.maxConcurrent);
    if ((perType[bt.id] || 0) >= cap) continue;
    if (!isPresent(state, s.agentId, now)) { skipped.push(s); continue; }
    start.push(s);
    perType[bt.id] = (perType[bt.id] || 0) + 1;
    total++;
  }

  /* breaks whose clock has run out but whose flag still says active */
  const expire = listSessions(state).filter((s) => s.state === STATES.ACTIVE && s.endsAt && s.endsAt <= now);

  return { start, expire, skipped };
}

/* A decision must hold for two consecutive ticks before we act on it,
   so a stale snapshot can't hand the same slot to two people. */
let lastDecision = "";

/**
 * Apply the parts of the plan this client is allowed to write:
 * its own session always, everyone's if it is an admin.
 */
export async function reconcile() {
  if (!store._subscribed && store.mode !== "local") return;
  const now = store.now();
  const uid = store.uid();
  const admin = store.isAdmin();
  const p = plan(store.state, now);

  const mine = (s) => s.agentId === uid;
  const startable = p.start.filter((s) => admin || mine(s));
  const expirable = p.expire.filter((s) => admin || mine(s));
  if (!startable.length && !expirable.length) { lastDecision = ""; return; }

  const key = startable.map((s) => s.id).join(",") + "|" + expirable.map((s) => s.id).join(",");
  if (key !== lastDecision) { lastDecision = key; return; }   /* wait one tick */

  const patch = {};
  for (const s of expirable) patch["sessions/" + s.id + "/state"] = STATES.OVER;
  for (const s of startable) {
    const bt = (store.state.breakTypes || {})[s.breakTypeId] || {};
    const mins = clampMinutes(s.minutes || bt.minutes, 10);
    patch["sessions/" + s.id + "/state"] = STATES.ACTIVE;
    patch["sessions/" + s.id + "/startedAt"] = now;
    patch["sessions/" + s.id + "/endsAt"] = now + mins * 60000;
  }
  lastDecision = "";
  try { await store.update(patch, "queue update"); } catch (e) { /* surfaced by store */ }
}

/* ==================================================================
   Actions
   ================================================================== */

export async function requestBreak(agent, bt) {
  const now = store.now();
  const open = listSessions(store.state).filter((s) => s.agentId === agent.uid && OPEN.indexOf(s.state) >= 0);
  if (open.length) throw new Error("You already have a break open.");
  const id = store.newId("sessions");
  await store.update({
    ["sessions/" + id]: {
      agentId: agent.uid, agentName: agent.name, team: agent.team || "",
      breakTypeId: bt.id, breakTypeName: bt.name, minutes: clampMinutes(bt.minutes, 10),
      state: STATES.QUEUED, requestedAt: now, day: dayKey(now)
    }
  }, "request break");
  await reconcile();
  await reconcile();   /* the two-tick guard: a free slot starts immediately */
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
  }, "close break");
  await reconcile();
}

export async function cancelQueued(sessionId, by) {
  await store.update({
    ["sessions/" + sessionId + "/state"]: STATES.CANCELLED,
    ["sessions/" + sessionId + "/endedAt"]: store.now(),
    ["sessions/" + sessionId + "/closedBy"]: by || "agent"
  }, "leave queue");
  await reconcile();
}

export async function denyQueued(sessionId, by, reason) {
  await store.update({
    ["sessions/" + sessionId + "/state"]: STATES.DENIED,
    ["sessions/" + sessionId + "/endedAt"]: store.now(),
    ["sessions/" + sessionId + "/closedBy"]: by || "admin",
    ["sessions/" + sessionId + "/reason"]: reason || ""
  }, "deny request");
  await reconcile();
}

export async function approveQueued(sessionId, by) {
  await store.update({ ["sessions/" + sessionId + "/approvedBy"]: by || "admin" }, "approve request");
  await reconcile();
}

/** Supervisor override: skip the queue and start now. */
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
  }, "start break");
}

/**
 * Extend or shorten a running break, never past MAX_BREAK_MINUTES total.
 * Returns { applied, clamped }.
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
  if (deltaMinutes > 0 && endsAt <= base) return { applied: 0, clamped: true };

  const patch = {
    ["sessions/" + sessionId + "/endsAt"]: endsAt,
    ["sessions/" + sessionId + "/minutes"]: Math.max(1, Math.round((endsAt - startedAt) / 60000)),
    ["sessions/" + sessionId + "/adjusted"]: (s.adjusted || 0) + Math.round((endsAt - base) / 60000)
  };
  if (endsAt > now && s.state === STATES.OVER) patch["sessions/" + sessionId + "/state"] = STATES.ACTIVE;
  await store.update(patch, "adjust break");
  await reconcile();
  return { applied: Math.round((endsAt - base) / 60000), clamped: clamped };
}

/** Supervisor puts someone on break directly, no queue. */
export async function startForAgent(agent, bt, by) {
  const now = store.now();
  const id = store.newId("sessions");
  const mins = clampMinutes(bt.minutes, 10);
  await store.update({
    ["sessions/" + id]: {
      agentId: agent.uid, agentName: agent.name, team: agent.team || "",
      breakTypeId: bt.id, breakTypeName: bt.name, minutes: mins,
      state: STATES.ACTIVE, requestedAt: now, startedAt: now,
      endsAt: now + mins * 60000, day: dayKey(now),
      approvedBy: by || "admin", forced: true
    }
  }, "start break");
  return id;
}

/* ---------- helpers ------------------------------------------------- */
export function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
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

/* ============================================================
   BreakFlow — Firebase wiring

   The whole app's data (accounts, break policies, live sessions) lives
   in one Realtime Database tree, synced to every PC that opens the
   site. Anonymous sign-in is just a ticket to read/write that tree -
   it has nothing to do with who an agent is. Identity is still the
   supervisor-created username/password handled entirely in store.js.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getDatabase, ref, onValue, update, runTransaction
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

import { FIREBASE_CONFIG } from "./config.js";

let app = null, auth = null, db = null, rootRef = null, sessionsRef = null;

function configured() {
  return !!(FIREBASE_CONFIG && FIREBASE_CONFIG.databaseURL && FIREBASE_CONFIG.apiKey);
}

/** Anonymous sign-in, so database rules can require auth != null. */
function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const off2 = onAuthStateChanged(auth, (user) => {
      if (user) { off2(); resolve(user); }
    }, (e) => { off2(); reject(e); });
    signInAnonymously(auth).catch((e) => { off2(); reject(e); });
  });
}

/** Resolves once signed in and connected; rejects if Firebase isn't reachable/configured. */
export async function connectFirebase() {
  if (!configured()) throw new Error("Firebase is not configured yet (see assets/js/config.js).");
  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = getDatabase(app);
  rootRef = ref(db, "breakflow");
  sessionsRef = ref(db, "breakflow/sessions");
  await ensureSignedIn();
  return rootRef;
}

/**
 * How far this PC's clock is from the database server's, in ms
 * (server = local + offset). Break times are written by one PC and read
 * by others, so everyone has to measure with the same clock or timers,
 * alerts and slot releases drift apart. Resolves to 0 if it can't be read
 * in time, which is just the old behaviour.
 */
export function readServerOffset(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(0), timeoutMs || 3000);
    try {
      onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
        const v = Number(snap.val());
        finish(isFinite(v) ? v : 0);
        offsetListeners.forEach((f) => f(isFinite(v) ? v : 0));
      }, () => finish(0));
    } catch (e) { finish(0); }
  });
}
const offsetListeners = new Set();
export function onServerOffset(fn) { offsetListeners.add(fn); return () => offsetListeners.delete(fn); }

/** Subscribe to the whole shared tree. Returns an unsubscribe function. */
export function watchRoot(onData, onFail) {
  return onValue(rootRef, (snap) => onData(snap.val()), onFail);
}

/** Multi-path patch write, same shape as the app's own update(patch). */
export function writePatch(patch) {
  return update(rootRef, patch);
}

/**
 * Change the live sessions as one atomic step.
 *
 * `fn(sessions)` edits the latest sessions in place and returns true if it
 * changed anything (false = leave things alone). If another PC wrote first,
 * the database re-runs `fn` on the newer data, so a decision is only ever
 * made against what is really there - two PCs can't both take the last
 * slot, and nobody's stale screen can undo a change somebody else just made.
 */
export function transactSessions(fn) {
  return runTransaction(sessionsRef, (current) => {
    const had = current !== null && current !== undefined;
    const sessions = had ? current : {};
    const changed = fn(sessions);
    if (changed) return sessions;
    /* Returning undefined aborts. But when our cached copy was empty it may
       just be stale, so hand back null: the database compares that with what
       it really holds and re-runs us with the real data if they differ. */
    return had ? undefined : null;
  }, { applyLocally: true });
}

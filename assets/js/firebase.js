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
  getDatabase, ref, onValue, update, off
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

import { FIREBASE_CONFIG } from "./config.js";

let app = null, auth = null, db = null, rootRef = null;

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
  await ensureSignedIn();
  return rootRef;
}

/** Subscribe to the whole shared tree. Returns an unsubscribe function. */
export function watchRoot(onData, onFail) {
  return onValue(rootRef, (snap) => onData(snap.val()), onFail);
}

/** Multi-path patch write, same shape as the app's own update(patch). */
export function writePatch(patch) {
  return update(rootRef, patch);
}

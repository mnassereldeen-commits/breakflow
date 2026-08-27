/* ============================================================
   BreakFlow — shipped defaults

   The team's data lives in the Firebase project below, synced to
   every PC that opens the site. These DEFAULTS are only used the
   first time ever the database is empty. After that everything is
   editable in the Admin panel.

   `minutes`        : length of the break. Hard capped at 60 (one hour).
   `maxConcurrent`  : how many people may be on THIS break at once.
   `globalMaxConcurrent` : ceiling across every break type combined.
   `kioskTimeoutSec`: sign the current person out after this many
                      seconds of no clicking, so the next agent gets a
                      clean login screen. 0 turns it off.
   ============================================================ */

/* ------------------------------------------------------------------
   Firebase project config, from Project settings -> General -> "Your
   apps" -> the </> web app. This is NOT a secret - it just tells the
   browser which project to talk to. Access is controlled by the
   Realtime Database security rules (see README), not by hiding this.
   ------------------------------------------------------------------ */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCJF_VCtF-xDDbaG0XCIInZAOaV5jdF-PY",
  authDomain: "petra-breaks.firebaseapp.com",
  databaseURL: "https://petra-breaks-default-rtdb.firebaseio.com",
  projectId: "petra-breaks",
  storageBucket: "petra-breaks.firebasestorage.app",
  messagingSenderId: "457293358179",
  appId: "1:457293358179:web:394211df9d67ea16860456"
};

/* ------------------------------------------------------------------
   The owner's admin account, created automatically the first time the
   app runs on a machine - so there is no setup step, just sign in.

   The password is NOT here. Only a random salt and a PBKDF2-SHA256
   digest of it (120,000 rounds), which is what sign-in compares
   against. You cannot read the password back out of these.

   Do treat the digest as public, because this file is: change the
   password from the account menu once you are in, and don't reuse that
   password anywhere else.

   To seed a different owner, sign in, create the account you want in
   Accounts, then copy its salt/hash out of the backup JSON.
   Set to null to get the "create the first admin" setup screen instead.
   ------------------------------------------------------------------ */
export const SEED_ADMIN = {
  name: "Murad Nassereldeen",
  username: "murad",
  team: "",
  salt: "94bd93b9f6aef24a48d6733d7d306d65",
  hash: "a1130cdabc99326aa113499563b7307b0dc0c6c8f59f01bf53e0c3b02c189723"
};

export const DEFAULTS = {
  teamName: "Operations Floor",
  globalMaxConcurrent: 3,
  graceMinutes: 3,
  kioskTimeoutSec: 120,
  breakTypes: {
    bio:   { id: "bio",   name: "Bio Break",  minutes: 5,  maxConcurrent: 2, color: "#38bdf8", icon: "\u{1F6BB}", requiresApproval: false, order: 1 },
    short: { id: "short", name: "Short Break",minutes: 15, maxConcurrent: 2, color: "#a78bfa", icon: "\u{2615}",  requiresApproval: false, order: 2 },
    lunch: { id: "lunch", name: "Lunch",      minutes: 30, maxConcurrent: 1, color: "#fbbf24", icon: "\u{1F374}", requiresApproval: false, order: 3 },
    prayer:{ id: "prayer",name: "Prayer",     minutes: 10, maxConcurrent: 2, color: "#34d399", icon: "\u{1F54C}", requiresApproval: false, order: 4 },
    coach: { id: "coach", name: "Coaching / 1:1", minutes: 20, maxConcurrent: 1, color: "#f472b6", icon: "\u{1F4CB}", requiresApproval: true, order: 5 }
  }
};

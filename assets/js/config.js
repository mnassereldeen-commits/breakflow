/* ============================================================
   BreakFlow — shipped defaults

   There is nothing to configure to get started. The app stores
   everything in the browser it runs in, so put it on one shared
   break-board PC, create the accounts, and go.

   These values are only used the first time the app runs on a
   machine. After that everything is editable in the Admin panel.

   `minutes`        : length of the break. Hard capped at 60 (one hour).
   `maxConcurrent`  : how many people may be on THIS break at once.
   `globalMaxConcurrent` : ceiling across every break type combined.
   `kioskTimeoutSec`: sign the current person out after this many
                      seconds of no clicking, so the next agent gets a
                      clean login screen. 0 turns it off.
   ============================================================ */

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
  salt: "2888423dac0f67ee00256c90af8b3873",
  hash: "19c2c4ac2c788c5de985ddf306bba0736fa2e223a3221ff910e40ea1e8ebf671"
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

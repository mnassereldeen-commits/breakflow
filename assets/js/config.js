/* ============================================================
   BreakFlow — Firebase configuration
   ------------------------------------------------------------
   Paste your Firebase web-app config below and commit the file.
   (Console -> Project settings -> Your apps -> Web app -> Config)

   You can ALSO configure at runtime without a redeploy:
     - Open the app, click "Connect a database", paste the config
     - Or share a link ending in  #cfg=<base64>  (the app makes one
       for you via Admin -> Settings -> Copy team invite link)

   Priority: URL #cfg  >  localStorage  >  this file
   ============================================================ */

export const FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  appId: ""
};

/* Namespace inside the database. Change it to run two independent
   teams (e.g. "floor-a" / "floor-b") off one Firebase project. */
export const DB_ROOT = "breakflow";

/* Shipped defaults — only used the very first time a database is
   opened. After that, everything is editable in the Admin panel.

   `minutes`        : length of the break. Hard capped at 60 (one hour).
   `maxConcurrent`  : how many people may be on THIS break at the same time.
   `globalMaxConcurrent` : ceiling across every break type combined. */
export const DEFAULTS = {
  teamName: "Operations Floor",
  globalMaxConcurrent: 3,       // hard ceiling on people away at once
  graceMinutes: 3,              // overtime keeps the slot this long
  allowSelfEnroll: true,        // open during onboarding, then lock it
  breakTypes: {
    bio:   { id: "bio",   name: "Bio Break",  minutes: 5,  maxConcurrent: 2, color: "#38bdf8", icon: "\u{1F6BB}", requiresApproval: false, order: 1 },
    short: { id: "short", name: "Short Break",minutes: 15, maxConcurrent: 2, color: "#a78bfa", icon: "\u{2615}",  requiresApproval: false, order: 2 },
    lunch: { id: "lunch", name: "Lunch",      minutes: 30, maxConcurrent: 1, color: "#fbbf24", icon: "\u{1F374}", requiresApproval: false, order: 3 },
    prayer:{ id: "prayer",name: "Prayer",     minutes: 10, maxConcurrent: 2, color: "#34d399", icon: "\u{1F54C}", requiresApproval: false, order: 4 },
    coach: { id: "coach", name: "Coaching / 1:1", minutes: 20, maxConcurrent: 1, color: "#f472b6", icon: "\u{1F4CB}", requiresApproval: true, order: 5 }
  },
};

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

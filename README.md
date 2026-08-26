# BreakFlow

**Live break queue, timers and supervisor board for support / contact-centre teams.**

Agents request a break, get a slot or a place in line, and see a big countdown of exactly
how much time is left. Supervisors get a live board, hard limits on how many people can be
away at once, overstay alerts, and CSV reports.

No build step, no server to run — a static site (GitHub Pages) plus a free Firebase
Realtime Database for the shared live state.

---

## What it does

**Agent view — `index.html`**

- Pick your name once; the browser remembers you.
- Break types are configured by the supervisor (Bio, Short break, Lunch, Prayer, Coaching…), each with its own length and number of concurrent slots.
- If a slot is free, the break starts immediately. If not, you **join a queue** and start automatically the second a slot opens — no need to keep asking.
- Big countdown ring with **time remaining**, the exact clock time you're due back, a 1-minute warning, and a sound + browser notification when your turn comes and when time is up.
- Goes red and counts **up** if you overrun, so there's no ambiguity.
- Live side panels: who is on break right now with their remaining time, and who is waiting in line.
- "Your day": breaks taken, total time out, overstays.

**Admin view — `admin.html`** (PIN protected)

- **Live board** — every active break with a progress bar and countdown; one-click *Back*, *+5m*, *−5m*; put someone on break manually, bypassing the queue.
- **How many can go at the same time** — right at the top of the live board: a stepper for the whole floor and one per break type, showing slots in use and who's waiting. Raise a number and the queue promotes people instantly; lower it and nobody's running break is interrupted — the extra slots simply stop being handed out.
- **Queue** — slot pressure per break type, approve / start-now / deny individual requests, or clear the queue.
- **Break policies** — create and edit break types: name, minutes (1–60), how many at once, colour, icon, and whether a supervisor must approve it.
- **Roster** — add **agents** and **admins**, one at a time or by pasting a list (`Name, Team, admin`). Flip anyone between roles with a click. See who's out and how much time each has used today.
- **Signed in as** — pick which admin you are; every approval, denial, override and forced close is recorded against that name.
- **Reports** — per-day, per-agent: breaks taken, total time out, average, overstays, breakdown by type. CSV export for a day or the entire history, plus a print view.
- **Settings** — team name, floor-wide cap on people away at once, overtime grace period, self-enrolment toggle, PIN change, and housekeeping (trim old history, close all open breaks at end of shift).

## How the queue actually works

The rules live in one deterministic, idempotent function (`reconcileMap` in
[`assets/js/store.js`](assets/js/store.js)) that every open browser runs against a
database transaction. There is no server, and no client is "in charge":

1. An active break whose clock has run out becomes **over**.
2. A break occupies a slot while it is **active**, and while it is **over** but still
   inside the *grace period* (default 3 minutes). After the grace period the slot is
   released so one forgetful person can't stall the whole floor — the session stays open
   and flagged until they tap *I'm back* or a supervisor closes it.
3. Queued requests are promoted **oldest request first**, as long as the break type has a
   free slot *and* the floor-wide cap isn't reached. Types marked *requires approval* wait
   for a supervisor instead.

Two independent limits decide who goes: **per break type** ("2 people on Short Break at
once") and **whole floor** ("never more than 3 away, whatever they're on"). The stricter
one wins. Both are steppers on the live board.

No break can ever exceed **60 minutes**. That ceiling is enforced on the break-type
editor, on manual starts, on queue promotion, on supervisor *+5m* extensions, and in the
database rules — so a stale config or a hand-edited record can't get past it.

Clock skew is handled by offsetting every client against Firebase's server time, so a
laptop with the wrong clock can't award itself extra minutes.

---

## Setup

### 1. Create the database (about 3 minutes, free, no card)

1. Go to <https://console.firebase.google.com> → **Add project** (analytics not needed).
2. **Build → Realtime Database → Create database** → pick a region → start in **test mode**.
3. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
4. **Project settings → Your apps → Web (`</>`)** → register an app → copy the
   `firebaseConfig` object.
5. **Realtime Database → Rules** → paste the contents of
   [`firebase-rules.json`](firebase-rules.json) → **Publish**.

### 2. Point the app at it

Either **commit it** — paste the config into `FIREBASE_CONFIG` in
[`assets/js/config.js`](assets/js/config.js) and push — or **do it in the browser** with
no redeploy: open the site, click the connection pill in the header, paste the config,
save. Then use **Admin → Settings → Copy team invite link** to get a
`…/index.html#cfg=…` link that configures everyone else automatically when they open it.

Priority is `#cfg=` in the URL → this browser's saved config → `config.js`.

### 3. First run

Open `admin.html`. The **first PIN you type becomes the admin PIN** (stored as a SHA-256
hash), so claim it before you share the link. Then, under **Roster**, add yourself with
the *Admin* role and add your agents. Once at least one admin exists, the *Admin* link
disappears from the agent view for everyone else.

Roles are about routing, not enforcement: admins share one panel PIN, and the role picks
who sees the link and whose name lands in the audit trail. See *Security, honestly* below.

### Without Firebase

The app still runs — it falls back to `localStorage` and syncs across tabs in one browser.
Fine for a demo, useless for a team, and the header pill will say *This device only*.

---

## Deploying

It's a static site: any host works. For GitHub Pages, push to `main` and set
**Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
The `.nojekyll` file keeps Pages from mangling the `assets/` folder.

Run it locally with any static server:

```bash
python -m http.server 8080
```

Then open <http://localhost:8080>. ES modules need `http://`, so opening `index.html`
straight off the filesystem will not work.

---

## Security, honestly

This is a floor tool, not a payroll system. Everything runs in the browser, so:

- The Firebase config is public by design — that's normal for web apps. The rules file
  restricts writes to signed-in (anonymous) clients and to this app's data shape, which
  keeps crawlers out; it does not stop a determined person who can already load the page.
- The admin PIN gates the *panel*, not the *database*. Treat it as "keeps agents out of
  the settings", not as real access control. The agent/admin role is the same: it decides
  who sees the panel link and whose name is logged, not who *can* reach `admin.html`.
- Store nothing sensitive. Names, break types and timestamps only.

If you need real enforcement, put the same UI behind an authenticated backend (or Firebase
Auth with per-user rules) later — the data layer is deliberately isolated in
`assets/js/store.js`.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Agent view |
| `admin.html` | Supervisor panel |
| `assets/js/store.js` | Data layer (Firebase / localStorage) + queue engine |
| `assets/js/agent.js` | Agent UI |
| `assets/js/admin.js` | Admin UI |
| `assets/js/common.js` | Shared UI helpers (modals, toasts, sound, CSV…) |
| `assets/js/config.js` | Firebase config + shipped defaults |
| `assets/css/app.css` | Design system |
| `firebase-rules.json` | Database security rules |

## Licence

MIT

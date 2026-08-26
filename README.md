# BreakFlow

**Live break queue, timers and supervisor board for support / contact-centre teams.**

Agents sign in with Google, request a break, and get a slot or a place in line — with a big
countdown of exactly how much time is left. Supervisors get a live board, hard limits on how
many people can be away at once, overstay alerts, and CSV reports.

Your break is *yours*: the database rules only let a person create or change their own
break. A colleague cannot start it, extend it, close it, or delete it — and a break that has
already closed can't be rewritten, so an overstay can't be quietly erased.

No build step and no server to run — a static site (GitHub Pages) plus a free Firebase
Realtime Database.

---

## What it does

**Agent view — `index.html`**

- Sign in with Google. No name picker, so there is nobody to impersonate.
- Break types are set by the supervisor (Bio, Short break, Lunch, Prayer, Coaching…), each with its own length and number of concurrent slots.
- If a slot is free the break starts immediately. If not you **join a queue** and start automatically the second a slot opens — no need to keep asking.
- Big countdown ring with **time remaining**, the exact clock time you're due back, a 1-minute warning, and a sound + browser notification when your turn comes and when time is up.
- Goes red and counts **up** if you overrun, so there's no ambiguity.
- Live side panels: who is on break right now with their remaining time, and who is waiting in line.
- "Your day": breaks taken, total time out, overstays.

**Admin view — `admin.html`**

No PIN — you get in because your account has the admin role, and the database agrees.

- **Live board** — every active break with a progress bar and countdown; one-click *Back*, *+5m*, *−5m*; put someone on break manually, bypassing the queue.
- **How many can go at the same time** — a stepper for the whole floor and one per break type, showing slots in use and who's waiting. Raise a number and the queue promotes people instantly; lower it and nobody's running break is interrupted.
- **Queue** — slot pressure per break type, approve / start-now / deny individual requests, or clear the queue.
- **Break policies** — name, minutes (1–60), how many at once, colour, icon, and whether a supervisor must approve it.
- **Roster & access** — everyone who has signed in, flip anyone between agent and admin, and the one switch that matters: **lock the roster** so no new accounts can join.
- **Reports** — per-day, per-agent: breaks taken, total time out, average, overstays, breakdown by type. CSV for a day or all history, plus a print view.
- **Settings** — team name, floor-wide cap, overtime grace, and housekeeping.

Every approval, denial, override and forced close is recorded under the admin's name.

## How the queue works

The rules live in one pure function — `plan()` in
[`assets/js/store.js`](assets/js/store.js) — that every open browser computes from the same
snapshot and therefore agrees on:

1. A break holds its slot from the moment it starts until its end time plus the *grace
   period* (default 3 minutes). This is measured purely from the clock, so slot maths never
   depends on someone's browser having written a status flag.
2. After the grace period the slot is released, so one forgetful person can't stall the
   whole floor — the break stays open and flagged until they tap *I'm back* or a supervisor
   closes it.
3. Queued requests are promoted **oldest request first**, as long as the break type has a
   free slot *and* the floor-wide cap isn't reached. Types marked *requires approval* wait
   for a supervisor instead.
4. Someone whose page has gone quiet (closed laptop, phone asleep) is **passed over**
   without losing their place, so an absent agent can't sit on a slot. They get the next
   opening once their page is back.

Two independent limits decide who goes: **per break type** ("2 on Short Break at once") and
**whole floor** ("never more than 3 away, whatever they're on"). The stricter one wins.

Because `plan()` is deterministic, each browser only ever needs to write **its own** break —
which is exactly what lets the security rules be strict. There is no server and no client
in charge. Clock skew is corrected against Firebase server time, so a laptop with the wrong
clock can't award itself extra minutes.

No break can exceed **60 minutes**, enforced on the policy editor, manual starts, queue
promotion, supervisor *+5m* extensions, and in the database rules.

---

## Setup

### 1. Firebase project (about 5 minutes, free, no card)

1. <https://console.firebase.google.com> → **Add project** (analytics not needed).
2. **Build → Realtime Database → Create database** → pick a region → start in **test mode**.
3. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
   Pick a support email when asked.
4. **Authentication → Settings → Authorized domains → Add domain** → the host you're
   serving from (e.g. `yourname.github.io`). Sign-in fails with
   `auth/unauthorized-domain` until you do this.
5. **Project settings → Your apps → Web (`</>`)** → register an app → copy the
   `firebaseConfig` object.

### 2. Point the app at it

Either **commit it** — paste the config into `FIREBASE_CONFIG` in
[`assets/js/config.js`](assets/js/config.js) and push — or **do it in the browser**: open the
site, click the connection pill in the header, paste, save. Then **Admin → Settings → Copy
team invite link** gives you a `…#cfg=…` link that configures everyone else automatically.

Priority is `#cfg=` in the URL → this browser's saved config → `config.js`.

### 3. Publish the rules

**Realtime Database → Rules** → paste all of
[`firebase-rules.json`](firebase-rules.json) → **Publish**.

Do this before you share the link. Test mode leaves the database open to anyone.

### 4. Claim the board, then lock it

1. **You sign in first, alone.** The first account to sign in becomes the admin — so make
   sure that's you before anyone else opens the link.
2. Share the link. Each agent signs in with their work Google account and appears on your
   roster automatically.
3. When everyone's in: **Admin → Roster & access → Lock the roster.** From then on, a new
   account that opens the link is told to ask a supervisor. Reopen it any time you need to
   add someone.

### 5. Check it actually holds (2 minutes, worth doing)

Sign in as an agent in one browser and start a break. In another browser signed in as a
*different* agent, open the console and try to close the first agent's break:

```js
await BreakFlow.store.update({ "sessions/<their-session-id>/state": "done" })
```

It should fail with `PERMISSION_DENIED`, and the app should show a red
"Not allowed" toast. If it succeeds, the rules from step 3 aren't published.

### Without Firebase

The app still runs — it falls back to `localStorage` with a single local admin user, no
sign-in. Fine for a demo, useless for a team; the header pill says *This device only*.

---

## Deploying

A static site, so any host works. For GitHub Pages, push to `main` and set
**Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**. The `.nojekyll`
file stops Pages mangling the `assets/` folder. Remember to add the Pages hostname to
Firebase's authorized domains (step 1.4).

Run it locally with any static server — ES modules need `http://`, so opening `index.html`
off the filesystem will not work:

```bash
python -m http.server 8080
```

## Security, honestly

What the rules genuinely enforce, once published:

- Only signed-in Google accounts can read anything. Once the roster is locked, only people
  on the roster can.
- You can create and modify **only your own** break, and only while it's still open.
- Nobody but an admin can delete a break record, or touch one that has closed.
- Nobody can promote themselves to admin.
- Break length is capped at 60 minutes at the database level.

What it does *not* do:

- The Firebase config in the page is public. That's normal for web apps and is not a
  secret — the rules are what protect the data.
- Admins are trusted. An admin can edit anyone's break; that's the job. Their name is
  recorded on the action, which is an audit trail, not a restriction.
- While the roster is open, any Google account with the link can join. That's the point of
  locking it. If you want a permanent restriction, add a domain check to the rules — the
  line to copy is in the comment at the top of `firebase-rules.json`.
- This is a floor tool, not a payroll system. Keep it to names, break types and timestamps.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Agent view |
| `admin.html` | Supervisor panel |
| `assets/js/store.js` | Auth, data layer and the queue engine (`plan()`) |
| `assets/js/agent.js` | Agent UI |
| `assets/js/admin.js` | Admin UI |
| `assets/js/common.js` | Shared UI (sign-in, modals, toasts, sound, CSV…) |
| `assets/js/config.js` | Firebase config + shipped defaults |
| `assets/css/app.css` | Design system |
| `firebase-rules.json` | **The actual enforcement.** Publish this. |

## Licence

MIT

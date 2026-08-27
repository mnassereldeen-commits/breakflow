# BreakFlow

**Live break queue, timers and supervisor board for support / contact-centre teams.**

The admin creates a username and password for everyone. Agents sign in, request a break, and
either go straight away or join a queue that promotes them automatically when a slot frees —
with a big countdown of exactly how much time is left. The admin gets a live board, hard
limits on how many people can be away at once, overstay alerts, and CSV reports.

No build step, no accounts to sign up for as an agent. It's a static site (GitHub Pages)
backed by a shared Firebase Realtime Database, so everyone sees the same live board no
matter which PC they sign in from.

## The two links

| Who | Link |
| --- | --- |
| **Agents** | <https://mnassereldeen-commits.github.io/breakflow/> |
| **Supervisors** | <https://mnassereldeen-commits.github.io/breakflow/admin.html> |

Both login pages carry an **Agent / Supervisor** switch, so anyone who opens the wrong one is
a single click from the right one. Nothing breaks if an agent lands on the supervisor page —
they're told it's for admins and pointed back.

---

## Read this first: one shared board, every PC

Accounts, break policies and the live queue all live in **one Firebase project**, synced to
every device that opens the site. That means:

- Anyone with the site links and an account can sign in from **their own PC, laptop, or
  phone** and see the same live board as everyone else.
- Signing out on one machine doesn't sign you out anywhere else — each device tracks its own
  signed-in session locally, same as any normal site.
- **Take backups anyway.** Admin → Settings → Download backup. The data lives in Firebase, not
  in any one browser, but a deleted project or a wiped database is still unrecoverable
  without one.

This needs a one-time setup step a purely static site doesn't: creating the free Firebase
project the data lives in. See **Setup** below.

## What it does

**Agent view — `index.html`**

- Sign in with the username and password the admin gave you.
- Break types are set by the admin (Bio, Short break, Lunch, Prayer, Coaching…), each with its own length and number of concurrent slots.
- If a slot is free the break starts immediately. If not you **join a queue** and start automatically the second a slot opens.
- Big countdown ring with **time remaining**, the exact clock time you're due back, a 1-minute warning, and a sound + notification when your turn comes and when time is up.
- Goes red and counts **up** if you overrun.
- Live panels: who's on break now with their remaining time, and who's waiting in line.
- "Your day": breaks taken, total time out, overstays.
- Change your own password from the account menu.

**Admin panel — `admin.html`**

- **Live board** — every active break with a progress bar and countdown; one-click *Back*, *+5m*, *−5m*; put someone on break manually, bypassing the queue.
- **How many can go at the same time** — a stepper for the whole floor and one per break type. Raise a number and the queue promotes people instantly; lower it and nobody's running break is interrupted.
- **Queue** — slot pressure per break type, approve / start-now / deny, or clear the queue.
- **Break policies** — name, minutes (1–60), how many at once, colour, icon, whether it needs approval.
- **Accounts** — create agents and admins, edit them, flip anyone between roles, and **set a new password for anybody** when they forget theirs.
- **Reports** — per-day, per-agent: breaks taken, total time out, average, overstays, breakdown by type. CSV for a day or all history, plus a print view.
- **Settings** — team name, floor cap, overtime grace, backup/restore, housekeeping.

Every approval, denial, override and forced close is recorded under the admin's name.

## Setup

### 1. Create the Firebase project (one time only)

The site needs somewhere to keep the shared data. This takes about five minutes and is free
for a team this size.

1. Go to the [Firebase console](https://console.firebase.google.com/), **Add project**, give
   it any name.
2. On the project overview page, click the **`</>`** (web app) icon → register an app (any
   nickname) → it shows you a `firebaseConfig` object. Keep that page open.
3. **Build → Authentication → Get started → Sign-in method** → enable **Anonymous** → Save.
   This is *not* how agents sign in — it just lets the site connect to the database at all.
   Nobody on the team needs a Google account or ever sees this.
4. **Build → Realtime Database → Create Database** → pick a region → start in **locked mode**.
5. Still on the Realtime Database page, open the **Rules** tab, replace the contents with:

   ```json
   {
     "rules": {
       "breakflow": {
         ".read": "auth != null",
         ".write": "auth != null"
       }
     }
   }
   ```

   → **Publish**. This lets anyone who has loaded the site (and so is anonymously signed in)
   read and write the shared data — the same "floor tool, not a bank vault" trust level the
   rest of this README already describes for passwords.
6. Paste the `firebaseConfig` values from step 2 into `FIREBASE_CONFIG` in
   [`assets/js/config.js`](assets/js/config.js), commit, and push. `FIREBASE_CONFIG` is not a
   secret — it just names which project to talk to; the Rules above are what actually control
   access.

### 2. Set up the team

The owner's admin account already exists — username **`murad`** — so there is no "create the
first admin" screen once the database above is in place.

1. Open the **supervisor link** on any PC and sign in as `murad`.
2. **Change the password straight away.** A banner at the top of the panel nags you until you
   do, because the starter password ships with the site and anyone reading the code could
   work it out.
3. **Accounts → ＋ Add agent** for each person. A password is suggested; you're shown their
   username and password once with a **Copy both** button. Hand them over — each person signs
   in from wherever they normally work.
4. Tune **Break policies** and the **floor cap** if the defaults don't fit.
5. Take a backup from Settings.

### How the seeded account works

[`assets/js/config.js`](assets/js/config.js) holds `SEED_ADMIN`: a name, a username, and a
random salt plus a PBKDF2-SHA256 digest (120,000 rounds) of the starter password. **The
password itself is not in the repo** and can't be read back out of the digest — but treat the
digest as public, since the repo is. Changing the password replaces both values in that
browser and clears the warning banner.

To seed a different owner: sign in, create the account you want on the Accounts tab, download
a backup, and copy that account's `salt` and `hash` into `SEED_ADMIN`. Set it to `null` to get
a "create the first admin" setup screen instead.

### Staying signed in

Signing in keeps you signed in on that browser until you sign out yourself, or close the
browser (or that tab) - there's no idle timeout or "kiosk mode." Each device tracks its own
session independently, so signing out on one PC doesn't touch anyone else's.

## How the queue works

`plan()` in [`assets/js/store.js`](assets/js/store.js) decides everything:

1. A break holds its slot from the moment it starts until its end time plus the *grace
   period* (default 3 minutes), measured purely from the clock.
2. After the grace period the slot is released, so one forgetful person can't stall the whole
   floor — the break stays open and flagged until they tap *I'm back* or an admin closes it.
3. Queued requests are promoted **oldest request first**, as long as the break type has a free
   slot *and* the floor-wide cap isn't reached. Types marked *requires approval* wait for an
   admin instead.

Two independent limits decide who goes: **per break type** ("2 on Short Break at once") and
**whole floor** ("never more than 3 away, whatever they're on"). The stricter one wins.

No break can exceed **60 minutes** — enforced on the policy editor, on manual starts, on queue
promotion, and on *+5m* extensions (a 58-minute break takes +2 and then refuses).

## Passwords, honestly

Passwords are **not** stored. Each account keeps a random salt and a PBKDF2-SHA256 hash
(120,000 rounds) computed by the browser's own crypto — no libraries. Signing in re-derives
the hash and compares. There is no plaintext password anywhere in storage.

What that does and doesn't buy you:

- **Does:** stop agents acting as each other. You need someone's password to start, extend or
  close their break, and every action carries a name.
- **Doesn't:** stand up to a determined attacker. The Realtime Database rules only check that
  a request is anonymously signed in, not which account it claims to be — so anyone with
  developer tools and the (public) Firebase config could read or write the database directly,
  the same way anyone with developer tools could edit localStorage in the single-PC version.
- The admin panel is a UI gate on the account's role, not enforced by anything deeper.

Treat it as a floor tool. Keep it to names, break types and timestamps.

## Backups

Settings → **Download backup** gives you a JSON file with accounts, break policies and full
history. **Restore from backup** replaces everything on the shared board — every PC, not just
the one doing the restore — with a file's contents (it signs you out afterwards, and restored
passwords keep working).

This is also how you'd move to a new Firebase project: back up on the old one, restore on the
new one after pointing `FIREBASE_CONFIG` at it.

## Running it elsewhere

It's a static site — any host works, or a folder on the PC, as long as `assets/js/config.js`
points at your Firebase project. Locally you need `http://` because it uses ES modules, so
serve it rather than opening the file:

```bash
python -m http.server 8080
```

For GitHub Pages: push to `main`, then **Settings → Pages → Deploy from a branch → `main` /
`/ (root)`**. The `.nojekyll` file stops Pages mangling `assets/`.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Agent view |
| `admin.html` | Supervisor panel |
| `assets/js/store.js` | Accounts, passwords, the shared database and the queue engine |
| `assets/js/firebase.js` | Firebase connection (anonymous sign-in, database read/write) |
| `assets/js/agent.js` | Agent UI |
| `assets/js/admin.js` | Admin UI |
| `assets/js/common.js` | Shared UI (sign-in, modals, toasts, sound, CSV…) |
| `assets/js/config.js` | Firebase project config + shipped defaults for a fresh database |
| `assets/css/app.css` | Design system |

## Licence

MIT

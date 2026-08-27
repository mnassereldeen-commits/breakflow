# BreakFlow

**Live break queue, timers and supervisor board for support / contact-centre teams.**

The admin creates a username and password for everyone. Agents sign in, request a break, and
either go straight away or join a queue that promotes them automatically when a slot frees —
with a big countdown of exactly how much time is left. The admin gets a live board, hard
limits on how many people can be away at once, overstay alerts, and CSV reports.

No build step, no server, no accounts to sign up for, nothing to configure. It's a static
site plus the browser's own storage.

## The two links

| Who | Link |
| --- | --- |
| **Agents** | <https://mnassereldeen-commits.github.io/breakflow/> |
| **Supervisors** | <https://mnassereldeen-commits.github.io/breakflow/admin.html> |

Both login pages carry an **Agent / Supervisor** switch, so anyone who opens the wrong one is
a single click from the right one. Nothing breaks if an agent lands on the supervisor page —
they're told it's for admins and pointed back.

---

## Read this first: it's one computer

Everything BreakFlow stores lives in **the browser it runs in**. There is no server behind
it, because GitHub Pages only serves files.

That means:

- Set it up on **the PC the team will actually use** — a break-board machine on the floor, a
  shared terminal, a wall display. Everyone signs in on that machine.
- An agent opening the site on their own laptop or phone gets a **completely separate, empty**
  app with its own accounts. They won't see the team's board.
- **Take backups.** Admin → Settings → Download backup. If someone clears that browser's site
  data, or the PC is replaced, everything is gone.

If you later want agents on their own devices seeing one shared board, that needs a database
behind it — a different build.

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
- **Settings** — team name, floor cap, overtime grace, auto sign-out, backup/restore, housekeeping.

Every approval, denial, override and forced close is recorded under the admin's name.

## Setup

1. Open the site on the break-board PC:
   <https://mnassereldeen-commits.github.io/breakflow/>
2. It asks you to **create your own admin account**. The name and username are pre-filled
   (`Murad` / `murad`) — just choose a password. The first account is always an admin, so you
   can't lock yourself out.

   The password is deliberately *not* in this repo: the repo is public, so anything committed
   here is readable by anyone. Change the pre-filled name in
   [`assets/js/config.js`](assets/js/config.js) (`SEED_ADMIN`) if you want a different owner —
   but never put a real password in that file.
3. **Accounts → ＋ Add agent** for each person. A password is suggested; you're shown the
   username and password once with a **Copy both** button. Hand them over.
4. Tune **Break policies** and the **floor cap**, and you're running.
5. **Bookmark the page on that PC** and take a backup from Settings.

Nothing else. No Firebase, no Google, no API keys.

### Auto sign-out (on by default, 120 seconds)

On a shared machine you want the login screen back after each person. BreakFlow signs the
current user out after two minutes without a click, so the next agent gets a clean slate.
Running breaks keep their timers — the agent signs back in to tap *I'm back*.

Change it in **Settings → Auto sign-out**, or set `0` to stay signed in (right for a
single-user desk or a wall display).

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
- **Doesn't:** stand up to someone with developer tools on that PC. With no server, the data
  and the code are both on the machine, so a determined person could edit storage directly.
  Lock the PC down the way you'd lock down any shared terminal.
- The admin panel is a UI gate on the account's role, not enforced by anything deeper.

Treat it as a floor tool. Keep it to names, break types and timestamps.

## Backups

Settings → **Download backup** gives you a JSON file with accounts, break policies and full
history. **Restore from backup** replaces everything on the PC with a file's contents (it
signs you out afterwards, and restored passwords keep working).

This is also how you move to a new machine: back up on the old one, restore on the new one.

## Running it elsewhere

It's a static site — any host works, or a folder on the PC. Locally you need `http://`
because it uses ES modules, so serve it rather than opening the file:

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
| `assets/js/store.js` | Accounts, passwords, storage and the queue engine |
| `assets/js/agent.js` | Agent UI |
| `assets/js/admin.js` | Admin UI |
| `assets/js/common.js` | Shared UI (sign-in, modals, toasts, sound, CSV…) |
| `assets/js/config.js` | Shipped defaults for a fresh install |
| `assets/css/app.css` | Design system |

## Licence

MIT

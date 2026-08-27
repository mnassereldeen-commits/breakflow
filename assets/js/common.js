/* ============================================================
   BreakFlow - shared UI helpers
   ============================================================ */

import { store, ROLES, normUsername } from "./store.js";
/* ---------- DOM ----------------------------------------------------- */
export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export function el(tag, attrs, kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids || [])) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export const esc = (s) => String(s === null || s === undefined ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ---------- time ---------------------------------------------------- */
export function mmss(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return m + ":" + String(s).padStart(2, "0");
}
export function hhmm(ts) {
  if (!ts) return "--:--";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
export function human(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t < 60) return t + "s";
  const m = Math.floor(t / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}
export function relative(ms) {
  const t = Math.abs(ms);
  if (t < 45000) return "just now";
  return human(t) + " ago";
}

/* ---------- toast --------------------------------------------------- */
let toastHost = null;
export function toast(msg, kind) {
  if (!toastHost) {
    toastHost = el("div", { class: "toast-host" });
    document.body.append(toastHost);
  }
  const t = el("div", { class: "toast " + (kind || "info"), text: msg });
  toastHost.append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, kind === "error" ? 5200 : 3200);
}

/* ---------- modal --------------------------------------------------- */
export function modal(title, bodyNode, actions) {
  const wrap = el("div", { class: "modal-wrap" });
  const close = () => { wrap.classList.add("out"); setTimeout(() => wrap.remove(), 200); };
  const foot = el("div", { class: "modal-foot" });
  for (const a of actions || []) {
    foot.append(el("button", {
      class: "btn " + (a.kind || "ghost"),
      text: a.label,
      onclick: async () => {
        if (a.onClick) { const r = await a.onClick(close); if (r === false) return; }
        if (a.keepOpen !== true) close();
      }
    }));
  }
  const card = el("div", { class: "modal" }, [
    el("div", { class: "modal-head" }, [
      el("h3", { text: title }),
      el("button", { class: "x", html: "&times;", onclick: close })
    ]),
    el("div", { class: "modal-body" }, [bodyNode]),
    foot
  ]);
  wrap.append(card);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add("in"));
  const first = card.querySelector("input,select,textarea,button.primary");
  if (first) setTimeout(() => first.focus(), 60);
  return { close, card };
}

export function confirmBox(title, message, confirmLabel) {
  return new Promise((resolve) => {
    modal(title, el("p", { class: "muted", text: message }), [
      { label: "Cancel", kind: "ghost", onClick: () => resolve(false) },
      { label: confirmLabel || "Confirm", kind: "danger", onClick: () => resolve(true) }
    ]);
  });
}

export function field(label, input, hint) {
  return el("label", { class: "field" }, [
    el("span", { class: "field-label", text: label }),
    input,
    hint ? el("span", { class: "field-hint", text: hint }) : null
  ]);
}
export function input(attrs) { return el("input", Object.assign({ class: "in" }, attrs)); }
export function select(options, value, attrs) {
  const s = el("select", Object.assign({ class: "in" }, attrs));
  for (const o of options) {
    s.append(el("option", { value: o.value, text: o.label, selected: String(o.value) === String(value) }));
  }
  s.value = value;
  return s;
}

/* ---------- sound + notifications ----------------------------------- */
let audioCtx = null;
export function beep(pattern) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const notes = pattern === "up" ? [660, 880, 1100] : pattern === "warn" ? [740, 620] : [880, 660, 880, 660];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.17);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.18);
    });
  } catch (e) { /* audio blocked, fine */ }
}

export async function askNotify() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try { return (await Notification.requestPermission()) === "granted"; } catch (e) { return false; }
}
export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body: body, icon: FAVICON, tag: "breakflow" });
    }
  } catch (e) { /* ignore */ }
}

export const FAVICON =
  "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>" +
    "<rect width='64' height='64' rx='16' fill='#0b1220'/>" +
    "<circle cx='32' cy='32' r='19' fill='none' stroke='#22d3ee' stroke-width='6' stroke-dasharray='90 30' stroke-linecap='round'/>" +
    "<circle cx='32' cy='32' r='5' fill='#22d3ee'/></svg>");

/* ---------- title flashing ------------------------------------------ */
let flashTimer = null;
let baseTitle = document.title;
export function flashTitle(msg) {
  stopFlash();
  let on = false;
  flashTimer = setInterval(() => {
    document.title = (on = !on) ? msg : baseTitle;
  }, 900);
}
export function stopFlash() {
  if (flashTimer) { clearInterval(flashTimer); flashTimer = null; document.title = baseTitle; }
}
export function setBaseTitle(t) { baseTitle = t; if (!flashTimer) document.title = t; }


/* ---------- clock in the header ------------------------------------ */
export function mountClock(node) {
  const tick = () => {
    node.textContent = new Date(store.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  tick();
  setInterval(tick, 1000);
}


/* ---------- misc ---------------------------------------------------- */
export function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export function hueFrom(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
  return h;
}

export function csv(rows) {
  return rows.map((r) => r.map((c) => {
    const v = c === null || c === undefined ? "" : String(c);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(",")).join("\r\n");
}

export function download(filename, text, mime) {
  const blob = new Blob(["﻿" + text], { type: (mime || "text/csv") + ";charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function setFavicon() {
  let link = document.querySelector("link[rel='icon']");
  if (!link) { link = el("link", { rel: "icon" }); document.head.append(link); }
  link.href = FAVICON;
}

/* ---------- identity chip + sign out -------------------------------- */
export function identityChip(host) {
  host.innerHTML = "";
  const u = store.user;
  if (!u) return;
  host.append(el("button", {
    class: "pill id-chip", title: "Your account",
    onclick: () => accountDialog()
  }, [
    el("span", { class: "av", style: { "--h": hueFrom(u.name) }, text: initials(u.name) }),
    el("span", { text: u.name }),
    u.role === ROLES.ADMIN ? el("span", { class: "badge cy", text: "admin" }) : null
  ]));
  host.append(el("button", {
    class: "pill signout", title: "Sign out so the next person can use this PC",
    onclick: () => store.signOut()
  }, ["Sign out"]));
}

function accountDialog() {
  const u = store.user;
  const nm = input({ value: u.name });
  const tm = input({ value: u.team || "" });
  modal("Your account", el("div", { class: "stack" }, [
    el("p", { class: "small muted" }, ["Signed in as ", el("b", { text: u.username })]),
    field("Display name", nm, "How your name appears on the board"),
    field("Team", tm),
    el("div", {}, [
      el("button", { class: "btn sm", text: "Change my password", onclick: () => changePasswordDialog() })
    ])
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Save", kind: "primary", onClick: async () => {
        try { await store.updateAccount(u.uid, { name: nm.value, team: tm.value }); }
        catch (e) { toast(e.message, "error"); return false; }
        toast("Saved", "ok");
      }
    }
  ]);
}

export function changePasswordDialog() {
  const u = store.user;
  const cur = input({ type: "password", placeholder: "Current password", autocomplete: "current-password" });
  const p1 = input({ type: "password", placeholder: "New password", autocomplete: "new-password" });
  const p2 = input({ type: "password", placeholder: "Repeat new password", autocomplete: "new-password" });
  modal("Change your password", el("div", { class: "stack" }, [
    field("Current password", cur),
    field("New password", p1),
    field("Confirm", p2),
    el("p", { class: "small dim", style: { margin: "0" } },
      ["Forgotten it? An admin can set you a new one from the Accounts tab."])
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Change password", kind: "primary", onClick: async () => {
        if (p1.value !== p2.value) { toast("New passwords do not match.", "error"); return false; }
        try { await store.setPassword(u.uid, p1.value, cur.value); }
        catch (e) { toast(e.message, "error"); return false; }
        toast("Password changed", "ok");
      }
    }
  ]);
}

/* ---------- sign in ------------------------------------------------- */
export function signInGate(teamName) {
  const user = input({ placeholder: "Username", autocapitalize: "none", autocorrect: "off", spellcheck: "false", autocomplete: "username" });
  const pass = input({ type: "password", placeholder: "Password", autocomplete: "current-password" });
  const msg = el("p", { class: "small err", style: { minHeight: "18px", margin: "4px 0 0" } });
  const btn = el("button", { class: "btn lg primary block", text: "Sign in" });

  const go = async () => {
    if (!user.value.trim() || !pass.value) { msg.textContent = "Enter your username and password."; return; }
    btn.disabled = true;
    msg.textContent = "";
    try {
      await store.signIn(user.value.trim(), pass.value);
    } catch (err) {
      msg.textContent = err.message || "Sign-in failed.";
      pass.value = "";
      pass.focus();
    } finally { btn.disabled = false; }
  };
  btn.addEventListener("click", go);
  for (const f of [user, pass]) f.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

  const card = el("div", { class: "card pad-lg", style: { maxWidth: "400px" } }, [
    el("div", { class: "center" }, [
      el("div", { class: "mark big", text: "B" }),
      el("h2", { text: teamName || "BreakFlow" }),
      el("p", { class: "muted small", style: { margin: "8px 0 20px" } },
        ["Sign in to take your break. Only you can start or end your own."])
    ]),
    el("div", { class: "stack", style: { gap: "10px" } }, [user, pass, btn, msg]),
    el("p", { class: "small dim center", style: { marginTop: "16px", marginBottom: "0" } },
      ["Your supervisor gives you your username and password."])
  ]);
  setTimeout(() => user.focus(), 80);
  return el("div", { class: "gate" }, [card]);
}

/* ---------- first run ----------------------------------------------- */
export function setupGate() {
  const name = input({ placeholder: "Your full name" });
  const user = input({ placeholder: "Username, e.g. murad", autocapitalize: "none", spellcheck: "false" });
  const p1 = input({ type: "password", placeholder: "Password" });
  const p2 = input({ type: "password", placeholder: "Repeat password" });
  const msg = el("p", { class: "small err", style: { minHeight: "18px", margin: "0" } });

  const go = async () => {
    msg.textContent = "";
    if (!name.value.trim()) { msg.textContent = "Enter your name."; return; }
    if (p1.value !== p2.value) { msg.textContent = "Passwords do not match."; return; }
    try {
      const rec = await store.createAccount({
        username: user.value, name: name.value, password: p1.value, role: ROLES.ADMIN
      });
      await store.signIn(rec.username, p1.value);
      toast("Welcome. You are the admin for this board.", "ok");
    } catch (e) { msg.textContent = e.message; }
  };
  for (const f of [name, user, p1, p2]) f.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

  return el("div", { class: "gate" }, [
    el("div", { class: "card pad-lg", style: { maxWidth: "440px" } }, [
      el("div", { class: "center" }, [
        el("div", { class: "mark big", text: "B" }),
        el("h2", { text: "Set up BreakFlow" }),
        el("p", { class: "muted small", style: { margin: "8px 0 18px" } },
          ["Create your own admin account first. You will then create the accounts for everyone else."])
      ]),
      el("div", { class: "stack", style: { gap: "10px" } }, [
        name, user, p1, p2,
        el("button", { class: "btn lg primary block", text: "Create admin account", onclick: go }),
        msg
      ]),
      el("div", { class: "callout", style: { marginTop: "16px" } }, [
        "This is the break board for ", el("b", { text: "this computer" }),
        ". Everything is stored in this browser, so set it up on the PC the team will actually use, and take backups from Settings."
      ])
    ])
  ]);
}

/* ---------- kiosk auto sign-out ------------------------------------- */
export function mountKioskTimer() {
  const bump = () => store.touch();
  for (const ev of ["click", "keydown", "touchstart", "mousemove"]) {
    addEventListener(ev, bump, { passive: true });
  }
  store.touch();
  setInterval(() => {
    const secs = Number(store.state.settings.kioskTimeoutSec || 0);
    if (!secs || !store.user) return;
    if (Date.now() - store.lastActive() > secs * 1000) store.signOut();
  }, 5000);
}

/* ---------- status pill -------------------------------------------- */
export function mountStatusPill(host) {
  const pill = el("button", {
    class: "pill warn", title: "Where the data lives",
    onclick: () => storageDialog()
  }, [el("span", { class: "dot" }), el("span", { class: "lbl", text: "This PC only" })]);
  host.append(pill);
  return pill;
}

export function storageDialog() {
  modal("This PC only", el("div", { class: "stack" }, [
    el("p", {}, ["BreakFlow keeps everything in this browser, on this computer. There is no server and nothing to sign up for."]),
    el("p", { class: "muted small" }, [
      "So the board works for everyone who uses ", el("b", { text: "this machine" }),
      ". An agent opening the site on their own PC or phone gets an empty app with its own separate accounts."
    ]),
    el("p", { class: "muted small" }, [
      "Because there is no server, ", el("b", { text: "take backups" }),
      " from Admin → Settings. Clearing this browser's site data deletes everything."
    ])
  ]), [{ label: "Got it", kind: "primary" }]);
}

/* ---------- error toasts ------------------------------------------- */
export function mountErrorToasts() {
  store.onError(({ what, error }) => {
    toast("Couldn't " + (what || "save") + ": " + ((error && error.message) || "unknown error"), "error");
  });
}

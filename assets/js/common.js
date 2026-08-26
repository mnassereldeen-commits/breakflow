/* ============================================================
   BreakFlow - shared UI helpers
   ============================================================ */

import { store, saveConfig, clearConfig, activeConfig, encodeConfig, ROLES } from "./store.js";

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

/* ---------- crypto -------------------------------------------------- */
export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bf:" + text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- connection pill ---------------------------------------- */
export function mountStatusPill(host) {
  const dot = el("span", { class: "dot" });
  const label = el("span", { class: "lbl" });
  const pill = el("button", { class: "pill", title: "Data connection" }, [dot, label]);
  pill.addEventListener("click", () => setupDialog());
  host.append(pill);
  store.onStatus(({ mode, online }) => {
    pill.classList.remove("ok", "warn", "bad");
    if (mode === "firebase" && online) { pill.classList.add("ok"); label.textContent = "Live"; }
    else if (mode === "firebase") { pill.classList.add("warn"); label.textContent = "Reconnecting"; }
    else if (mode === "local") { pill.classList.add("warn"); label.textContent = "This device only"; }
    else { pill.classList.add("bad"); label.textContent = "Not connected"; }
  });
  return pill;
}

/* ---------- write failures become visible -------------------------- */
export function mountErrorToasts() {
  store.onError(({ what, denied, error }) => {
    if (denied) toast("Not allowed: you can't " + (what || "do that") + ". Only your own break is yours to change.", "error");
    else toast("Couldn't " + (what || "save") + ": " + (error && (error.message || error.code) || "unknown error"), "error");
  });
}

/* ---------- sign-in ------------------------------------------------ */
const GOOGLE_G =
  '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">' +
  '<path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.7-.4-3.9H24v7.4h12.1c-.2 2-1.5 5.1-5 7.1l-.1.3 5.4 4.2.4 0c3.5-3.2 5.3-8 5.3-13.1z"/>' +
  '<path fill="#34A853" d="M24 46c4.8 0 8.8-1.6 11.8-4.3l-5.6-4.4c-1.5 1-3.5 1.8-6.2 1.8-4.7 0-8.7-3.1-10.1-7.4l-.3 0-5.5 4.3-.1.3C10.9 42.1 17 46 24 46z"/>' +
  '<path fill="#FBBC05" d="M13.9 31.7c-.4-1.2-.6-2.4-.6-3.7s.2-2.5.6-3.7l0-.3-5.7-4.4-.2.1C6.8 22.5 6 25.2 6 28s.8 5.5 2 7.9l5.9-4.2z"/>' +
  '<path fill="#EA4335" d="M24 10c3.3 0 5.6 1.4 6.9 2.6l5-4.9C32.7 4.9 28.8 3 24 3 17 3 10.9 6.9 8 12.5l5.9 4.6C15.3 13.1 19.3 10 24 10z"/>' +
  "</svg>";

export function googleButton(label) {
  return el("button", {
    class: "btn lg google", onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { await store.signIn(); }
      catch (err) { toast(signInHelp(err), "error"); }
      finally { b.disabled = false; }
    }
  }, [el("span", { class: "g", html: GOOGLE_G }), label || "Sign in with Google"]);
}

function signInHelp(err) {
  const code = (err && err.code) || "";
  if (/unauthorized-domain/.test(code)) {
    return "This site isn't on Firebase's authorised-domain list yet. Add " + location.hostname +
      " under Authentication → Settings → Authorized domains.";
  }
  if (/operation-not-allowed/.test(code)) {
    return "Google sign-in isn't switched on for this Firebase project yet (Authentication → Sign-in method).";
  }
  return "Sign-in failed: " + (code || (err && err.message) || "unknown error");
}

/** Full-page card shown when nobody is signed in. */
export function signInGate(teamName) {
  return el("div", { class: "gate" }, [
    el("div", { class: "card pad-lg center", style: { maxWidth: "440px" } }, [
      el("div", { class: "mark big", text: "B" }),
      el("h2", { text: teamName ? teamName + " breaks" : "BreakFlow" }),
      el("p", { class: "muted", style: { margin: "8px 0 20px" } },
        ["Sign in so your breaks are yours. Only you can start or end your own break — not a colleague, not by accident."]),
      googleButton(),
      el("p", { class: "small dim", style: { marginTop: "18px" } },
        ["Use your work Google account. This browser will stay signed in."])
    ])
  ]);
}

/** Shown when signed in but the roster is locked and they aren't on it. */
export function notOnRosterGate(user) {
  return el("div", { class: "gate" }, [
    el("div", { class: "card pad-lg center", style: { maxWidth: "460px" } }, [
      el("h2", { text: "You're not on the roster yet" }),
      el("p", { class: "muted", style: { margin: "10px 0 6px" } }, [
        "You're signed in as ", el("b", { text: (user && user.email) || "this account" }),
        ", but a supervisor hasn't added you to this team."
      ]),
      el("p", { class: "small dim", style: { marginBottom: "18px" } },
        ["Ask your supervisor to open the roster for a moment so you can join, or to check you signed in with the right account."]),
      el("div", { class: "btn-row", style: { justifyContent: "center" } }, [
        el("button", { class: "btn", text: "Try again", onclick: () => location.reload() }),
        el("button", { class: "btn ghost", text: "Sign out", onclick: () => store.signOut().then(() => location.reload()) })
      ])
    ])
  ]);
}

/** Header chip: avatar, name, sign out. */
export function identityChip(host, opts) {
  host.innerHTML = "";
  const u = store.user;
  const m = store.member;
  if (!u) return;
  const name = (m && m.name) || u.name || u.email;
  const av = u.photo
    ? el("img", { class: "av img", src: u.photo, alt: "", referrerpolicy: "no-referrer" })
    : el("span", { class: "av", style: { "--h": hueFrom(name) }, text: initials(name) });

  const chip = el("button", { class: "pill id-chip", title: "Your account" }, [
    av,
    el("span", { text: name }),
    m && m.role === ROLES.ADMIN ? el("span", { class: "badge cy", text: "admin" }) : null
  ]);
  chip.addEventListener("click", () => accountDialog(opts));
  host.append(chip);
}

function accountDialog(opts) {
  const u = store.user;
  const m = store.member || {};
  const nm = input({ value: m.name || u.name || "", placeholder: "Display name" });
  const tm = input({ value: m.team || "", placeholder: "Team / shift (optional)" });
  const local = store.mode === "local";

  modal("Your account", el("div", { class: "stack" }, [
    el("p", { class: "small muted" }, [
      local ? "Local demo - no sign-in." : "Signed in as ",
      local ? null : el("b", { text: u.email || u.uid })
    ]),
    field("Display name", nm, "How your name appears on the board"),
    field("Team", tm),
    m.role === ROLES.ADMIN ? el("p", { class: "small" }, [
      el("span", { class: "badge cy", text: "admin" }), " You can open the supervisor panel."
    ]) : null
  ]), [
    local ? null : { label: "Sign out", kind: "ghost", onClick: async () => { await store.signOut(); location.reload(); } },
    { label: "Cancel", kind: "ghost" },
    {
      label: "Save", kind: "primary", onClick: async () => {
        const name = nm.value.trim();
        if (!name) { toast("Name can't be empty", "error"); return false; }
        try {
          await store.update({
            ["agents/" + u.uid + "/name"]: name,
            ["agents/" + u.uid + "/team"]: tm.value.trim()
          }, "change your details");
          toast("Saved", "ok");
        } catch (e) { return false; }
      }
    }
  ].filter(Boolean));
}

/* ---------- clock in the header ------------------------------------ */
export function mountClock(node) {
  const tick = () => {
    node.textContent = new Date(store.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- database setup dialog ----------------------------------- */
export function setupDialog() {
  const current = activeConfig();
  const ta = el("textarea", {
    class: "in mono",
    rows: 9,
    placeholder: '{\n  "apiKey": "...",\n  "authDomain": "...",\n  "databaseURL": "https://xxx.firebaseio.com",\n  "projectId": "...",\n  "appId": "..."\n}'
  });
  if (current) ta.value = JSON.stringify(current, null, 2);

  const body = el("div", { class: "stack" }, [
    el("p", { class: "muted small" }, [
      store.mode === "firebase"
        ? "Connected to a shared Firebase database - everyone sees the same board in real time."
        : "Running on this device only. Paste a Firebase web config to make the board shared across the whole team."
    ]),
    el("details", { class: "howto" }, [
      el("summary", { text: "How do I get this? (about 5 minutes)" }),
      el("ol", { class: "small" }, [
        el("li", { html: "Go to <b>console.firebase.google.com</b> and create a free project." }),
        el("li", { html: "Build &rarr; <b>Realtime Database</b> &rarr; Create database &rarr; start in <b>test mode</b>." }),
        el("li", { html: "Build &rarr; <b>Authentication</b> &rarr; Get started &rarr; Sign-in method &rarr; <b>Google</b> &rarr; Enable." }),
        el("li", { html: "Authentication &rarr; Settings &rarr; <b>Authorized domains</b> &rarr; Add <code>" + esc(location.hostname) + "</code>." }),
        el("li", { html: "Project settings &rarr; Your apps &rarr; <b>Web</b> &rarr; register app &rarr; copy the <code>firebaseConfig</code> object." }),
        el("li", { html: "Paste it here and save." }),
        el("li", { html: "Realtime Database &rarr; <b>Rules</b> &rarr; paste <code>firebase-rules.json</code> &rarr; Publish." })
      ])
    ]),
    field("Firebase web config (JSON)", ta),
    store.lastError ? el("p", { class: "err small", text: "Last error: " + (store.lastError.message || store.lastError) }) : null
  ]);

  const actions = [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Disconnect", kind: "ghost", keepOpen: true, onClick: async () => {
        clearConfig();
        toast("Local config cleared - reloading", "info");
        setTimeout(() => location.reload(), 500);
      }
    },
    {
      label: "Save & reload", kind: "primary", keepOpen: true, onClick: async () => {
        let cfg;
        try { cfg = JSON.parse(ta.value.trim().replace(/^const\s+firebaseConfig\s*=\s*/, "").replace(/;\s*$/, "")); }
        catch (e) { toast("That is not valid JSON. Wrap keys in double quotes.", "error"); return false; }
        if (!cfg.databaseURL) {
          if (cfg.projectId) cfg.databaseURL = "https://" + cfg.projectId + "-default-rtdb.firebaseio.com";
          else { toast("Config needs a databaseURL (enable Realtime Database first).", "error"); return false; }
        }
        saveConfig(cfg);
        toast("Saved. Reconnecting...", "ok");
        setTimeout(() => location.reload(), 500);
      }
    }
  ];
  if (current && current.databaseURL) {
    actions.splice(1, 0, {
      label: "Copy team invite link", kind: "ghost", keepOpen: true, onClick: async () => {
        const link = location.origin + location.pathname.replace(/admin\.html$/, "index.html") + "#cfg=" + encodeConfig(current);
        try { await navigator.clipboard.writeText(link); toast("Invite link copied - send it to the team", "ok"); }
        catch (e) { prompt("Copy this link:", link); }
      }
    });
  }
  return modal("Data connection", body, actions);
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

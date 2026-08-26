/* ============================================================
   BreakFlow - supervisor panel
   ============================================================ */

import {
  store, STATES, ROLES, MAX_BREAK_MINUTES, clampMinutes, reconcileMap, reconcile,
  sortedTypes, sortedAgents, supervisors, occupancy, queueFor, listSessions,
  endBreak, cancelQueued, denyQueued, approveQueued, forceStart, adjustTime,
  startForAgent, dayKey, graceMs, encodeConfig, activeConfig
} from "./store.js";

import {
  $, el, mmss, hhmm, human, toast, modal, confirmBox, field, input, select,
  mountStatusPill, mountClock, setFavicon, initials, hueFrom, sha256,
  csv, download, setupDialog, beep, notify, askNotify
} from "./common.js";

const SESSION_KEY = "breakflow.admin.session";
const LS_ACTOR = "breakflow.admin.actor";

let unlocked = false;
let tab = location.hash.replace("#", "") || "live";
let alerted = {};
let actorId = localStorage.getItem(LS_ACTOR) || "";

/** Name recorded against supervisor actions (approve / deny / close / override). */
function actor() {
  const a = (store.state.agents || {})[actorId];
  return a && a.role === ROLES.ADMIN ? a.name : "admin";
}

const PALETTE = ["#22d3ee", "#a78bfa", "#fbbf24", "#34d399", "#f472b6", "#60a5fa", "#fb923c", "#f87171", "#c084fc", "#4ade80"];
const ICONS = ["☕", "🍴", "🚻", "🕌", "🚬", "📋", "💻", "📞", "🧘", "🩺", "🚶", "🎧"];

/* ==================== boot ==================== */
setFavicon();
mountStatusPill($("#statusHost"));
mountClock($("#clock"));
unlocked = sessionStorage.getItem(SESSION_KEY) === "1";

$("#lockBtn").addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  unlocked = false;
  render();
});

store.connect().then(() => {
  store.onChange(render);
  setInterval(loop, 1000);
  loop();
});

function loop() {
  const state = store.state;
  const now = store.now();
  const probe = reconcileMap(JSON.parse(JSON.stringify(state.sessions || {})), state, now);
  if (probe !== undefined) reconcile();
  if (unlocked) { tickClocks(now); watchOverstays(now); }
}

/* ==================== gate ==================== */
function render() {
  const state = store.state;
  $("#teamName").textContent = (state.settings.teamName || "Team") + " · admin";
  $("#lockBtn").hidden = !unlocked;
  const main = $("#main");
  main.innerHTML = "";
  if (!unlocked) { main.append(pinGate(state)); return; }

  const nav = el("div", { class: "tabs" });
  const TABS = [
    ["live", "Live board"],
    ["queue", "Queue"],
    ["types", "Break policies"],
    ["roster", "Roster"],
    ["reports", "Reports"],
    ["settings", "Settings"]
  ];
  for (const [k, label] of TABS) {
    nav.append(el("button", {
      class: "tab" + (tab === k ? " on" : ""),
      text: label,
      onclick: () => { tab = k; location.hash = k; render(); }
    }));
  }
  main.append(nav);
  main.append(actorBar(state));

  const body = el("div", { class: "stack" });
  const now = store.now();
  if (tab === "live") body.append(liveTab(state, now));
  else if (tab === "queue") body.append(queueTab(state, now));
  else if (tab === "types") body.append(typesTab(state));
  else if (tab === "roster") body.append(rosterTab(state, now));
  else if (tab === "reports") body.append(reportsTab(state, now));
  else body.append(settingsTab(state));
  main.append(body);
  tickClocks(now);
}

/** "Signed in as" strip: names the supervisor behind every override. */
function actorBar(state) {
  const admins = supervisors(state);
  if (!admins.length) {
    return el("div", { class: "actor-bar" }, [
      el("span", { class: "tiny", text: "No admins on the roster" }),
      el("span", { class: "small muted", text: "Add one under Roster so overrides are attributable." }),
      el("div", { class: "spacer" }),
      el("button", { class: "btn sm", text: "Go to Roster", onclick: () => { tab = "roster"; location.hash = "roster"; render(); } })
    ]);
  }
  if (!admins.some((a) => a.id === actorId)) {
    actorId = admins[0].id;
    localStorage.setItem(LS_ACTOR, actorId);
  }
  const sel = select(admins.map((a) => ({ value: a.id, label: a.name })), actorId, {
    style: "width:auto;min-width:180px"
  });
  sel.addEventListener("change", () => {
    actorId = sel.value;
    localStorage.setItem(LS_ACTOR, actorId);
    toast("Acting as " + actor(), "ok");
  });
  return el("div", { class: "actor-bar" }, [
    el("span", { class: "tiny", text: "Signed in as" }),
    sel,
    el("span", { class: "small dim", text: "recorded on every approval, override and forced close" })
  ]);
}

function pinGate(state) {
  const first = !state.settings.adminPinHash;
  const pin = el("input", { class: "in pin-in", type: "password", inputmode: "numeric", maxlength: "8", placeholder: "••••" });
  const msg = el("p", { class: "small err", style: { minHeight: "18px" } });

  const submit = async () => {
    const v = pin.value.trim();
    if (v.length < 4) { msg.textContent = "Use at least 4 digits."; return; }
    const h = await sha256(v);
    if (first) {
      await store.update({ "settings/adminPinHash": h });
      unlock();
      toast("Admin PIN set. Keep it safe.", "ok");
      return;
    }
    if (h === state.settings.adminPinHash) unlock();
    else { msg.textContent = "Wrong PIN."; pin.value = ""; pin.focus(); }
  };
  pin.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  const card = el("div", { class: "card pad-lg" }, [
    el("h2", { text: first ? "Set the admin PIN" : "Supervisor panel" }),
    el("p", { class: "muted small", text: first ? "Nobody has claimed this board yet. Choose a PIN - it is stored hashed, and everyone else will need it." : "Enter the admin PIN to continue." }),
    pin, msg,
    el("button", { class: "btn primary block", onclick: submit, text: first ? "Set PIN & open panel" : "Unlock" }),
    el("p", { class: "small dim", style: { marginTop: "14px" }, text: store.mode === "local" ? "Note: no shared database connected - this panel is showing local data only." : "" })
  ]);
  return el("div", { class: "gate" }, [card]);
}

function unlock() {
  unlocked = true;
  sessionStorage.setItem(SESSION_KEY, "1");
  askNotify();
  render();
}

/* ---------- "how many can go at once" controls ---------- */
function stepper(value, min, max, onChange) {
  const box = el("div", { class: "stepper" }, [
    el("button", { class: "btn sm", text: "−", title: "one fewer", onclick: () => onChange(Math.max(min, value - 1)) }),
    el("b", { text: String(value) }),
    el("button", { class: "btn sm", text: "+", title: "one more", onclick: () => onChange(Math.min(max, value + 1)) })
  ]);
  return box;
}

function concurrencyCard(state, now) {
  const occ = occupancy(state, now);
  const globalMax = Number(state.settings.globalMaxConcurrent || 1);

  const rows = el("div", { class: "conc-list" });
  rows.append(el("div", { class: "conc-row lead" }, [
    el("span", { class: "ico", text: "🏢" }),
    el("div", { class: "who" }, [
      el("b", { text: "Whole floor" }),
      el("span", { text: "hard ceiling across every break type" })
    ]),
    el("span", { class: "badge " + (occ.total >= globalMax ? "warn" : "ok"), text: occ.total + " away now" }),
    stepper(globalMax, 1, 50, async (v) => {
      await store.update({ "settings/globalMaxConcurrent": v });
      await reconcile();
      toast("Floor cap set to " + v, "ok");
    })
  ]));

  for (const bt of sortedTypes(state)) {
    const used = occ.perType[bt.id] || 0;
    const cap = Number(bt.maxConcurrent || 1);
    rows.append(el("div", { class: "conc-row", style: { "--c": bt.color || "#22d3ee" } }, [
      el("span", { class: "ico", text: bt.icon || "☕" }),
      el("div", { class: "who" }, [
        el("b", { text: bt.name }),
        el("span", { text: bt.minutes + " min · " + used + " of " + cap + " slots in use" })
      ]),
      queueFor(state, bt.id).length
        ? el("span", { class: "badge cy", text: queueFor(state, bt.id).length + " waiting" })
        : null,
      stepper(cap, 1, 50, async (v) => {
        await store.update({ ["breakTypes/" + bt.id + "/maxConcurrent"]: v });
        await reconcile();
        toast(bt.name + ": " + v + " at a time", "ok");
      })
    ]));
  }

  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", { text: "How many can go at the same time" }),
      el("span", { class: "tiny", text: "changes apply instantly" })
    ]),
    rows,
    el("p", { class: "small dim", style: { marginTop: "10px" } }, [
      "Raising a number promotes people from the queue immediately. Lowering it never interrupts a break already running - the extra slots simply stop being handed out."
    ])
  ]);
}

/** Extend / shorten a break, explaining the one-hour ceiling if we hit it. */
async function bump(s, delta) {
  const r = await adjustTime(s.id, delta);
  if (r && r.clamped) {
    if (!r.applied) toast(s.agentName + " is already at the " + MAX_BREAK_MINUTES + "-minute maximum.", "error");
    else toast("Capped at " + MAX_BREAK_MINUTES + " minutes - added " + r.applied + "m only.", "info");
  }
}

/* ==================== live board ==================== */
function liveTab(state, now) {
  const occ = occupancy(state, now);
  const globalMax = Number(state.settings.globalMaxConcurrent || 3);
  const g = graceMs(state);
  const live = listSessions(state)
    .filter((s) => s.state === STATES.ACTIVE || (s.state === STATES.OVER && now < (s.endsAt || 0) + g + 3600000))
    .sort((a, b) => (a.endsAt || 0) - (b.endsAt || 0));
  const q = queueFor(state);
  const overs = live.filter((s) => now > (s.endsAt || 0));
  const today = dayKey(now);
  const todays = listSessions(state).filter((s) => s.day === today);

  const grid = el("div", { class: "live-grid" });
  if (!live.length) grid.append(el("p", { class: "empty", text: "Nobody is on break right now." }));

  for (const s of live) {
    const bt = state.breakTypes[s.breakTypeId] || {};
    const over = now > (s.endsAt || 0);
    const remain = (s.endsAt || now) - now;
    const warn = !over && remain <= 60000;
    grid.append(el("div", {
      class: "live-card" + (over ? " over" : warn ? " warn" : ""),
      style: { "--c": bt.color || "#22d3ee" }
    }, [
      el("div", { class: "lc-top" }, [
        el("span", { class: "av", style: { "--h": hueFrom(s.agentName) }, text: initials(s.agentName) }),
        el("div", { style: { minWidth: "0" } }, [
          el("div", { style: { fontWeight: "660" }, text: s.agentName }),
          el("div", { class: "small dim", text: (bt.icon || "") + " " + s.breakTypeName + " · " + hhmm(s.startedAt) + "→" + hhmm(s.endsAt) })
        ]),
        el("span", { class: "lc-time", "data-cd": s.endsAt || 0, text: (over ? "+" : "") + mmss(Math.abs(remain)) })
      ]),
      el("div", { class: "bar" }, [el("i", { "data-bar": "1", "data-endsat": s.endsAt || 0, "data-startedat": s.startedAt || 0 })]),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn sm ok", text: "✓ Back", onclick: () => endBreak(s.id, actor()) }),
        el("button", { class: "btn sm", text: "+5m", onclick: () => bump(s, 5) }),
        el("button", { class: "btn sm", text: "−5m", onclick: () => bump(s, -5) }),
        over ? el("span", { class: "badge bad", text: "OVER" }) : null
      ])
    ]));
  }

  return el("div", { class: "stack" }, [
    el("div", { class: "stats" }, [
      el("div", { class: "stat " + (occ.total >= globalMax ? "warn" : "ok") }, [el("b", { text: occ.total + "/" + globalMax }), el("span", { text: "Away now" })]),
      el("div", { class: "stat" }, [el("b", { text: String(q.length) }), el("span", { text: "In queue" })]),
      el("div", { class: "stat " + (overs.length ? "bad" : "") }, [el("b", { text: String(overs.length) }), el("span", { text: "Over time" })]),
      el("div", { class: "stat" }, [el("b", { text: String(todays.filter((s) => s.startedAt).length) }), el("span", { text: "Breaks today" })]),
      el("div", { class: "stat" }, [el("b", { text: String(sortedAgents(state).length) }), el("span", { text: "Roster" })])
    ]),
    overs.length ? el("div", { class: "callout" }, [
      "⚠ " + overs.map((s) => s.agentName).join(", ") + " " + (overs.length === 1 ? "is" : "are") + " past their break time."
    ]) : null,
    concurrencyCard(state, now),
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "On break now" }),
        el("button", { class: "btn sm primary", text: "＋ Put someone on break", onclick: () => manualStart(state) })
      ]),
      grid
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "Queue" }),
        el("span", { class: "tiny", text: q.length + " waiting" })
      ]),
      queueList(state, now, q)
    ])
  ]);
}

function queueList(state, now, q) {
  if (!q.length) return el("p", { class: "empty", text: "Queue is empty." });
  const box = el("div", { class: "qline" });
  q.forEach((s, i) => {
    const bt = state.breakTypes[s.breakTypeId] || {};
    const needsOk = bt.requiresApproval && !s.approvedBy;
    box.append(el("div", { class: "person-row" }, [
      el("span", { class: "pos", text: String(i + 1) }),
      el("span", { class: "av", style: { "--h": hueFrom(s.agentName) }, text: initials(s.agentName) }),
      el("div", { class: "who" }, [
        el("b", { text: s.agentName }),
        el("span", { text: (bt.icon || "") + " " + s.breakTypeName + " · waiting " + human(now - (s.requestedAt || now)) })
      ]),
      needsOk ? el("span", { class: "badge warn", text: "needs approval" }) : null,
      el("div", { class: "btn-row" }, [
        needsOk ? el("button", { class: "btn sm ok", text: "Approve", onclick: () => approveQueued(s.id, actor()) }) : null,
        el("button", { class: "btn sm", text: "Start now", title: "Skip the queue", onclick: () => forceStart(s.id, actor()) }),
        el("button", {
          class: "btn sm danger", text: "Deny", onclick: async () => {
            const r = await askReason(s.agentName);
            if (r !== null) denyQueued(s.id, actor(), r);
          }
        })
      ])
    ]));
  });
  return box;
}

function askReason(who) {
  return new Promise((resolve) => {
    const inp = input({ placeholder: "Optional reason (agent won't see it)" });
    let done = false;
    modal("Deny " + who + "'s request?", el("div", { class: "stack" }, [
      el("p", { class: "muted small", text: "They'll be removed from the queue and can request again." }),
      field("Reason", inp)
    ]), [
      { label: "Cancel", kind: "ghost", onClick: () => { done = true; resolve(null); } },
      { label: "Deny", kind: "danger", onClick: () => { done = true; resolve(inp.value.trim()); } }
    ]);
    setTimeout(() => { if (!done) { /* closed via X */ } }, 0);
  });
}

function manualStart(state) {
  const agents = sortedAgents(state);
  const types = sortedTypes(state);
  if (!agents.length) { toast("Add someone to the roster first.", "error"); return; }
  if (!types.length) { toast("Create a break policy first.", "error"); return; }
  const aSel = select(agents.map((a) => ({ value: a.id, label: a.name })), agents[0].id);
  const tSel = select(types.map((t) => ({ value: t.id, label: t.name + " (" + t.minutes + "m)" })), types[0].id);
  modal("Put someone on break", el("div", { class: "stack" }, [
    el("p", { class: "muted small", text: "Starts immediately and ignores the queue and slot limits." }),
    field("Agent", aSel), field("Break", tSel)
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Start break", kind: "primary", onClick: async () => {
        const a = state.agents[aSel.value];
        const t = state.breakTypes[tSel.value];
        const open = listSessions(state).some((s) => s.agentId === a.id && [STATES.QUEUED, STATES.ACTIVE, STATES.OVER].includes(s.state));
        if (open) { toast(a.name + " already has an open break.", "error"); return false; }
        await startForAgent(a, t, actor());
        toast(a.name + " is on " + t.name, "ok");
      }
    }
  ]);
}

/* ==================== queue tab ==================== */
function queueTab(state, now) {
  const q = queueFor(state);
  const byType = sortedTypes(state).map((bt) => {
    const occ = occupancy(state, now);
    const used = occ.perType[bt.id] || 0;
    const cap = Number(bt.maxConcurrent || 1);
    const waiting = q.filter((s) => s.breakTypeId === bt.id);
    return el("div", { class: "live-card", style: { "--c": bt.color } }, [
      el("div", { class: "lc-top" }, [
        el("span", { style: { fontSize: "20px" }, text: bt.icon || "☕" }),
        el("div", {}, [
          el("div", { style: { fontWeight: "660" }, text: bt.name }),
          el("div", { class: "small dim", text: used + "/" + cap + " slots used · " + bt.minutes + " min" })
        ]),
        el("span", { class: "lc-time", style: { fontSize: "17px" }, text: waiting.length ? waiting.length + " waiting" : "—" })
      ]),
      waiting.length ? el("div", { class: "small muted", text: waiting.map((s) => s.agentName).join(" · ") }) : null
    ]);
  });

  return el("div", { class: "stack" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Slot pressure by break type" })]),
      el("div", { class: "live-grid" }, byType)
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "Everyone waiting" }),
        q.length ? el("button", {
          class: "btn sm danger", text: "Clear the whole queue", onclick: async () => {
            if (await confirmBox("Clear the queue?", q.length + " pending request(s) will be denied.", "Clear queue")) {
              for (const s of q) await denyQueued(s.id, actor(), "queue cleared");
              toast("Queue cleared", "ok");
            }
          }
        }) : null
      ]),
      queueList(state, now, q)
    ])
  ]);
}

/* ==================== break policies ==================== */
function typesTab(state) {
  const box = el("div", { class: "stack" });
  for (const bt of sortedTypes(state)) box.append(typeEditor(state, bt));
  return el("div", { class: "stack" }, [
    el("div", { class: "callout cy", text: "Slots decide how many people can be on that break at the same time. The floor-wide cap in Settings always wins." }),
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "Break policies" }),
        el("button", { class: "btn sm primary", text: "＋ New break type", onclick: () => newType(state) })
      ]),
      box
    ])
  ]);
}

function typeEditor(state, bt) {
  const nm = input({ value: bt.name });
  const mins = input({ type: "number", min: "1", max: String(MAX_BREAK_MINUTES), value: bt.minutes });
  const cap = input({ type: "number", min: "1", max: "99", value: bt.maxConcurrent });
  const ord = input({ type: "number", min: "1", max: "99", value: bt.order || 1 });
  const appr = el("input", { type: "checkbox", checked: !!bt.requiresApproval });
  let color = bt.color || "#22d3ee";
  let icon = bt.icon || "☕";

  const sw = el("div", { class: "swatches" });
  PALETTE.forEach((c) => {
    const s = el("div", { class: "swatch" + (c === color ? " on" : ""), style: { background: c }, onclick: () => { color = c; sw.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on")); s.classList.add("on"); wrap.style.setProperty("--c", c); } });
    sw.append(s);
  });
  const ic = el("div", { class: "swatches" });
  ICONS.forEach((c) => {
    const s = el("div", { class: "swatch" + (c === icon ? " on" : ""), style: { display: "grid", placeItems: "center", background: "rgba(148,163,184,.14)" }, text: c, onclick: () => { icon = c; ic.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on")); s.classList.add("on"); } });
    ic.append(s);
  });

  const save = async () => {
    const wanted = Number(mins.value);
    const minutes = clampMinutes(wanted, bt.minutes);
    const patch = {};
    patch["breakTypes/" + bt.id] = {
      id: bt.id,
      name: nm.value.trim() || bt.name,
      minutes: minutes,
      maxConcurrent: Math.max(1, Number(cap.value) || 1),
      order: Math.max(1, Number(ord.value) || 1),
      requiresApproval: appr.checked,
      color: color, icon: icon
    };
    await store.update(patch);
    await reconcile();
    if (wanted > MAX_BREAK_MINUTES) {
      mins.value = minutes;
      toast("Breaks cannot exceed " + MAX_BREAK_MINUTES + " minutes - saved as " + minutes + ".", "error");
    } else {
      toast(patch["breakTypes/" + bt.id].name + " saved", "ok");
    }
  };

  const wrap = el("div", { class: "type-edit", style: { "--c": color } }, [
    el("div", { class: "inline-fields" }, [
      field("Name", nm), field("Minutes", mins, "1 – " + MAX_BREAK_MINUTES),
      field("How many at once", cap, "concurrent slots"),
      field("Sort order", ord)
    ]),
    el("div", { class: "inline-fields" }, [
      field("Colour", sw), field("Icon", ic)
    ]),
    el("div", { class: "row wrap" }, [
      el("label", { class: "check" }, [appr, "Requires supervisor approval"]),
      el("div", { class: "spacer" }),
      el("button", { class: "btn sm primary", text: "Save", onclick: save }),
      el("button", {
        class: "btn sm danger", text: "Delete", onclick: async () => {
          if (await confirmBox("Delete " + bt.name + "?", "Existing history keeps the name. Agents can no longer pick it.", "Delete")) {
            await store.update({ ["breakTypes/" + bt.id]: null });
            toast("Deleted", "info");
          }
        }
      })
    ])
  ]);
  return wrap;
}

function newType(state) {
  const nm = input({ placeholder: "e.g. Tea break" });
  const mins = input({ type: "number", value: "15", min: "1", max: String(MAX_BREAK_MINUTES) });
  const cap = input({ type: "number", value: "2", min: "1", max: "50" });
  const appr = el("input", { type: "checkbox" });
  modal("New break type", el("div", { class: "stack" }, [
    field("Name", nm),
    field("Minutes", mins, "1 – " + MAX_BREAK_MINUTES + " (one hour is the maximum)"),
    field("How many can go at the same time", cap, "concurrent slots for this break"),
    el("label", { class: "check" }, [appr, "Requires supervisor approval"])
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Create", kind: "primary", onClick: async () => {
        const name = nm.value.trim();
        if (!name) { toast("Give it a name", "error"); return false; }
        if (Number(mins.value) > MAX_BREAK_MINUTES) {
          toast("Breaks cannot exceed " + MAX_BREAK_MINUTES + " minutes.", "error");
          return false;
        }
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || store.newId("breakTypes");
        if ((state.breakTypes || {})[id]) { toast("A break type with that name already exists.", "error"); return false; }
        const order = Object.keys(state.breakTypes || {}).length + 1;
        await store.update({
          ["breakTypes/" + id]: {
            id: id, name: name,
            minutes: clampMinutes(mins.value, 15),
            maxConcurrent: Math.max(1, Math.min(50, Number(cap.value) || 1)),
            order: order, requiresApproval: appr.checked,
            color: PALETTE[order % PALETTE.length], icon: ICONS[order % ICONS.length]
          }
        });
        await reconcile();
        toast(name + " created", "ok");
      }
    }
  ]);
}

/* ==================== roster ==================== */
function rosterTab(state, now) {
  const agents = sortedAgents(state);
  const today = dayKey(now);
  const rows = el("tbody");

  for (const a of agents) {
    const mine = listSessions(state).filter((s) => s.agentId === a.id && s.day === today);
    const openS = mine.find((s) => [STATES.QUEUED, STATES.ACTIVE, STATES.OVER].includes(s.state));
    const used = mine.filter((s) => s.startedAt).reduce((t, s) => t + Math.max(0, (s.endedAt || now) - s.startedAt), 0);
    rows.append(el("tr", {}, [
      el("td", {}, [el("div", { class: "row" }, [
        el("span", { class: "av", style: { "--h": hueFrom(a.name) }, text: initials(a.name) }),
        el("b", { text: a.name })
      ])]),
      el("td", { class: "muted", text: a.team || "—" }),
      el("td", {}, [
        el("button", {
          class: "badge " + (a.role === ROLES.ADMIN ? "cy" : ""),
          style: { border: "0", cursor: "pointer", font: "inherit", fontSize: "11.5px", fontWeight: "700" },
          title: "Click to switch between agent and admin",
          text: a.role === ROLES.ADMIN ? "⚙ admin" : "agent",
          onclick: async () => {
            const next = a.role === ROLES.ADMIN ? ROLES.AGENT : ROLES.ADMIN;
            if (next === ROLES.AGENT && supervisors(state).length <= 1) {
              toast("Keep at least one admin on the roster.", "error");
              return;
            }
            await store.update({ ["agents/" + a.id + "/role"]: next });
            toast(a.name + " is now " + (next === ROLES.ADMIN ? "an admin" : "an agent"), "ok");
          }
        })
      ]),
      el("td", {}, [
        openS
          ? el("span", { class: "badge " + (openS.state === STATES.QUEUED ? "cy" : openS.state === STATES.OVER ? "bad" : "ok") },
            [openS.state === STATES.QUEUED ? "in queue" : openS.state === STATES.OVER ? "over time" : "on break"])
          : el("span", { class: "badge", text: "available" })
      ]),
      el("td", { class: "num", text: String(mine.filter((s) => s.startedAt).length) }),
      el("td", { class: "num", text: human(used) }),
      el("td", {}, [el("div", { class: "btn-row" }, [
        el("button", { class: "btn sm", text: "Edit", onclick: () => editAgent(a) }),
        el("button", {
          class: "btn sm danger", text: "Remove", onclick: async () => {
            if (await confirmBox("Remove " + a.name + "?", "Their break history stays in reports.", "Remove")) {
              await store.update({ ["agents/" + a.id]: null });
              toast("Removed", "info");
            }
          }
        })
      ])])
    ]));
  }

  const bulk = el("textarea", {
    class: "in", rows: 4,
    placeholder: "One per line:   Name\nor              Name, Team\nor              Name, Team, admin"
  });
  const admins = supervisors(state);

  return el("div", { class: "stack" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "Roster" }),
        el("span", { class: "tiny", text: agents.length + " people · " + admins.length + " admin" + (admins.length === 1 ? "" : "s") }),
        el("button", { class: "btn sm", text: "＋ Add admin", onclick: () => editAgent(null, ROLES.ADMIN) }),
        el("button", { class: "btn sm primary", text: "＋ Add agent", onclick: () => editAgent(null, ROLES.AGENT) })
      ]),
      agents.length ? el("div", { class: "tbl-wrap" }, [
        el("table", { class: "tbl" }, [
          el("thead", {}, [el("tr", {}, [
            el("th", { text: "Name" }), el("th", { text: "Team" }), el("th", { text: "Role" }), el("th", { text: "Status" }),
            el("th", { class: "num", text: "Breaks today" }), el("th", { class: "num", text: "Time out" }), el("th", { text: "" })
          ])]),
          rows
        ])
      ]) : el("p", { class: "empty", text: "Nobody on the roster yet. Add people, or let agents add themselves from the agent view." })
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Bulk add" })]),
      bulk,
      el("div", { style: { height: "10px" } }),
      el("button", {
        class: "btn primary", text: "Add all", onclick: async () => {
          const lines = bulk.value.split("\n").map((l) => l.trim()).filter(Boolean);
          if (!lines.length) return;
          const patch = {};
          let n = 0;
          for (const line of lines) {
            const [name, team, role] = line.split(",").map((x) => (x || "").trim());
            if (!name) continue;
            if (agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
            const id = store.newId("agents");
            patch["agents/" + id] = {
              id: id, name: name, team: team || "",
              role: /^admin|supervisor$/i.test(role || "") ? ROLES.ADMIN : ROLES.AGENT,
              createdAt: store.now()
            };
            n++;
          }
          if (!n) { toast("Nothing new to add", "info"); return; }
          await store.update(patch);
          bulk.value = "";
          toast(n + " added", "ok");
        }
      })
    ])
  ]);
}

function editAgent(a, presetRole) {
  const nm = input({ value: a ? a.name : "", placeholder: "Full name" });
  const tm = input({ value: a ? a.team || "" : "", placeholder: "Team / shift (optional)" });
  const role = select(
    [{ value: ROLES.AGENT, label: "Agent — takes breaks" },
     { value: ROLES.ADMIN, label: "Admin — supervisor panel" }],
    (a && a.role) || presetRole || ROLES.AGENT
  );
  const title = a ? "Edit " + a.name : (presetRole === ROLES.ADMIN ? "Add an admin" : "Add an agent");
  modal(title, el("div", { class: "stack" }, [
    field("Name", nm),
    field("Team", tm),
    field("Role", role, "Admins get the supervisor panel and are named in the audit trail. The panel PIN is shared.")
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: a ? "Save" : "Add", kind: "primary", onClick: async () => {
        const name = nm.value.trim();
        if (!name) { toast("Name required", "error"); return false; }
        const dupe = sortedAgents(store.state).some(
          (x) => x.id !== (a && a.id) && x.name.toLowerCase() === name.toLowerCase()
        );
        if (dupe) { toast("Someone with that name is already on the roster.", "error"); return false; }
        const id = a ? a.id : store.newId("agents");
        await store.update({
          ["agents/" + id]: {
            id: id, name: name, team: tm.value.trim(), role: role.value,
            createdAt: (a && a.createdAt) || store.now()
          }
        });
        toast("Saved", "ok");
      }
    }
  ]);
}

/* ==================== reports ==================== */
function reportsTab(state, now) {
  const days = Array.from(new Set(listSessions(state).map((s) => s.day).filter(Boolean))).sort().reverse();
  const today = dayKey(now);
  if (!days.includes(today)) days.unshift(today);
  const daySel = select(days.map((d) => ({ value: d, label: d === today ? d + " (today)" : d })), reportsTab.day || today);
  const host = el("div", {});

  const paint = () => {
    reportsTab.day = daySel.value;
    host.innerHTML = "";
    host.append(dayReport(state, daySel.value, now));
  };
  daySel.addEventListener("change", paint);
  paint();

  return el("div", { class: "stack" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "Reports" }),
        el("div", { class: "spacer" }),
        el("div", { style: { width: "190px" } }, [daySel]),
        el("button", { class: "btn sm", text: "⭳ CSV (all history)", onclick: () => exportAll(state) })
      ]),
      host
    ])
  ]);
}

function dayReport(state, day, now) {
  const rows = listSessions(state).filter((s) => s.day === day && s.startedAt);
  const byAgent = {};
  for (const s of rows) {
    const k = s.agentId || s.agentName;
    const a = byAgent[k] || (byAgent[k] = { name: s.agentName, count: 0, total: 0, over: 0, overCount: 0, byType: {} });
    const dur = Math.max(0, (s.endedAt || now) - s.startedAt);
    a.count++;
    a.total += dur;
    a.over += s.overBy || 0;
    if ((s.overBy || 0) > 30000) a.overCount++;
    a.byType[s.breakTypeName] = (a.byType[s.breakTypeName] || 0) + 1;
  }
  const list = Object.values(byAgent).sort((a, b) => b.total - a.total);

  const tb = el("tbody");
  for (const a of list) {
    tb.append(el("tr", {}, [
      el("td", {}, [el("div", { class: "row" }, [
        el("span", { class: "av", style: { "--h": hueFrom(a.name) }, text: initials(a.name) }),
        el("b", { text: a.name })
      ])]),
      el("td", { class: "num", text: String(a.count) }),
      el("td", { class: "num", text: human(a.total) }),
      el("td", { class: "num", text: a.count ? human(a.total / a.count) : "—" }),
      el("td", { class: "num" }, [a.overCount ? el("span", { class: "badge bad", text: a.overCount + " · +" + human(a.over) }) : el("span", { class: "dim", text: "—" })]),
      el("td", { class: "muted small", text: Object.entries(a.byType).map(([k, v]) => v + "× " + k).join(", ") })
    ]));
  }

  const denied = listSessions(state).filter((s) => s.day === day && [STATES.DENIED, STATES.CANCELLED].includes(s.state));
  const totalTime = list.reduce((t, a) => t + a.total, 0);
  const totalOver = list.reduce((t, a) => t + a.overCount, 0);

  return el("div", { class: "stack" }, [
    el("div", { class: "stats" }, [
      el("div", { class: "stat" }, [el("b", { text: String(rows.length) }), el("span", { text: "Breaks taken" })]),
      el("div", { class: "stat" }, [el("b", { text: human(totalTime) }), el("span", { text: "Total time out" })]),
      el("div", { class: "stat " + (totalOver ? "bad" : "ok") }, [el("b", { text: String(totalOver) }), el("span", { text: "Overstays" })]),
      el("div", { class: "stat" }, [el("b", { text: String(denied.length) }), el("span", { text: "Cancelled / denied" })]),
      el("div", { class: "stat" }, [el("b", { text: String(list.length) }), el("span", { text: "People" })])
    ]),
    rows.length ? el("div", { class: "tbl-wrap" }, [
      el("table", { class: "tbl" }, [
        el("thead", {}, [el("tr", {}, [
          el("th", { text: "Agent" }), el("th", { class: "num", text: "Breaks" }),
          el("th", { class: "num", text: "Time out" }), el("th", { class: "num", text: "Avg" }),
          el("th", { class: "num", text: "Overstays" }), el("th", { text: "Breakdown" })
        ])]),
        tb
      ])
    ]) : el("p", { class: "empty", text: "No breaks recorded on " + day + "." }),
    el("div", { class: "row wrap" }, [
      el("button", { class: "btn sm", text: "⭳ CSV for " + day, onclick: () => exportDay(state, day, now) }),
      el("button", { class: "btn sm ghost", text: "🖨 Print", onclick: () => window.print() })
    ])
  ]);
}

function sessionRows(state, sessions, now) {
  const head = ["Date", "Agent", "Team", "Break", "State", "Requested", "Started", "Due back", "Ended", "Planned min", "Actual min", "Over min", "Closed by"];
  const body = sessions.sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0)).map((s) => [
    s.day || dayKey(s.requestedAt || now), s.agentName, s.team || "", s.breakTypeName, s.state,
    s.requestedAt ? new Date(s.requestedAt).toLocaleString() : "",
    s.startedAt ? new Date(s.startedAt).toLocaleString() : "",
    s.endsAt ? new Date(s.endsAt).toLocaleString() : "",
    s.endedAt ? new Date(s.endedAt).toLocaleString() : "",
    s.minutes || "",
    s.startedAt ? Math.round(Math.max(0, (s.endedAt || now) - s.startedAt) / 60000) : "",
    s.overBy ? Math.round(s.overBy / 60000) : 0,
    s.closedBy || ""
  ]);
  return [head].concat(body);
}

function exportDay(state, day, now) {
  const rows = listSessions(state).filter((s) => s.day === day);
  download("breakflow-" + day + ".csv", csv(sessionRows(state, rows, now)));
  toast("CSV downloaded", "ok");
}
function exportAll(state) {
  download("breakflow-all-history.csv", csv(sessionRows(state, listSessions(state), store.now())));
  toast("CSV downloaded", "ok");
}

/* ==================== settings ==================== */
function settingsTab(state) {
  const team = input({ value: state.settings.teamName || "" });
  const cap = input({ type: "number", min: "1", max: "99", value: state.settings.globalMaxConcurrent });
  const grace = input({ type: "number", min: "0", max: "60", value: state.settings.graceMinutes });
  const selfEnroll = el("input", { type: "checkbox", checked: state.settings.allowSelfEnroll !== false });

  const pin1 = input({ type: "password", placeholder: "New PIN (4-8 digits)" });
  const pin2 = input({ type: "password", placeholder: "Repeat" });
  const cfg = activeConfig();

  return el("div", { class: "stack" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Floor policy" })]),
      el("div", { class: "inline-fields" }, [
        field("Team name", team),
        field("Max people away at once", cap, "hard ceiling across all break types"),
        field("Overtime grace (minutes)", grace, "how long an overstay keeps blocking its slot")
      ]),
      el("div", { style: { height: "12px" } }),
      el("label", { class: "check" }, [selfEnroll, "Let agents add themselves to the roster"]),
      el("div", { style: { height: "14px" } }),
      el("button", {
        class: "btn primary", text: "Save policy", onclick: async () => {
          await store.update({
            "settings/teamName": team.value.trim() || "Team",
            "settings/globalMaxConcurrent": Math.max(1, Number(cap.value) || 1),
            "settings/graceMinutes": Math.max(0, Number(grace.value) || 0),
            "settings/allowSelfEnroll": selfEnroll.checked
          });
          await reconcile();
          toast("Policy saved", "ok");
        }
      })
    ]),

    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Admin PIN" })]),
      el("div", { class: "inline-fields" }, [field("New PIN", pin1), field("Confirm", pin2)]),
      el("div", { style: { height: "12px" } }),
      el("button", {
        class: "btn", text: "Change PIN", onclick: async () => {
          const a = pin1.value.trim();
          if (a.length < 4) { toast("Use at least 4 digits", "error"); return; }
          if (a !== pin2.value.trim()) { toast("PINs do not match", "error"); return; }
          await store.update({ "settings/adminPinHash": await sha256(a) });
          pin1.value = pin2.value = "";
          toast("PIN changed", "ok");
        }
      })
    ]),

    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Data connection" })]),
      el("p", { class: "muted small" }, [
        store.mode === "firebase"
          ? "Live shared database: " + (cfg && cfg.databaseURL ? cfg.databaseURL : "connected")
          : "No shared database - this browser only. Connect Firebase so the whole team sees one board."
      ]),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn", text: "Configure database", onclick: () => setupDialog() }),
        cfg ? el("button", {
          class: "btn", text: "Copy team invite link", onclick: async () => {
            const link = location.origin + location.pathname.replace(/admin\.html$/, "index.html") + "#cfg=" + encodeConfig(cfg);
            try { await navigator.clipboard.writeText(link); toast("Link copied", "ok"); }
            catch (e) { prompt("Copy this link:", link); }
          }
        }) : null
      ])
    ]),

    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Housekeeping" })]),
      el("p", { class: "muted small", text: "Break history is kept forever so reports stay accurate. Trim it when it gets large." }),
      el("div", { class: "btn-row" }, [
        el("button", {
          class: "btn danger", text: "Delete history older than 30 days", onclick: async () => {
            const cutoff = store.now() - 30 * 86400000;
            const old = listSessions(state).filter((s) => (s.requestedAt || 0) < cutoff);
            if (!old.length) { toast("Nothing older than 30 days", "info"); return; }
            if (!(await confirmBox("Delete " + old.length + " old records?", "This cannot be undone. Export a CSV first if you need it.", "Delete"))) return;
            const patch = {};
            for (const s of old) patch["sessions/" + s.id] = null;
            await store.update(patch);
            toast(old.length + " records deleted", "ok");
          }
        }),
        el("button", {
          class: "btn danger", text: "Close every open break", onclick: async () => {
            const open = listSessions(state).filter((s) => [STATES.ACTIVE, STATES.OVER].includes(s.state));
            if (!open.length) { toast("No open breaks", "info"); return; }
            if (!(await confirmBox("Close " + open.length + " open break(s)?", "Use this at end of shift to reset the board.", "Close all"))) return;
            for (const s of open) await endBreak(s.id, actor() + " (bulk)");
            toast("All breaks closed", "ok");
          }
        })
      ])
    ])
  ]);
}

/* ==================== ticking + alerts ==================== */
function tickClocks(now) {
  for (const n of document.querySelectorAll("[data-cd]")) {
    const d = Number(n.getAttribute("data-cd")) - now;
    n.textContent = (d < 0 ? "+" : "") + mmss(Math.abs(d));
    const card = n.closest(".live-card");
    if (card) {
      card.classList.toggle("over", d < 0);
      card.classList.toggle("warn", d >= 0 && d <= 60000);
    }
  }
  for (const n of document.querySelectorAll("[data-bar]")) {
    const ends = Number(n.getAttribute("data-endsat"));
    const start = Number(n.getAttribute("data-startedat"));
    const total = Math.max(1, ends - start);
    n.style.width = Math.max(0, Math.min(100, ((ends - now) / total) * 100)) + "%";
  }
}

function watchOverstays(now) {
  for (const s of listSessions(store.state)) {
    if (s.state !== STATES.OVER) continue;
    if (alerted[s.id]) continue;
    alerted[s.id] = true;
    beep("warn");
    notify("Overstay: " + s.agentName, s.breakTypeName + " ran out at " + hhmm(s.endsAt) + ".");
  }
}

window.BreakFlow = { store: store, setup: setupDialog };

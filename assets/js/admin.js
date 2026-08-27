/* ============================================================
   BreakFlow - supervisor panel

   You get in because your account's role is admin. There is no
   server, so that is a UI gate, not real security - anyone with
   developer tools on this PC can reach the stored data directly.
   Fine for a floor board; don't treat it as more than that.
   ============================================================ */

import {
  store, STATES, ROLES, MAX_BREAK_MINUTES, clampMinutes, reconcile,
  sortedTypes, sortedAgents, admins, occupancy, queueFor, listSessions,
  onBreakNow, endBreak, denyQueued, approveQueued, forceStart, adjustTime,
  startForAgent, dayKey, isOver, normUsername
} from "./store.js";

import {
  $, el, mmss, hhmm, human, toast, modal, confirmBox, field, input, select,
  mountStatusPill, mountClock, setFavicon, initials, hueFrom,
  csv, download, beep, notify, askNotify, mountErrorToasts, mountKioskTimer,
  signInGate, setupGate, identityChip, storageDialog
} from "./common.js";

let tab = location.hash.replace("#", "") || "live";
const alerted = {};

const PALETTE = ["#22d3ee", "#a78bfa", "#fbbf24", "#34d399", "#f472b6", "#60a5fa", "#fb923c", "#f87171", "#c084fc", "#4ade80"];
const ICONS = ["☕", "🍴", "🚻", "🕌", "🚬", "📋", "💻", "📞", "🧘", "🩺", "🚶", "🎧"];

function actor() { return (store.user && store.user.name) || "admin"; }
function isAdmin() { return store.isAdmin(); }

/* ==================== boot ==================== */
setFavicon();
mountStatusPill($("#statusHost"));
mountClock($("#clock"));
mountErrorToasts();

store.connect().then(() => {
  store.onStatus(render);
  store.onChange(render);
  mountKioskTimer();
  setInterval(loop, 1000);
  loop();
});

function loop() {
  reconcile();
  if (isAdmin()) { tickClocks(store.now()); watchOverstays(store.now()); }
}

/* ==================== gates ==================== */
function render() {
  const state = store.state;
  $("#teamName").textContent = (state.settings.teamName || "Team") + " · admin";
  const main = $("#main");
  main.innerHTML = "";
  identityChip($("#idHost"));

  if (store.access === "setup") { main.append(setupGate()); return; }
  if (store.access !== "ok" || !store.user) { main.append(signInGate(state.settings.teamName, "admin")); return; }
  if (!isAdmin()) { main.append(notAdmin()); return; }

  const nav = el("div", { class: "tabs" });
  const TABS = [
    ["live", "Live board"],
    ["queue", "Queue"],
    ["types", "Break policies"],
    ["accounts", "Accounts"],
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

  const body = el("div", { class: "stack" });
  const now = store.now();
  if (tab === "live") body.append(liveTab(state, now));
  else if (tab === "queue") body.append(queueTab(state, now));
  else if (tab === "types") body.append(typesTab(state));
  else if (tab === "accounts") body.append(accountsTab(state, now));
  else if (tab === "reports") body.append(reportsTab(state, now));
  else body.append(settingsTab(state));
  main.append(body);
  tickClocks(now);
}

function notAdmin() {
  return el("div", { class: "gate" }, [
    el("div", { class: "card pad-lg center", style: { maxWidth: "440px" } }, [
      el("h2", { text: "Supervisors only" }),
      el("p", { class: "muted", style: { margin: "10px 0 18px" } }, [
        "You're signed in as ", el("b", { text: store.user.name }),
        ", an agent account. An admin can switch your role on the Accounts tab."
      ]),
      el("div", { class: "btn-row", style: { justifyContent: "center" } }, [
        el("a", { class: "btn primary", href: "index.html", text: "← Back to my breaks" })
      ])
    ])
  ]);
}

/* ---------- concurrency controls ---------- */
function stepper(value, min, max, onChange) {
  return el("div", { class: "stepper" }, [
    el("button", { class: "btn sm", text: "−", title: "one fewer", onclick: () => onChange(Math.max(min, value - 1)) }),
    el("b", { text: String(value) }),
    el("button", { class: "btn sm", text: "+", title: "one more", onclick: () => onChange(Math.min(max, value + 1)) })
  ]);
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
    stepper(globalMax, 1, 50, (v) => {
      store.update({ "settings/globalMaxConcurrent": v });
      reconcile();
      toast("Floor cap set to " + v, "ok");
    })
  ]));

  for (const bt of sortedTypes(state)) {
    const used = occ.perType[bt.id] || 0;
    const cap = Number(bt.maxConcurrent || 1);
    const waiting = queueFor(state, bt.id).length;
    rows.append(el("div", { class: "conc-row", style: { "--c": bt.color || "#22d3ee" } }, [
      el("span", { class: "ico", text: bt.icon || "☕" }),
      el("div", { class: "who" }, [
        el("b", { text: bt.name }),
        el("span", { text: bt.minutes + " min · " + used + " of " + cap + " slots in use" })
      ]),
      waiting ? el("span", { class: "badge cy", text: waiting + " waiting" }) : null,
      stepper(cap, 1, 50, (v) => {
        store.update({ ["breakTypes/" + bt.id + "/maxConcurrent"]: v });
        reconcile();
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
    el("p", { class: "small dim", style: { marginTop: "10px" } },
      ["Raising a number promotes people from the queue immediately. Lowering it never interrupts a break already running — the extra slots simply stop being handed out."])
  ]);
}

function bump(s, delta) {
  const r = adjustTime(s.id, delta);
  if (r && r.clamped) {
    if (!r.applied) toast(s.agentName + " is already at the " + MAX_BREAK_MINUTES + "-minute maximum.", "error");
    else toast("Capped at " + MAX_BREAK_MINUTES + " minutes — added " + r.applied + "m only.", "info");
  }
}

/* ==================== live board ==================== */
function liveTab(state, now) {
  const occ = occupancy(state, now);
  const globalMax = Number(state.settings.globalMaxConcurrent || 3);
  const live = onBreakNow(state, now);
  const q = queueFor(state);
  const overs = live.filter((s) => isOver(s, now));
  const today = dayKey(now);
  const todays = listSessions(state).filter((s) => s.day === today && s.startedAt);

  const grid = el("div", { class: "live-grid" });
  if (!live.length) grid.append(el("p", { class: "empty", text: "Nobody is on break right now." }));

  for (const s of live) {
    const bt = state.breakTypes[s.breakTypeId] || {};
    const over = isOver(s, now);
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
      el("div", { class: "stat" }, [el("b", { text: String(todays.length) }), el("span", { text: "Breaks today" })]),
      el("div", { class: "stat" }, [el("b", { text: String(sortedAgents(state).length) }), el("span", { text: "Accounts" })])
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
    const inp = input({ placeholder: "Optional note for the record" });
    modal("Deny " + who + "'s request?", el("div", { class: "stack" }, [
      el("p", { class: "muted small", text: "They'll be removed from the queue and can request again." }),
      field("Reason", inp)
    ]), [
      { label: "Cancel", kind: "ghost", onClick: () => resolve(null) },
      { label: "Deny", kind: "danger", onClick: () => resolve(inp.value.trim()) }
    ]);
  });
}

function manualStart(state) {
  const agents = sortedAgents(state);
  const types = sortedTypes(state);
  if (!agents.length) { toast("Create an account first.", "error"); return; }
  if (!types.length) { toast("Create a break policy first.", "error"); return; }
  const aSel = select(agents.map((a) => ({ value: a.uid, label: a.name })), agents[0].uid);
  const tSel = select(types.map((t) => ({ value: t.id, label: t.name + " (" + t.minutes + "m)" })), types[0].id);
  modal("Put someone on break", el("div", { class: "stack" }, [
    el("p", { class: "muted small", text: "Starts immediately and ignores the queue and slot limits." }),
    field("Agent", aSel), field("Break", tSel)
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Start break", kind: "primary", onClick: () => {
        const a = state.agents[aSel.value];
        const t = state.breakTypes[tSel.value];
        const open = listSessions(state).some((s) => s.agentId === a.uid && [STATES.QUEUED, STATES.ACTIVE, STATES.OVER].includes(s.state));
        if (open) { toast(a.name + " already has an open break.", "error"); return false; }
        startForAgent(a, t, actor());
        toast(a.name + " is on " + t.name, "ok");
      }
    }
  ]);
}

/* ==================== queue tab ==================== */
function queueTab(state, now) {
  const q = queueFor(state);
  const occ = occupancy(state, now);
  const byType = sortedTypes(state).map((bt) => {
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
              for (const s of q) denyQueued(s.id, actor(), "queue cleared");
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
    el("div", { class: "callout cy", text: "Slots decide how many people can be on that break at the same time. The floor-wide cap in Settings always wins. No break may be longer than " + MAX_BREAK_MINUTES + " minutes." }),
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
  const cap = input({ type: "number", min: "1", max: "50", value: bt.maxConcurrent });
  const ord = input({ type: "number", min: "1", max: "99", value: bt.order || 1 });
  const appr = el("input", { type: "checkbox", checked: !!bt.requiresApproval });
  let color = bt.color || "#22d3ee";
  let icon = bt.icon || "☕";

  const sw = el("div", { class: "swatches" });
  PALETTE.forEach((c) => {
    const s = el("div", {
      class: "swatch" + (c === color ? " on" : ""), style: { background: c },
      onclick: () => { color = c; sw.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on")); s.classList.add("on"); wrap.style.setProperty("--c", c); }
    });
    sw.append(s);
  });
  const ic = el("div", { class: "swatches" });
  ICONS.forEach((c) => {
    const s = el("div", {
      class: "swatch" + (c === icon ? " on" : ""),
      style: { display: "grid", placeItems: "center", background: "rgba(148,163,184,.14)" }, text: c,
      onclick: () => { icon = c; ic.querySelectorAll(".swatch").forEach((x) => x.classList.remove("on")); s.classList.add("on"); }
    });
    ic.append(s);
  });

  const save = () => {
    const wanted = Number(mins.value);
    const minutes = clampMinutes(wanted, bt.minutes);
    store.update({
      ["breakTypes/" + bt.id]: {
        id: bt.id,
        name: nm.value.trim() || bt.name,
        minutes: minutes,
        maxConcurrent: Math.max(1, Math.min(50, Number(cap.value) || 1)),
        order: Math.max(1, Number(ord.value) || 1),
        requiresApproval: appr.checked,
        color: color, icon: icon
      }
    });
    reconcile();
    if (wanted > MAX_BREAK_MINUTES) {
      mins.value = minutes;
      toast("Breaks cannot exceed " + MAX_BREAK_MINUTES + " minutes — saved as " + minutes + ".", "error");
    } else {
      toast((nm.value.trim() || bt.name) + " saved", "ok");
    }
  };

  const wrap = el("div", { class: "type-edit", style: { "--c": color } }, [
    el("div", { class: "inline-fields" }, [
      field("Name", nm),
      field("Minutes", mins, "1 – " + MAX_BREAK_MINUTES),
      field("How many at once", cap, "concurrent slots"),
      field("Sort order", ord)
    ]),
    el("div", { class: "inline-fields" }, [field("Colour", sw), field("Icon", ic)]),
    el("div", { class: "row wrap" }, [
      el("label", { class: "check" }, [appr, "Requires supervisor approval"]),
      el("div", { class: "spacer" }),
      el("button", { class: "btn sm primary", text: "Save", onclick: save }),
      el("button", {
        class: "btn sm danger", text: "Delete", onclick: async () => {
          if (await confirmBox("Delete " + bt.name + "?", "Existing history keeps the name. Agents can no longer pick it.", "Delete")) {
            store.update({ ["breakTypes/" + bt.id]: null });
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
      label: "Create", kind: "primary", onClick: () => {
        const name = nm.value.trim();
        if (!name) { toast("Give it a name", "error"); return false; }
        if (Number(mins.value) > MAX_BREAK_MINUTES) { toast("Breaks cannot exceed " + MAX_BREAK_MINUTES + " minutes.", "error"); return false; }
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || store.newId();
        if ((state.breakTypes || {})[id]) { toast("A break type with that name already exists.", "error"); return false; }
        const order = Object.keys(state.breakTypes || {}).length + 1;
        store.update({
          ["breakTypes/" + id]: {
            id: id, name: name,
            minutes: clampMinutes(mins.value, 15),
            maxConcurrent: Math.max(1, Math.min(50, Number(cap.value) || 1)),
            order: order, requiresApproval: appr.checked,
            color: PALETTE[order % PALETTE.length], icon: ICONS[order % ICONS.length]
          }
        });
        reconcile();
        toast(name + " created", "ok");
      }
    }
  ]);
}

/* ==================== accounts ==================== */
function accountsTab(state, now) {
  const agents = sortedAgents(state);
  const admin = admins(state);
  const today = dayKey(now);
  const rows = el("tbody");

  for (const a of agents) {
    const mine = listSessions(state).filter((s) => s.agentId === a.uid && s.day === today);
    const openS = mine.find((s) => [STATES.QUEUED, STATES.ACTIVE, STATES.OVER].includes(s.state));
    const used = mine.filter((s) => s.startedAt).reduce((t, s) => t + Math.max(0, (s.endedAt || now) - s.startedAt), 0);
    const isSelf = a.uid === store.uid();
    const lastAdmin = a.role === ROLES.ADMIN && admin.length <= 1;

    rows.append(el("tr", {}, [
      el("td", {}, [el("div", { class: "row" }, [
        el("span", { class: "av", style: { "--h": hueFrom(a.name) }, text: initials(a.name) }),
        el("div", {}, [
          el("b", { text: a.name + (isSelf ? " (you)" : "") }),
          el("div", { class: "tiny", style: { textTransform: "none", letterSpacing: "0" }, text: a.username })
        ])
      ])]),
      el("td", { class: "muted", text: a.team || "—" }),
      el("td", {}, [
        el("button", {
          class: "role-btn badge " + (a.role === ROLES.ADMIN ? "cy" : ""),
          title: lastAdmin ? "Keep at least one admin" : "Switch between agent and admin",
          text: a.role === ROLES.ADMIN ? "⚙ admin" : "agent",
          onclick: async () => {
            const next = a.role === ROLES.ADMIN ? ROLES.AGENT : ROLES.ADMIN;
            if (next === ROLES.AGENT && isSelf &&
              !(await confirmBox("Give up your own admin access?", "You'll lose this panel immediately. Another admin would have to give it back.", "Yes, step down"))) return;
            try { await store.updateAccount(a.uid, { role: next }); }
            catch (e) { toast(e.message, "error"); return; }
            toast(a.name + " is now " + (next === ROLES.ADMIN ? "an admin" : "an agent"), "ok");
          }
        })
      ]),
      el("td", {}, [
        openS
          ? el("span", { class: "badge " + (openS.state === STATES.QUEUED ? "cy" : isOver(openS, now) ? "bad" : "ok") },
            [openS.state === STATES.QUEUED ? "in queue" : isOver(openS, now) ? "over time" : "on break"])
          : el("span", { class: "badge", text: "available" })
      ]),
      el("td", { class: "num", text: String(mine.filter((s) => s.startedAt).length) }),
      el("td", { class: "num", text: human(used) }),
      el("td", {}, [el("div", { class: "btn-row" }, [
        el("button", { class: "btn sm", text: "Edit", onclick: () => editAccount(a) }),
        el("button", { class: "btn sm", text: "Set password", onclick: () => resetPasswordDialog(a) }),
        el("button", {
          class: "btn sm danger", text: "Remove", onclick: async () => {
            if (!(await confirmBox("Remove " + a.name + "?",
              "Their login stops working straight away. Their break history stays in reports.", "Remove"))) return;
            try { await store.deleteAccount(a.uid); toast("Removed", "info"); }
            catch (e) { toast(e.message, "error"); }
          }
        })
      ])])
    ]));
  }

  return el("div", { class: "stack" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", { text: "Accounts" }),
        el("span", { class: "tiny", text: agents.length + " people · " + admin.length + " admin" + (admin.length === 1 ? "" : "s") }),
        el("button", { class: "btn sm", text: "＋ Add admin", onclick: () => newAccount(ROLES.ADMIN) }),
        el("button", { class: "btn sm primary", text: "＋ Add agent", onclick: () => newAccount(ROLES.AGENT) })
      ]),
      el("p", { class: "muted small", style: { marginTop: "-4px" } }, [
        "You create every login here and hand over the username and password. Forgotten a password? Use ",
        el("b", { text: "Set password" }), " — you can set a new one for anybody, no email needed."
      ]),
      agents.length ? el("div", { class: "tbl-wrap" }, [
        el("table", { class: "tbl" }, [
          el("thead", {}, [el("tr", {}, [
            el("th", { text: "Name / username" }), el("th", { text: "Team" }), el("th", { text: "Role" }), el("th", { text: "Status" }),
            el("th", { class: "num", text: "Breaks today" }), el("th", { class: "num", text: "Time out" }), el("th", { text: "" })
          ])]),
          rows
        ])
      ]) : el("p", { class: "empty", text: "No accounts yet." })
    ])
  ]);
}

function suggestPassword() {
  const words = ["tiger", "amber", "river", "cobalt", "maple", "falcon", "cedar", "onyx", "harbor", "quartz"];
  const w = words[Math.floor(Math.random() * words.length)];
  return w + "-" + String(Math.floor(Math.random() * 9000) + 1000);
}

function newAccount(role) {
  const name = input({ placeholder: "Full name" });
  const user = input({ placeholder: "username", autocapitalize: "none", spellcheck: "false" });
  const team = input({ placeholder: "Team / shift (optional)" });
  const pass = input({ type: "text", value: suggestPassword() });

  /* suggest a username from the name, until they type their own */
  let touched = false;
  user.addEventListener("input", () => { touched = true; });
  name.addEventListener("input", () => {
    if (!touched) user.value = normUsername(name.value).slice(0, 20);
  });

  modal(role === ROLES.ADMIN ? "Add an admin" : "Add an agent", el("div", { class: "stack" }, [
    field("Full name", name),
    field("Username", user, "Letters, numbers, dot, dash, underscore. This is what they type to sign in."),
    field("Team", team),
    field("Password", pass, "Write it down and give it to them. You can change it any time from “Set password”."),
    el("div", {}, [el("button", { class: "btn sm", text: "🎲 New password", onclick: () => { pass.value = suggestPassword(); } })]),
    role === ROLES.ADMIN ? el("div", { class: "callout cy" }, ["This account gets the supervisor panel and can create other accounts."]) : null
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: role === ROLES.ADMIN ? "Create admin" : "Create agent", kind: "primary", onClick: async () => {
        if (!name.value.trim()) { toast("Enter their name.", "error"); return false; }
        let rec;
        try {
          rec = await store.createAccount({
            username: user.value, name: name.value, team: team.value, password: pass.value, role: role
          });
        } catch (e) { toast(e.message, "error"); return false; }
        credentialsDialog(rec.name, rec.username, pass.value);
      }
    }
  ]);
}

function credentialsDialog(name, username, password) {
  const text = "BreakFlow login for " + name + "\nUsername: " + username + "\nPassword: " + password;
  modal("Account created", el("div", { class: "stack" }, [
    el("p", { class: "muted small" }, ["Give these to " + name + ". You can always set a new password later."]),
    el("div", { class: "creds" }, [
      el("div", {}, [el("span", { class: "tiny", text: "Username" }), el("b", { text: username })]),
      el("div", {}, [el("span", { class: "tiny", text: "Password" }), el("b", { text: password })])
    ]),
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn sm", text: "Copy both", onclick: async () => {
          try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); }
          catch (e) { prompt("Copy this:", text); }
        }
      })
    ])
  ]), [{ label: "Done", kind: "primary" }]);
}

function resetPasswordDialog(a) {
  const pass = input({ type: "text", value: suggestPassword() });
  modal("Set a password for " + a.name, el("div", { class: "stack" }, [
    el("p", { class: "muted small" }, ["Their old password stops working immediately. Give them the new one."]),
    field("New password", pass),
    el("div", {}, [el("button", { class: "btn sm", text: "🎲 New password", onclick: () => { pass.value = suggestPassword(); } })])
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Set password", kind: "primary", onClick: async () => {
        try { await store.setPassword(a.uid, pass.value); }
        catch (e) { toast(e.message, "error"); return false; }
        credentialsDialog(a.name, a.username, pass.value);
      }
    }
  ]);
}

function editAccount(a) {
  const nm = input({ value: a.name });
  const un = input({ value: a.username, autocapitalize: "none", spellcheck: "false" });
  const tm = input({ value: a.team || "" });
  modal("Edit " + a.name, el("div", { class: "stack" }, [
    field("Full name", nm), field("Username", un), field("Team", tm)
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Save", kind: "primary", onClick: async () => {
        try { await store.updateAccount(a.uid, { name: nm.value, username: un.value, team: tm.value }); }
        catch (e) { toast(e.message, "error"); return false; }
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
  const head = ["Date", "Agent", "Username", "Team", "Break", "State", "Requested", "Started", "Due back", "Ended", "Planned min", "Actual min", "Over min", "Closed by"];
  const body = sessions.sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0)).map((s) => {
    const rec = (state.agents || {})[s.agentId] || {};
    return [
      s.day || dayKey(s.requestedAt || now), s.agentName, rec.username || "", s.team || "", s.breakTypeName, s.state,
      s.requestedAt ? new Date(s.requestedAt).toLocaleString() : "",
      s.startedAt ? new Date(s.startedAt).toLocaleString() : "",
      s.endsAt ? new Date(s.endsAt).toLocaleString() : "",
      s.endedAt ? new Date(s.endedAt).toLocaleString() : "",
      s.minutes || "",
      s.startedAt ? Math.round(Math.max(0, (s.endedAt || now) - s.startedAt) / 60000) : "",
      s.overBy ? Math.round(s.overBy / 60000) : 0,
      s.closedBy || ""
    ];
  });
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
  const cap = input({ type: "number", min: "1", max: "50", value: state.settings.globalMaxConcurrent });
  const grace = input({ type: "number", min: "0", max: "60", value: state.settings.graceMinutes });
  const kiosk = input({ type: "number", min: "0", max: "3600", value: state.settings.kioskTimeoutSec });

  return el("div", { class: "stack" }, [
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Floor policy" })]),
      el("div", { class: "inline-fields" }, [
        field("Team name", team),
        field("Max people away at once", cap, "hard ceiling across all break types"),
        field("Overtime grace (minutes)", grace, "how long an overstay keeps blocking its slot"),
        field("Auto sign-out (seconds)", kiosk, "0 = stay signed in")
      ]),
      el("p", { class: "small dim", style: { marginTop: "10px" } },
        ["Auto sign-out returns this PC to the login screen after that long without a click, so the next agent gets a clean slate. Running breaks keep their timers — the agent signs back in to tap “I'm back”."]),
      el("div", { style: { height: "10px" } }),
      el("button", {
        class: "btn primary", text: "Save policy", onclick: () => {
          store.update({
            "settings/teamName": team.value.trim() || "Team",
            "settings/globalMaxConcurrent": Math.max(1, Math.min(50, Number(cap.value) || 1)),
            "settings/graceMinutes": Math.max(0, Number(grace.value) || 0),
            "settings/kioskTimeoutSec": Math.max(0, Math.min(3600, Number(kiosk.value) || 0))
          });
          reconcile();
          toast("Policy saved", "ok");
        }
      })
    ]),

    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Backup" })]),
      el("div", { class: "callout" }, [
        "⚠ Everything lives in this browser. If someone clears this PC's site data, or the machine is replaced, ",
        el("b", { text: "it is all gone" }), ". Download a backup regularly — accounts, breaks and history are all in the file."
      ]),
      el("div", { class: "btn-row", style: { marginTop: "12px" } }, [
        el("button", {
          class: "btn primary", text: "⭳ Download backup", onclick: () => {
            download("breakflow-backup-" + dayKey(store.now()) + ".json", store.exportJSON(), "application/json");
            toast("Backup downloaded", "ok");
          }
        }),
        el("button", { class: "btn", text: "⭱ Restore from backup", onclick: () => restoreDialog() }),
        el("button", { class: "btn ghost", text: "Where does the data live?", onclick: () => storageDialog() })
      ])
    ]),

    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "Housekeeping" })]),
      el("div", { class: "btn-row" }, [
        el("button", {
          class: "btn", text: "Close every open break", onclick: async () => {
            const open = listSessions(state).filter((s) => [STATES.ACTIVE, STATES.OVER].includes(s.state));
            if (!open.length) { toast("No open breaks", "info"); return; }
            if (!(await confirmBox("Close " + open.length + " open break(s)?", "Use this at end of shift to reset the board.", "Close all"))) return;
            for (const s of open) endBreak(s.id, actor() + " (bulk)");
            toast("All breaks closed", "ok");
          }
        }),
        el("button", {
          class: "btn danger", text: "Delete history older than 30 days", onclick: async () => {
            const cutoff = store.now() - 30 * 86400000;
            const old = listSessions(state).filter((s) => (s.requestedAt || 0) < cutoff);
            if (!old.length) { toast("Nothing older than 30 days", "info"); return; }
            if (!(await confirmBox("Delete " + old.length + " old records?", "This cannot be undone. Download a backup first if you need it.", "Delete"))) return;
            const patch = {};
            for (const s of old) patch["sessions/" + s.id] = null;
            store.update(patch);
            toast(old.length + " records deleted", "ok");
          }
        }),
        el("button", {
          class: "btn danger", text: "Erase everything", onclick: async () => {
            if (!(await confirmBox("Erase all BreakFlow data on this PC?",
              "Accounts, breaks and history. There is no undo — download a backup first.", "Erase everything"))) return;
            store.wipeEverything();
            location.reload();
          }
        })
      ])
    ])
  ]);
}

function restoreDialog() {
  const file = el("input", { type: "file", accept: ".json,application/json", class: "in" });
  modal("Restore from backup", el("div", { class: "stack" }, [
    el("div", { class: "callout" }, [
      "⚠ This replaces everything currently on this PC — accounts, breaks and history — with the contents of the file."
    ]),
    field("Backup file", file)
  ]), [
    { label: "Cancel", kind: "ghost" },
    {
      label: "Restore", kind: "danger", onClick: async () => {
        const f = file.files && file.files[0];
        if (!f) { toast("Choose a backup file.", "error"); return false; }
        let text;
        try { text = await f.text(); } catch (e) { toast("Couldn't read that file.", "error"); return false; }
        try { store.importJSON(text); }
        catch (e) { toast(e.message, "error"); return false; }
        toast("Restored. Sign in again.", "ok");
        setTimeout(() => location.reload(), 700);
      }
    }
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
    if (!isOver(s, now) || s.state === STATES.QUEUED) continue;
    if (alerted[s.id]) continue;
    alerted[s.id] = true;
    beep("warn");
    notify("Overstay: " + s.agentName, s.breakTypeName + " ran out at " + hhmm(s.endsAt) + ".");
  }
}

window.BreakFlow = { store: store };

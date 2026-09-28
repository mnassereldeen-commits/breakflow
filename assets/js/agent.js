/* ============================================================
   BreakFlow - agent view
   ============================================================ */

import {
  store, STATES, ROLES, reconcile, sortedTypes, sortedAgents,
  occupancy, queueFor, listSessions, mySession, queuePosition, estimateStart,
  requestBreak, endBreak, cancelQueued, confirmReady, dayKey, isOver, onBreakNow
} from "./store.js";

import {
  $, el, mmss, hhmm, human, toast, modal, beep, askNotify, notify,
  flashTitle, stopFlash, setBaseTitle, mountStatusPill, mountClock, setFavicon, startTicker,
  initials, hueFrom, confirmBox, mountErrorToasts,
  signInGate, setupGate, noStorageGate, noConnectionGate, identityChip
} from "./common.js";
import { syncXcallyBreak, checkBridgeHealth } from "./xcally-bridge.js";

const RING_R = 110;
const CIRC = 2 * Math.PI * RING_R;
const seen = {};

/* ==================== Xcally bridge banner ====================
   A browser tab can never install anything on its own - that's a
   hard security boundary, not a BreakFlow choice. What it CAN do is
   notice the bridge isn't answering and walk the agent through the
   one-time setup themselves (see xcally-bridge/README.md). */
const LS_BRIDGE_DISMISS = "breakflow.xcallyBridgeDismissUntil";
let bridgeStatus = "unknown"; // "unknown" | "connected" | "missing"
let bridgeCheckInFlight = false;
let lastBridgeCheck = 0;
const BRIDGE_CHECK_INTERVAL_MS = 30000;

function bridgeDismissedUntil() {
  try {
    const v = localStorage.getItem(LS_BRIDGE_DISMISS);
    if (!v) return 0;
    if (v === "forever") return Infinity;
    const n = Number(v);
    return isFinite(n) ? n : 0;
  } catch (e) { return 0; }
}
function setBridgeDismiss(v) {
  try { localStorage.setItem(LS_BRIDGE_DISMISS, v); } catch (e) {}
}
function clearBridgeDismiss() {
  try { localStorage.removeItem(LS_BRIDGE_DISMISS); } catch (e) {}
}

function maybeCheckBridge(now) {
  if (bridgeCheckInFlight) return;
  if (now - lastBridgeCheck < BRIDGE_CHECK_INTERVAL_MS) return;
  lastBridgeCheck = now;
  bridgeCheckInFlight = true;
  checkBridgeHealth(1500).then((ok) => {
    bridgeCheckInFlight = false;
    const next = ok ? "connected" : "missing";
    if (next !== bridgeStatus) {
      bridgeStatus = next;
      if (ok) clearBridgeDismiss();
      render();
    }
  });
}

function xcallyBridgeBanner() {
  return el("div", { class: "card pad-lg", style: { borderLeft: "3px solid #38bdf8" } }, [
    el("div", { class: "row wrap", style: { alignItems: "center", gap: "12px" } }, [
      el("span", { style: { fontSize: "22px" }, text: "🔌" }),
      el("div", { style: { flex: "1 1 280px" } }, [
        el("div", { style: { fontWeight: "660" }, text: "Link this PC's Xcally to your breaks" }),
        el("div", { class: "small dim", text: "Optional, one-time setup - Xcally then shows you as on a break automatically, no browser tab required to keep it running." })
      ]),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn sm primary", text: "Show me how", onclick: () => openBridgeSetup() }),
        el("button", { class: "btn sm ghost", text: "Not on this PC", onclick: () => { setBridgeDismiss("forever"); render(); } }),
        el("button", { class: "btn sm ghost", text: "Remind me later", onclick: () => { setBridgeDismiss(String(store.now() + 7 * 86400000)); render(); } })
      ])
    ])
  ]);
}

/**
 * Triggers real, ordinary file downloads - a page can do that on a
 * click, same as any "download our app" button anywhere. It still
 * cannot run anything on the PC afterward; nothing can, from a
 * webpage, that's the actual security boundary. A second file starting
 * to download without its own separate click is enough that some
 * browsers ask the visitor to allow it once per site - that's the
 * browser protecting against a page silently downloading a pile of
 * files, and it's expected here, not an error.
 */
function downloadBridgeFiles() {
  const files = [
    ["xcally-bridge/XcallyBridge.ps1", "XcallyBridge.ps1"],
    ["xcally-bridge/Install.ps1", "Install.ps1"]
  ];
  files.forEach(([path, name], i) => {
    setTimeout(() => {
      const a = el("a", { href: path, download: name });
      document.body.append(a);
      a.click();
      a.remove();
    }, i * 350);
  });
}

function openBridgeSetup() {
  const statusLine = el("p", { class: "small", text: "Not connected yet." });
  const body = el("div", { class: "stack" }, [
    el("p", {}, [
      "This is a small program that runs quietly on ", el("b", { text: "this PC" }),
      " and tells Xcally when your BreakFlow break starts and ends."
    ]),
    el("div", { class: "btn-row" }, [
      el("button", { class: "btn primary", text: "⬇  Download", onclick: () => downloadBridgeFiles() })
    ]),
    el("ol", { class: "small", style: { paddingLeft: "20px", lineHeight: "1.7", marginTop: "10px" } }, [
      el("li", {}, ["Two files download - your browser may ask to allow it, since that's more than one at once. Choose ", el("b", { text: "Allow" }), "."]),
      el("li", {}, ["Open your ", el("b", { text: "Downloads" }), " folder. Right-click ", el("b", { text: "Install.ps1" }), " → ", el("b", { text: "Run with PowerShell" }), "."]),
      el("li", {}, ["A window flashes and closes - that's it done. Come back here and press ", el("b", { text: "Check now" }), " below."])
    ]),
    el("p", { class: "muted small", text: "Nothing here can run that program for you - only you clicking “Run with PowerShell” can. That's a real security boundary, not this site being unhelpful." }),
    el("p", { class: "small dim" }, [
      "Prefer to look at the files first, or set several PCs up at once? ",
      el("a", { href: "https://github.com/mnassereldeen-commits/breakflow/tree/main/xcally-bridge", target: "_blank", rel: "noopener", text: "open the folder on GitHub" }), "."
    ]),
    statusLine
  ]);
  modal("Link Xcally to your breaks", body, [
    { label: "Close", kind: "ghost" },
    {
      label: "Check now", kind: "primary", keepOpen: true, onClick: async () => {
        statusLine.textContent = "Checking…";
        const ok = await checkBridgeHealth(2500);
        bridgeStatus = ok ? "connected" : "missing";
        if (ok) {
          clearBridgeDismiss();
          statusLine.textContent = "✓ Connected! You can close this.";
          toast("Xcally bridge connected", "ok");
          render();
        } else {
          statusLine.textContent = "Still not answering - give it a few seconds after finishing the steps above, then try again.";
        }
      }
    }
  ]);
}

/* ==================== boot ==================== */
setFavicon();
mountStatusPill($("#statusHost"));
mountClock($("#clock"));
mountErrorToasts();

store.connect().then(() => {
  store.onStatus(render);
  store.onChange(render);
  startTicker(loop, 1000);
  loop();
});

function me() { return store.user; }

function loop() {
  reconcile();
  if (store.access !== "ok") return;
  const now = store.now();
  tickClocks(now);
  watchMine(now);
  maybeCheckBridge(now);
}

/* ==================== render ==================== */
function render() {
  const main = $("#main");
  const state = store.state;
  $("#teamName").textContent = state.settings.teamName || "Team";
  main.innerHTML = "";

  /* the panel link only appears for admins */
  const link = document.querySelector('a.pill[href="admin.html"]');
  if (link) link.hidden = !(me() && me().role === ROLES.ADMIN);

  identityChip($("#idHost"));

  if (store.access === "no-storage") { main.append(noStorageGate()); return; }
  if (store.access === "no-connection") { main.append(noConnectionGate()); return; }
  if (store.access === "setup") { main.append(setupGate()); return; }
  if (store.access !== "ok" || !me()) { main.append(signInGate(state.settings.teamName, "agent")); return; }

  const now = store.now();
  const mine = mySession(state, store.uid());

  if (bridgeStatus === "missing" && now > bridgeDismissedUntil()) {
    main.append(xcallyBridgeBanner());
  }

  main.append(el("div", { class: "split" }, [
    el("div", { class: "stack" }, [
      mine ? myBreakCard(state, mine, now) : chooseCard(state, now),
      myDayCard(state, now)
    ]),
    el("div", { class: "stack" }, [
      coverageCard(state, now),
      onBreakCard(state, now, mine),
      queueCard(state, now, mine)
    ])
  ]));
  tickClocks(now);
}

/* ---------- choose a break ---------- */
function chooseCard(state, now) {
  const types = sortedTypes(state);
  const occ = occupancy(state, now);
  const globalMax = Number(state.settings.globalMaxConcurrent || 3);
  const grid = el("div", { class: "type-grid" });

  for (const bt of types) {
    const used = occ.perType[bt.id] || 0;
    const cap = Number(bt.maxConcurrent || 1);
    const waiting = queueFor(state, bt.id).length;
    const free = Math.max(0, cap - used);
    const willQueue = free === 0 || occ.total >= globalMax || bt.requiresApproval;

    const dots = el("div", { class: "slot-dots" });
    for (let i = 0; i < cap; i++) dots.append(el("i", { class: i < used ? "used" : "" }));

    grid.append(el("button", {
      class: "type-btn", style: { "--c": bt.color || "#22d3ee" },
      onclick: () => ask(bt, willQueue, waiting)
    }, [
      el("div", { class: "t-top" }, [
        el("span", { class: "ico", text: bt.icon || "☕" }),
        el("div", {}, [
          el("div", { class: "nm", text: bt.name }),
          el("div", { class: "mins", text: bt.minutes + " min" })
        ])
      ]),
      el("div", { class: "slots" }, [dots, el("span", { text: free + " of " + cap + " free" })]),
      bt.requiresApproval
        ? el("span", { class: "badge warn", text: "Needs approval" })
        : willQueue
          ? el("span", { class: "badge", text: waiting ? "Queue – " + waiting + " waiting" : "Queue – you'd be next" })
          : el("span", { class: "badge ok", text: "Go now" })
    ]));
  }

  return el("div", { class: "card pad-lg" }, [
    el("div", { class: "card-head" }, [
      el("h2", { text: "Take a break" }),
      el("span", { class: "tiny", text: occ.total + " of " + globalMax + " away" })
    ]),
    types.length ? grid : el("p", { class: "empty", text: "No break types set up yet - ask a supervisor." })
  ]);
}

function ask(bt, willQueue, waiting) {
  const body = el("div", { class: "stack" }, [
    el("p", {}, [
      willQueue
        ? "All " + bt.name + " slots are taken right now. You'll join the queue" +
          (waiting ? " behind " + waiting + " " + (waiting === 1 ? "person" : "people") : " at the front") +
          ". The moment a slot opens you'll get 5 minutes to confirm you're taking it, or it starts on its own."
        : "You'll go on " + bt.name + " straight away for " + bt.minutes + " minutes."
    ]),
    el("p", { class: "muted small", text: "Your timer starts when the break starts, not when you request it." })
  ]);
  modal(willQueue ? "Join the queue?" : "Start " + bt.name + "?", body, [
    { label: "Not now", kind: "ghost" },
    {
      label: willQueue ? "Join queue" : "Start break", kind: "primary",
      onClick: () => {
        try {
          requestBreak(me(), bt);
          askNotify();
          beep("up");
        } catch (e) { toast(e.message || String(e), "error"); }
      }
    }
  ]);
}

/* ---------- my own break ---------- */
function myBreakCard(state, s, now) {
  const bt = state.breakTypes[s.breakTypeId] || {};
  const color = bt.color || "#22d3ee";

  if (s.state === STATES.QUEUED) {
    const pos = queuePosition(state, s);
    const est = estimateStart(state, s, now);
    const needsOk = bt.requiresApproval && !s.approvedBy;
    return el("div", { class: "card pad-lg ring-card", style: { "--glow": "rgba(99,102,241,.20)" } }, [
      el("span", { class: "badge cy", text: needsOk ? "Waiting for supervisor approval" : "You're in the queue" }),
      el("div", { class: "ring" }, [
        el("div", { class: "inner" }, [
          el("div", { class: "time", text: "#" + pos }),
          el("div", { class: "lbl", text: "in line" })
        ])
      ]),
      el("div", { class: "big-name", text: (bt.icon || "") + " " + s.breakTypeName }),
      el("div", { class: "back-at" }, [
        needsOk ? "A supervisor needs to release this one."
          : est ? "Estimated start ≈ " + hhmm(est) : "Waiting…"
      ]),
      el("div", { style: { height: "8px" } }),
      el("button", {
        class: "btn danger", onclick: async () => {
          if (await confirmBox("Leave the queue?", "You'll lose your place in line.", "Leave queue")) {
            cancelQueued(s.id, me().name);
            toast("You left the queue", "info");
          }
        }
      }, ["Leave the queue"])
    ]);
  }

  if (s.state === STATES.READY) {
    const remain = Math.max(0, (s.readyDeadline || now) - now);
    const warn = remain <= 60000;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 244 244");
    svg.setAttribute("width", "244");
    svg.setAttribute("height", "244");
    svg.innerHTML =
      '<circle class="track" cx="122" cy="122" r="' + RING_R + '" fill="none" stroke-width="13"/>' +
      '<circle class="prog" cx="122" cy="122" r="' + RING_R + '" fill="none" stroke-width="13" ' +
      'stroke="' + color + '" stroke-dasharray="' + CIRC + '" stroke-dashoffset="0"/>';

    const ring = el("div", {
      class: "ring" + (warn ? " warn" : ""),
      "data-ring": s.id, "data-endsat": s.readyDeadline || 0, "data-startedat": s.readyAt || 0
    }, [
      svg,
      el("div", { class: "inner" }, [
        el("div", { class: "time", "data-cd": s.readyDeadline || 0, text: mmss(remain) }),
        el("div", { class: "lbl", text: "remaining" })
      ])
    ]);

    return el("div", { class: "card pad-lg ring-card", style: { "--glow": "rgba(52,211,153,.22)" } }, [
      el("span", { class: "badge ok", text: "It's your turn!" }),
      ring,
      el("div", { class: "big-name", text: (bt.icon || "") + " " + s.breakTypeName }),
      el("div", { class: "back-at", text: "Confirm you're taking it, or it starts on its own when the timer runs out." }),
      el("div", { style: { height: "10px" } }),
      el("button", {
        class: "btn lg primary", onclick: () => {
          confirmReady(s.id, me().name);
          beep("up");
          toast("Break started — enjoy!", "ok");
        }
      }, ["✓  I'm ready — start my break"])
    ]);
  }

  const over = isOver(s, now);
  const remain = (s.endsAt || now) - now;
  const warn = !over && remain <= 60000;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 244 244");
  svg.setAttribute("width", "244");
  svg.setAttribute("height", "244");
  svg.innerHTML =
    '<circle class="track" cx="122" cy="122" r="' + RING_R + '" fill="none" stroke-width="13"/>' +
    '<circle class="prog" cx="122" cy="122" r="' + RING_R + '" fill="none" stroke-width="13" ' +
    'stroke="' + color + '" stroke-dasharray="' + CIRC + '" stroke-dashoffset="0"/>';

  const ring = el("div", {
    class: "ring" + (over ? " over" : warn ? " warn" : ""),
    "data-ring": s.id, "data-endsat": s.endsAt || 0, "data-startedat": s.startedAt || 0
  }, [
    svg,
    el("div", { class: "inner" }, [
      el("div", { class: "time", "data-cd": s.endsAt || 0, text: (over ? "+" : "") + mmss(Math.abs(remain)) }),
      el("div", { class: "lbl", text: over ? "over time" : "remaining" })
    ])
  ]);

  return el("div", {
    class: "card pad-lg ring-card",
    style: { "--glow": over ? "rgba(248,113,113,.22)" : "rgba(34,211,238,.20)" }
  }, [
    el("span", { class: "badge " + (over ? "bad" : "ok"), text: over ? "You are over your break time" : "On break" }),
    ring,
    el("div", { class: "big-name", text: (bt.icon || "") + " " + s.breakTypeName }),
    el("div", { class: "back-at", text: "Started " + hhmm(s.startedAt) + " · due back " + hhmm(s.endsAt) + (s.adjusted ? " (adjusted " + (s.adjusted > 0 ? "+" : "") + s.adjusted + "m)" : "") }),
    el("div", { style: { height: "10px" } }),
    el("button", {
      class: "btn lg primary", onclick: () => {
        endBreak(s.id, me().name);
        /* Xcally only ever goes back to Ready from the agent's own tap
           here - never automatically. See the note in watchMine(). */
        syncXcallyBreak(false);
        stopFlash();
        toast("Welcome back – break closed", "ok");
      }
    }, ["✓  I'm back"]),
    over ? el("p", { class: "small err", style: { marginTop: "10px" }, text: "Your supervisor can see this. Tap “I'm back” as soon as you're at your desk." }) : null
  ]);
}

/* ---------- side panels ---------- */
function coverageCard(state, now) {
  const occ = occupancy(state, now);
  const globalMax = Number(state.settings.globalMaxConcurrent || 3);
  const waiting = queueFor(state).length;
  const roster = sortedAgents(state).length;
  return el("div", { class: "card" }, [
    el("div", { class: "stats" }, [
      el("div", { class: "stat " + (occ.total >= globalMax ? "warn" : "ok") }, [
        el("b", { text: occ.total + "/" + globalMax }), el("span", { text: "Away now" })
      ]),
      el("div", { class: "stat" }, [el("b", { text: String(waiting) }), el("span", { text: "In queue" })]),
      el("div", { class: "stat" }, [el("b", { text: String(Math.max(0, roster - occ.total)) }), el("span", { text: "On the floor" })])
    ])
  ]);
}

function onBreakCard(state, now, mine) {
  const live = onBreakNow(state, now);
  const box = el("div", {});
  if (!live.length) box.append(el("p", { class: "empty", text: "Nobody is on break right now." }));
  for (const s of live) {
    const bt = state.breakTypes[s.breakTypeId] || {};
    const over = isOver(s, now);
    const remain = (s.endsAt || now) - now;
    const isMe = mine && s.id === mine.id;
    box.append(el("div", { class: "person-row" + (isMe ? " mine" : "") }, [
      el("span", { class: "av", style: { "--h": hueFrom(s.agentName) }, text: initials(s.agentName) }),
      el("div", { class: "who" }, [
        el("b", { text: s.agentName + (isMe ? " (you)" : "") }),
        el("span", { text: (bt.icon || "") + " " + s.breakTypeName + " · back " + hhmm(s.endsAt) })
      ]),
      el("span", {
        class: "rem " + (over ? "over" : remain <= 60000 ? "warn" : ""),
        "data-cd": s.endsAt || 0,
        text: (over ? "+" : "") + mmss(Math.abs(remain))
      })
    ]));
  }
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", { text: "On break now" }),
      el("span", { class: "tiny", text: live.length + " out" })
    ]),
    box
  ]);
}

function queueCard(state, now, mine) {
  const q = queueFor(state);
  const box = el("div", { class: "qline" });
  if (!q.length) box.append(el("p", { class: "empty", text: "Queue is empty – breaks start instantly." }));
  q.forEach((s, i) => {
    const bt = state.breakTypes[s.breakTypeId] || {};
    const est = estimateStart(state, s, now);
    const isMe = mine && s.id === mine.id;
    box.append(el("div", { class: "person-row" + (isMe ? " mine" : "") }, [
      el("span", { class: "pos", text: String(i + 1) }),
      el("span", { class: "av", style: { "--h": hueFrom(s.agentName) }, text: initials(s.agentName) }),
      el("div", { class: "who" }, [
        el("b", { text: s.agentName + (isMe ? " (you)" : "") }),
        el("span", { text: (bt.icon || "") + " " + s.breakTypeName + " · asked " + hhmm(s.requestedAt) })
      ]),
      bt.requiresApproval && !s.approvedBy
        ? el("span", { class: "badge warn", text: "approval" })
        : el("span", { class: "rem dim", style: { fontSize: "12.5px" }, text: est && est > now ? "≈" + human(est - now) : "next" })
    ]));
  });
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", { text: "Waiting in line" }),
      el("span", { class: "tiny", text: q.length + " waiting" })
    ]),
    box
  ]);
}

function myDayCard(state, now) {
  const today = dayKey(now);
  const uid = store.uid();
  const mine = listSessions(state).filter(
    (s) => s.agentId === uid && s.day === today && s.startedAt && s.state !== STATES.CANCELLED && s.state !== STATES.DENIED
  );
  const used = mine.reduce((t, s) => t + Math.max(0, (s.endedAt || now) - s.startedAt), 0);
  const overs = mine.filter((s) => (s.overBy || 0) > 30000).length;
  const list = el("div", {});
  const done = mine.filter((s) => s.state === STATES.DONE).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (!done.length) list.append(el("p", { class: "empty", text: "No breaks logged today yet." }));
  for (const s of done.slice(0, 6)) {
    const bt = state.breakTypes[s.breakTypeId] || {};
    list.append(el("div", { class: "person-row" }, [
      el("span", { class: "ico", style: { fontSize: "17px", width: "22px" }, text: bt.icon || "•" }),
      el("div", { class: "who" }, [
        el("b", { text: s.breakTypeName }),
        el("span", { text: hhmm(s.startedAt) + " – " + hhmm(s.endedAt) })
      ]),
      (s.overBy || 0) > 30000
        ? el("span", { class: "badge bad", text: "+" + human(s.overBy) + " over" })
        : el("span", { class: "badge ok", text: human((s.endedAt || 0) - (s.startedAt || 0)) })
    ]));
  }
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", { text: "Your day" })]),
    el("div", { class: "stats", style: { marginBottom: "12px" } }, [
      el("div", { class: "stat" }, [el("b", { text: String(mine.length) }), el("span", { text: "Breaks" })]),
      el("div", { class: "stat" }, [el("b", { text: human(used) }), el("span", { text: "Time used" })]),
      el("div", { class: "stat " + (overs ? "bad" : "") }, [el("b", { text: String(overs) }), el("span", { text: "Overstays" })])
    ]),
    list
  ]);
}

/* ==================== clock repaint ==================== */
function tickClocks(now) {
  for (const n of document.querySelectorAll("[data-cd]")) {
    const d = Number(n.getAttribute("data-cd")) - now;
    const over = d < 0;
    n.textContent = (over ? "+" : "") + mmss(Math.abs(d));
    if (n.classList.contains("rem")) {
      n.classList.toggle("over", over);
      n.classList.toggle("warn", !over && d <= 60000);
    }
    if (n.classList.contains("time")) {
      const ring = n.closest(".ring");
      if (ring) {
        ring.classList.toggle("over", over);
        ring.classList.toggle("warn", !over && d <= 60000);
      }
      const lbl = n.parentElement && n.parentElement.querySelector(".lbl");
      if (lbl) lbl.textContent = over ? "over time" : "remaining";
    }
  }
  for (const ring of document.querySelectorAll("[data-ring]")) {
    const ends = Number(ring.getAttribute("data-endsat"));
    const start = Number(ring.getAttribute("data-startedat"));
    const total = Math.max(1, ends - start);
    const frac = Math.max(0, Math.min(1, (ends - now) / total));
    const prog = ring.querySelector(".prog");
    if (prog) {
      prog.setAttribute("stroke-dashoffset", String(CIRC * (1 - frac)));
      if (ends - now < 0) prog.setAttribute("stroke", "#f87171");
      else if (ends - now <= 60000) prog.setAttribute("stroke", "#fbbf24");
    }
  }
}

/* ==================== alerts for my own break ==================== */
function watchMine(now) {
  if (!me()) return;
  const s = mySession(store.state, store.uid());
  /* Xcally is only ever set back to Ready by the agent's own "I'm back"
     tap (see myBreakCard) - never from here, and never just because
     this tab no longer sees an open session. A session can close
     without the agent being at their desk yet (an admin closing it
     from the Live board, a denied/cancelled queue entry, a restored
     backup...) and Xcally must not start routing them real calls on
     the strength of that. Marking Break is the safe direction and
     stays automatic below; marking Ready is not, so it isn't. */
  if (!s) { stopFlash(); setBaseTitle("BreakFlow"); return; }
  const f = seen[s.id] || (seen[s.id] = {});

  if (s.state === STATES.QUEUED) {
    setBaseTitle("#" + queuePosition(store.state, s) + " in queue · BreakFlow");
    return;
  }

  if (s.state === STATES.READY) {
    const left = Math.max(0, (s.readyDeadline || now) - now);
    if (!f.readyNotified) {
      f.readyNotified = true;
      beep("up");
      notify("It's your turn!", "Confirm your " + s.breakTypeName + " or it starts on its own in 5 minutes.");
    }
    if (!f.readyWarned && left > 0 && left <= 60000) {
      f.readyWarned = true;
      beep("warn");
      notify("1 minute to confirm", "Tap start, or your " + s.breakTypeName + " begins automatically.");
    }
    setBaseTitle("Ready? " + mmss(left) + " · " + s.breakTypeName);
    return;
  }

  /* only ACTIVE and OVER reach here - the agent is genuinely away */
  syncXcallyBreak(true);
  const remain = (s.endsAt || now) - now;

  if (!f.started) {
    f.started = true;
    if (now - (s.startedAt || 0) < 15000) {
      beep("up");
      notify("Your break has started", s.breakTypeName + " – " + s.minutes + " minutes. Due back " + hhmm(s.endsAt) + ".");
    }
  }
  if (!f.warned && remain > 0 && remain <= 60000) {
    f.warned = true;
    beep("warn");
    notify("1 minute left", "Wrap up your " + s.breakTypeName + ".");
  }
  if (!f.over && remain <= 0) {
    f.over = true;
    beep("alarm");
    notify("Break time is up", "You are over on your " + s.breakTypeName + ". Tap “I'm back”.");
    flashTitle("⏰ BREAK OVER");
  }
  if (remain > 0) {
    stopFlash();
    setBaseTitle(mmss(remain) + " · " + s.breakTypeName);
  }
}

window.BreakFlow = { store: store };

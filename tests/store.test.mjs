/* Drives the real assets/js/store.js against an in-memory Firebase.
   Run with:  node --import ./tests/register.mjs --test tests/store.test.mjs */

import test from "node:test";
import assert from "node:assert/strict";

/* the store keeps "who is signed in" in sessionStorage */
const mem = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); }
};

const { db } = await import("./fake-firebase.mjs");
const S = await import("../assets/js/store.js");
const { store, STATES } = S;

const tick = () => new Promise((r) => setTimeout(r, 5));
const MIN = 60000;

async function boot() {
  db.offset = 0;
  const access = await store.connect();
  assert.equal(access, "cloud");
  await tick();
}

const sessionsOf = () => Object.values(store.state.sessions);

test("the store's clock follows the database server, not the PC", async () => {
  db.offset = 7 * MIN;                               /* this PC is 7 minutes slow */
  await store.connect();
  const skew = store.now() - Date.now();
  assert.ok(Math.abs(skew - 7 * MIN) < 50, "now() is server time (" + skew + "ms ahead)");
  db.offset = 0;
});

test("a full break cycle goes through transactions and lands in the shared board", async () => {
  await boot();
  await store.connect();
  db.tree.sessions = {};
  await tick();

  const cap = 1;
  store.update({ "settings/globalMaxConcurrent": cap });

  const a = { uid: "a1", name: "Ann", team: "" };
  const b = { uid: "b1", name: "Bob", team: "" };
  const short = store.state.breakTypes.short;
  assert.ok(short, "default break types were seeded");

  const idA = S.requestBreak(a, short);
  await tick();
  let s = store.state.sessions[idA];
  assert.equal(s.state, STATES.READY, "free slot: offered straight away");

  S.confirmReady(idA, "Ann");
  await tick();
  assert.equal(store.state.sessions[idA].state, STATES.ACTIVE);

  const idB = S.requestBreak(b, short);
  await tick();
  assert.equal(store.state.sessions[idB].state, STATES.QUEUED, "floor is full, so Bob queues");

  assert.throws(() => S.requestBreak(a, short), /already have a break open/);

  S.endBreak(idA, "Ann");
  await tick(); await tick();
  assert.equal(store.state.sessions[idA].state, STATES.DONE);
  assert.equal(store.state.sessions[idB].state, STATES.READY, "Bob is offered the freed slot");

  /* a second, late 'I'm back' or leave-queue must not change anything */
  S.endBreak(idA, "Ann");
  S.cancelQueued(idA, "Ann");
  await tick();
  assert.equal(store.state.sessions[idA].state, STATES.DONE);
});

test("an overstay holds the floor until they are back, all through the store", async () => {
  await boot();
  await store.connect();
  db.tree.sessions = {};
  store.update({ "settings/globalMaxConcurrent": 1, "settings/graceMinutes": 3 });
  await tick();

  const short = store.state.breakTypes.short;
  const idA = S.requestBreak({ uid: "a2", name: "Cy", team: "" }, short);
  await tick();
  S.confirmReady(idA, "Cy");
  await tick();
  const idB = S.requestBreak({ uid: "b2", name: "Di", team: "" }, short);
  await tick();

  /* jump the clock 40 minutes: Cy is 25 minutes over and well past the 3-minute grace */
  db.offset = 40 * MIN;
  store.clockOffset = 40 * MIN;
  S.reconcile();
  await tick();
  assert.equal(store.state.sessions[idA].state, STATES.OVER);
  assert.equal(store.state.sessions[idB].state, STATES.QUEUED, "Di is not sent out while Cy is still away");

  S.endBreak(idA, "Cy");
  await tick(); await tick();
  assert.equal(store.state.sessions[idB].state, STATES.READY);
  store.clockOffset = 0; db.offset = 0;
});

test("adjustTime tells the admin what it will do and applies it", async () => {
  await boot();
  await store.connect();
  db.tree.sessions = {};
  store.update({ "settings/globalMaxConcurrent": 3 });
  await tick();
  const lunch = store.state.breakTypes.lunch;
  const id = S.requestBreak({ uid: "a3", name: "Ed", team: "" }, lunch);
  await tick();
  S.confirmReady(id, "Ed");
  await tick();
  const before = store.state.sessions[id].endsAt;
  const res = S.adjustTime(id, 5);
  await tick();
  assert.equal(res.applied, 5);
  assert.equal(store.state.sessions[id].endsAt, before + 5 * MIN);
});

test("an idle board costs no database round trips", async () => {
  await boot();
  await store.connect();
  db.tree.sessions = {};
  await tick();
  const before = db.transactions;
  for (let i = 0; i < 50; i++) S.reconcile();
  await tick();
  assert.equal(db.transactions, before);
});

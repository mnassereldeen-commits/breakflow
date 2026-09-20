/* An in-memory stand-in for assets/js/firebase.js, so the real store can
   be exercised in Node without touching the live database. It mimics the
   parts that matter: a shared tree, change events, server clock offset,
   and atomic transactions on /sessions. */

export const db = { tree: null, watchers: [], offset: 0, transactions: 0 };

function emit() {
  const snap = db.tree === null ? null : JSON.parse(JSON.stringify(db.tree));
  db.watchers.forEach((f) => f(snap));
}

export async function connectFirebase() { return {}; }
export function readServerOffset() { return Promise.resolve(db.offset); }
export function onServerOffset() { return () => {}; }

export function watchRoot(onData) {
  db.watchers.push(onData);
  queueMicrotask(() => onData(db.tree === null ? null : JSON.parse(JSON.stringify(db.tree))));
  return () => {};
}

export function writePatch(patch) {
  db.tree = db.tree || {};
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split("/").filter(Boolean);
    let node = db.tree;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = node[parts[i]] || {};
    if (v === null) delete node[parts[parts.length - 1]];
    else node[parts[parts.length - 1]] = JSON.parse(JSON.stringify(v));
  }
  emit();
  return Promise.resolve();
}

export function transactSessions(fn) {
  db.transactions++;
  db.tree = db.tree || {};
  const had = db.tree.sessions !== undefined && db.tree.sessions !== null;
  const sessions = had ? JSON.parse(JSON.stringify(db.tree.sessions)) : {};
  const changed = fn(sessions);
  if (changed) {
    db.tree.sessions = sessions;
    emit();
  }
  return Promise.resolve({ committed: !!changed });
}

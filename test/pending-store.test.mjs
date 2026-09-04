// email-wake pending-store unit tests.
//
// The durable half of the P0 fix: a parsed reply is persisted to disk (not an
// in-memory queue) so a daemon crash between parse and ack can NEVER lose it.
// Proves: durable load/persist, add (upsert-by-UID), claim/ack atomicity
// (first-claimant-wins, only-claimant-can-ack), and stale-claim steal (a crashed
// claimant cannot wedge a pending entry forever). No IMAP/SMTP, no network.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "email-wake-pending-"))
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const { createPendingStore, CLAIM_TTL_MS } = await import("../pending-store.js")

// A fresh store on a unique path (per-test isolation without cross-talk).
function makeStore(opts = {}) {
  const path = join(tmp, `pending-${Math.random().toString(36).slice(2)}.json`)
  return { store: createPendingStore({ path, ...opts }), path }
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

test("add persists to disk; a NEW store on the same path re-loads the pending (crash recovery)", () => {
  const { store, path } = makeStore()
  store.add({ uid: 12345, sessionID: "ses_a", body: "go", from: "a@b.c" })

  // Simulate a daemon crash + restart: a fresh store reading the SAME file
  // must see the pending entry (this is the P0 durability guarantee).
  const restarted = createPendingStore({ path })
  const entries = restarted.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].uid, "12345")
  assert.equal(entries[0].sessionID, "ses_a")
  assert.equal(entries[0].body, "go")
  assert.equal(entries[0].from, "a@b.c")
  assert.equal(entries[0].claimedBy, undefined, "a fresh pending must be unclaimed")
})

test("add is idempotent by UID (re-parse of the same UID does not duplicate)", () => {
  const { store } = makeStore()
  const first = store.add({ uid: 99, sessionID: "ses_a", body: "x", from: "a@b.c" })
  const second = store.add({ uid: 99, sessionID: "ses_a", body: "x", from: "a@b.c" })
  assert.equal(first.created, true)
  assert.equal(second.created, false, "re-add of an existing UID must signal NOT created")
  assert.equal(store.size(), 1)
})

test("a missing/corrupt pending.json is tolerated (starts empty)", () => {
  const path = join(tmp, `corrupt-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, "{not valid json", "utf8")
  const store = createPendingStore({ path })
  assert.equal(store.list().length, 0, "corrupt file must read as empty, not throw")
})

// ---------------------------------------------------------------------------
// claim / ack atomicity
// ---------------------------------------------------------------------------

test("claim: first claimant wins; a second instance cannot claim; same instance can re-claim", () => {
  const { store } = makeStore()
  store.add({ uid: 1, sessionID: "ses_a", body: "b", from: "a@b.c" })

  const a = store.claim({ uid: 1, sessionID: "ses_a", instanceId: "inst-A" })
  assert.deepEqual(a, { claimed: true }, "first claim must win")

  const b = store.claim({ uid: 1, sessionID: "ses_a", instanceId: "inst-B" })
  assert.equal(b.claimed, false, "a second instance must NOT claim an actively-claimed pending")

  const aAgain = store.claim({ uid: 1, sessionID: "ses_a", instanceId: "inst-A" })
  assert.deepEqual(aAgain, { claimed: true }, "the same instance may re-claim (idempotent)")
})

test("claim: mismatched sessionID is rejected (pending belongs to a different session)", () => {
  const { store } = makeStore()
  store.add({ uid: 2, sessionID: "ses_a", body: "b", from: "a@b.c" })
  const res = store.claim({ uid: 2, sessionID: "ses_wrong", instanceId: "inst-A" })
  assert.equal(res.claimed, false)
  assert.equal(res.mismatch, true)
})

test("claim: a missing UID is reported, not claimed", () => {
  const { store } = makeStore()
  const res = store.claim({ uid: 999, sessionID: "ses_a", instanceId: "inst-A" })
  assert.equal(res.claimed, false)
  assert.equal(res.missing, true)
})

test("ack: only the claimant can ack; ack removes the pending", () => {
  const { store } = makeStore()
  store.add({ uid: 3, sessionID: "ses_a", body: "b", from: "a@b.c" })
  store.claim({ uid: 3, sessionID: "ses_a", instanceId: "inst-A" })

  assert.equal(store.canAck({ uid: 3, sessionID: "ses_a", instanceId: "inst-B" }), false, "non-claimant must NOT ack")
  assert.equal(store.canAck({ uid: 3, sessionID: "ses_a", instanceId: "inst-A" }), true, "claimant must ack")

  store.remove(3)
  assert.equal(store.size(), 0, "ack must remove the pending entry")
  assert.equal(store.get(3), null)
})

test("ack of an unclaimed pending is refused (must claim before ack)", () => {
  const { store } = makeStore()
  store.add({ uid: 4, sessionID: "ses_a", body: "b", from: "a@b.c" })
  assert.equal(store.canAck({ uid: 4, sessionID: "ses_a", instanceId: "inst-A" }), false)
})

// ---------------------------------------------------------------------------
// stale-claim steal (crashed claimant recovery)
// ---------------------------------------------------------------------------

test("a stale claim can be stolen so a crashed claimant cannot wedge a pending forever", () => {
  let now = 1_000_000
  const { store } = makeStore({ now: () => now })
  store.add({ uid: 5, sessionID: "ses_a", body: "b", from: "a@b.c" })
  store.claim({ uid: 5, sessionID: "ses_a", instanceId: "inst-dead" })

  // Immediately after the claim, a live second instance cannot steal it.
  assert.equal(store.claim({ uid: 5, sessionID: "ses_a", instanceId: "inst-alive" }).claimed, false)

  // After the claim TTL elapses, the pending becomes stale → claimable again.
  now += CLAIM_TTL_MS + 1
  assert.equal(store.listClaimable().some((e) => e.uid === "5"), true, "stale claim must be re-broadcastable")

  // And a second instance can steal it.
  assert.deepEqual(store.claim({ uid: 5, sessionID: "ses_a", instanceId: "inst-alive" }), { claimed: true })

  // After the steal the claim is fresh again → no longer claimable by others.
  assert.equal(store.listClaimable().some((e) => e.uid === "5"), false)
})

test("listClaimable: actively-claimed (fresh) entries are excluded; unclaimed + stale are included", () => {
  let now = 1_000_000
  const { store } = makeStore({ now: () => now })
  store.add({ uid: 6, sessionID: "ses_a", body: "u", from: "a@b.c" }) // unclaimed
  store.add({ uid: 8, sessionID: "ses_c", body: "s", from: "a@b.c" }) // claimed, then stale
  store.claim({ uid: 8, sessionID: "ses_c", instanceId: "inst-dead" })

  now += CLAIM_TTL_MS + 1 // uid 8 is now stale; uid 7 not yet added

  store.add({ uid: 7, sessionID: "ses_b", body: "c", from: "a@b.c" }) // claimed fresh (at the new now)
  store.claim({ uid: 7, sessionID: "ses_b", instanceId: "inst-A" })

  const claimable = store.listClaimable().map((e) => e.uid).sort()
  assert.deepEqual(claimable, ["6", "8"], "unclaimed + stale are claimable; fresh-claimed is not")
})

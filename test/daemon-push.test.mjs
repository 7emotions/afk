// email-wake PUSH endpoints unit tests.
//
// Exercises the daemon's SSE + claim/ack surface against a real in-process
// registry + pending-store on an ephemeral port:
//   - GET /pending      lists pending (reconnect catch-up)
//   - POST /claim       first-claimant-wins, idempotent re-claim, missing/mismatch
//   - POST /ack         claimant-only (non-claimant → 409), runs onAck (markSeen+
//                       journal) then removes the pending
//   - GET /events       SSE stream: re-broadcast unclaimed pending on connect,
//                       and live broadcast of a newly-created pending
// No IMAP/SMTP, no live opencode.

import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRegistry } from "../registry.js"
import { createPendingStore } from "../pending-store.js"
import { createHttpServer } from "../daemon.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), "email-wake-push-"))

let server
let baseUrl
let broadcast
let pendingStore
let registry
const ackCalls = []

before(async () => {
  pendingStore = createPendingStore({ path: join(tmp, "pending.json") })
  registry = createRegistry()
  const built = createHttpServer(registry, pendingStore, {
    onAck: async (uid) => {
      ackCalls.push(uid)
    },
  })
  server = built.server
  broadcast = built.broadcast
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(() => {
  pendingStore.reset()
  ackCalls.length = 0
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// GET /pending
// ---------------------------------------------------------------------------

test("GET /pending lists current pending deliveries", async () => {
  pendingStore.add({ uid: 11, sessionID: "ses_a", body: "b1", from: "a@b.c" })
  pendingStore.add({ uid: 12, sessionID: "ses_b", body: "b2", from: "a@b.c" })

  const res = await fetch(`${baseUrl}/pending`)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.ok, true)
  const uids = data.pending.map((p) => p.uid).sort()
  assert.deepEqual(uids, ["11", "12"])
})

// ---------------------------------------------------------------------------
// POST /claim
// ---------------------------------------------------------------------------

test("POST /claim: first claimant wins; a second instance is refused; same instance re-claims", async () => {
  pendingStore.add({ uid: 21, sessionID: "ses_a", body: "b", from: "a@b.c" })

  const a = await (await fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 21, sessionID: "ses_a", instanceId: "inst-A" }),
  })).json()
  assert.deepEqual(a, { ok: true, claimed: true })

  const b = await (await fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 21, sessionID: "ses_a", instanceId: "inst-B" }),
  })).json()
  assert.deepEqual(b, { ok: true, claimed: false }, "a second instance must not claim")

  const aAgain = await (await fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 21, sessionID: "ses_a", instanceId: "inst-A" }),
  })).json()
  assert.deepEqual(aAgain, { ok: true, claimed: true }, "same instance re-claims (idempotent)")
})

test("POST /claim with missing fields → 400", async () => {
  const res = await fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 21 }),
  })
  assert.equal(res.status, 400)
})

// ---------------------------------------------------------------------------
// POST /ack
// ---------------------------------------------------------------------------

test("POST /ack: non-claimant is refused (409); claimant acks → onAck runs + pending removed", async () => {
  pendingStore.add({ uid: 31, sessionID: "ses_a", body: "b", from: "a@b.c" })

  // A non-claimant cannot ack.
  const refused = await fetch(`${baseUrl}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 31, sessionID: "ses_a", instanceId: "inst-B" }),
  })
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { ok: false, error: "not the claimant" })

  // Claim, then ack.
  await fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 31, sessionID: "ses_a", instanceId: "inst-A" }),
  })
  const acked = await fetch(`${baseUrl}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 31, sessionID: "ses_a", instanceId: "inst-A" }),
  })
  assert.equal(acked.status, 200)
  assert.deepEqual(await acked.json(), { ok: true })

  assert.deepEqual(ackCalls, ["31"], "ack must run onAck (markSeen + journal) with the UID")
  assert.equal(pendingStore.get("31"), null, "ack must remove the pending")
})

test("POST /ack releases the registry reservation so the session can ask a new decision", async () => {
  registry.register("ses_ack_release")
  pendingStore.add({ uid: 32, sessionID: "ses_ack_release", body: "b", from: "a@b.c" })

  await fetch(`${baseUrl}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 32, sessionID: "ses_ack_release", instanceId: "inst-A" }),
  })
  const acked = await fetch(`${baseUrl}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: 32, sessionID: "ses_ack_release", instanceId: "inst-A" }),
  })
  assert.equal(acked.status, 200)

  assert.equal(registry.has("ses_ack_release"), false, "ack must release the registry reservation")
})

// ---------------------------------------------------------------------------
// GET /events (SSE)
// ---------------------------------------------------------------------------

// A minimal SSE reader over a fetch stream. Resolves delivery events only.
function parseSSE(block) {
  let event = "message"
  const dataLines = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  return { event, data: dataLines.join("\n") }
}

async function openSSE(url) {
  const res = await fetch(url)
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const queue = []
  let buf = ""
  let closed = false
  const readLoop = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        closed = true
        return
      }
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = parseSSE(block)
        if (ev.event === "delivery" && ev.data) queue.push(JSON.parse(ev.data))
      }
    }
  })()
  return {
    async next(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      while (queue.length === 0 && !closed && Date.now() < deadline) await sleep(5)
      return queue.length ? queue.shift() : null
    },
    async close() {
      await reader.cancel().catch(() => {})
    },
  }
}

test("GET /events: re-broadcasts unclaimed pending on connect (restart re-discovers deliveries)", async () => {
  pendingStore.add({ uid: 41, sessionID: "ses_a", body: "hello", from: "a@b.c" })

  const sse = await openSSE(`${baseUrl}/events`)
  try {
    const ev = await sse.next()
    assert.ok(ev, "connect must re-broadcast the unclaimed pending")
    assert.equal(ev.uid, "41")
    assert.equal(ev.sessionID, "ses_a")
    assert.equal(ev.body, "hello")
    assert.equal(ev.from, "a@b.c")
  } finally {
    await sse.close()
  }
})

test("GET /events: broadcasts a newly-created pending to connected clients (live push)", async () => {
  const sse = await openSSE(`${baseUrl}/events`)
  try {
    // No pending at connect time → no delivery event.
    assert.equal(await sse.next(300), null, "no pending → no delivery on connect")

    // A new pending is created elsewhere → broadcast fires on the live stream.
    const { entry } = pendingStore.add({ uid: 42, sessionID: "ses_b", body: "go", from: "a@b.c" })
    broadcast(entry)

    const ev = await sse.next()
    assert.ok(ev, "a live broadcast must reach the connected client")
    assert.equal(ev.uid, "42")
    assert.equal(ev.sessionID, "ses_b")
  } finally {
    await sse.close()
  }
})

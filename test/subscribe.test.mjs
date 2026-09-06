// afk SSE subscriber unit tests.
//
// Proves the plugin-side PUSH client contract against a fake daemon HTTP API,
// a fake SSE stream, and a fake in-process SDK client:
//   - ownership self-check (session.directory === input.directory) gates the rest
//   - claim → inject (FLAT {sessionID, parts} signature + buildPayload) → ack
//   - inject failure does NOT ack (pending left for retry — never lost)
//   - a lost claim does NOT inject (multi-instance dedupe)
//   - reconnect catch-up re-processes owned pending (GET /pending)
// No network, no IMAP/SMTP, no live opencode.

import { test, after } from "node:test"
import assert from "node:assert/strict"

import { startSubscription, handleDelivery } from "../core/subscribe.js"
import { buildPayload } from "../core/inject.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, timeoutMs = 3000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(stepMs)
  }
  return cond()
}

// Collect stop functions for teardown even if a test fails early.
const stops = []
after(() => {
  for (const stop of stops) stop()
})

// A fake in-process SDK client. session.get returns the session's directory from
// the ownership map; session.prompt records calls (v1 HTTP-style signature);
// session.create returns a fresh session id.
function makeClient(ownership = {}) {
  const promptCalls = []
  const createCalls = []
  let created = 0
  const client = {
    session: {
      get: async ({ path }) => {
        const sessionID = path?.id
        if (!(sessionID in ownership)) return { error: { status: 404 } }
        return { data: { directory: ownership[sessionID] } }
      },
      create: async (req) => {
        createCalls.push(req)
        created += 1
        return { data: { id: `ses_new_${created}` } }
      },
      promptAsync: async (req) => {
        promptCalls.push(req)
        return undefined
      },
    },
  }
  return { client, promptCalls, createCalls }
}

// A fake daemon HTTP API. Records claim/ack bodies; serves a controllable SSE
// stream and a /pending list.
function makeFakeDaemon({ pending = [], claimResult = true } = {}) {
  const claimed = []
  const acked = []
  let eventStream = null
  const eventsOpened = (() => {
    let resolve
    const promise = new Promise((r) => (resolve = r))
    return { promise, resolve }
  })()

  const fetchImpl = async (url, init) => {
    const u = new URL(url, "http://daemon")
    const method = init?.method ?? "GET"
    if (u.pathname === "/events") {
      eventsOpened.resolve()
      return { ok: true, body: eventStream.stream }
    }
    if (u.pathname === "/pending") {
      return { ok: true, json: async () => ({ ok: true, pending }) }
    }
    if (u.pathname === "/claim") {
      const body = JSON.parse(init.body)
      claimed.push(body)
      return { ok: true, json: async () => ({ ok: true, claimed: claimResult }) }
    }
    if (u.pathname === "/ack") {
      const body = JSON.parse(init.body)
      acked.push(body)
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: false, json: async () => ({}) }
  }

  return { fetchImpl, claimed, acked, eventsOpened, setEventStream: (s) => (eventStream = s) }
}

// A controllable SSE stream (ReadableStream we can push delivery events into).
function makeEventStream() {
  let controller
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(c) {
      controller = c
    },
    cancel() {},
  })
  return {
    stream,
    pushDelivery(delivery) {
      controller.enqueue(encoder.encode(`event: delivery\ndata: ${JSON.stringify(delivery)}\n\n`))
    },
    close() {
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
  }
}

// ---------------------------------------------------------------------------
// handleDelivery (claim → inject → ack ordering)
// ---------------------------------------------------------------------------

test("handleDelivery: owned session → claim → inject (flat signature) → ack", async () => {
  const { client, promptCalls } = makeClient({ ses_own: "/proj" })
  const daemon = makeFakeDaemon()

  const ok = await handleDelivery(
    { uid: "1", sessionID: "ses_own", body: "go ahead", from: "a@b.c" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
    }
  )

  assert.equal(ok, true)
  assert.deepEqual(daemon.claimed, [{ uid: "1", sessionID: "ses_own", instanceId: "inst-1" }])
  assert.deepEqual(daemon.acked, [{ uid: "1", sessionID: "ses_own", instanceId: "inst-1" }])
  assert.deepEqual(promptCalls, [
    {
      path: { id: "ses_own" },
      body: { parts: [{ type: "text", text: buildPayload({ from: "a@b.c", body: "go ahead" }) }] },
    },
  ])
})

test("handleDelivery: non-owned session is ignored (no claim, no inject, no ack)", async () => {
  const { client, promptCalls } = makeClient({ ses_own: "/other" })
  const daemon = makeFakeDaemon()

  const ok = await handleDelivery(
    { uid: "2", sessionID: "ses_own", body: "x", from: "a@b.c" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
    }
  )

  assert.equal(ok, false)
  assert.equal(daemon.claimed.length, 0, "non-owned must not claim")
  assert.equal(daemon.acked.length, 0)
  assert.equal(promptCalls.length, 0, "non-owned must not inject")
})

test("handleDelivery: inject failure does NOT ack (pending left for retry — never lost)", async () => {
  const { client } = makeClient({ ses_own: "/proj" })
  client.session.promptAsync = async () => ({ error: { status: 500, body: "boom" } })
  const daemon = makeFakeDaemon()

  const ok = await handleDelivery(
    { uid: "3", sessionID: "ses_own", body: "x", from: "a@b.c" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
      error: () => {},
    }
  )

  assert.equal(ok, false)
  assert.equal(daemon.claimed.length, 1, "inject is attempted after a successful claim")
  assert.equal(daemon.acked.length, 0, "a failed inject must NEVER ack")
})

test("handleDelivery: a lost claim does NOT inject (multi-instance dedupe)", async () => {
  const { client, promptCalls } = makeClient({ ses_own: "/proj" })
  const daemon = makeFakeDaemon({ claimResult: false })

  const ok = await handleDelivery(
    { uid: "4", sessionID: "ses_own", body: "x", from: "a@b.c" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
    }
  )

  assert.equal(ok, false)
  assert.equal(daemon.claimed.length, 1, "claim is attempted")
  assert.equal(promptCalls.length, 0, "a lost claim must not inject")
  assert.equal(daemon.acked.length, 0)
})

test("handleDelivery: command=new spawns a NEW session in this directory (create+prompt+ack, no inject into A)", async () => {
  const { client, createCalls, promptCalls } = makeClient({ ses_a: "/proj" })
  const daemon = makeFakeDaemon()

  const ok = await handleDelivery(
    { uid: "5", sessionID: "ses_a", body: "修复登录 bug", from: "a@b.c", command: "new" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
      // config:null → skip the real-SMTP confirmation email in tests
      newSessionDeps: { config: null },
    }
  )

  assert.equal(ok, true)
  assert.equal(createCalls.length, 1, "a /new delivery must create a session")
  assert.deepEqual(createCalls[0], {
    body: { title: "修复登录 bug" },
    query: { directory: "/proj" },
  })
  assert.equal(promptCalls.length, 1, "the new session must receive the task as its first prompt")
  assert.equal(promptCalls[0].path.id, "ses_new_1")
  assert.deepEqual(promptCalls[0].body, {
    parts: [{ type: "text", text: buildPayload({ from: "a@b.c", body: "修复登录 bug" }) }],
  })
  assert.deepEqual(daemon.acked, [{ uid: "5", sessionID: "ses_a", instanceId: "inst-1" }])
})

test("handleDelivery: command=new on a NON-owned session is ignored (no create, no ack)", async () => {
  const { client, createCalls } = makeClient({ ses_a: "/other-proj" })
  const daemon = makeFakeDaemon()

  const ok = await handleDelivery(
    { uid: "6", sessionID: "ses_a", body: "x", from: "a@b.c", command: "new" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
      newSessionDeps: { config: null },
    }
  )

  assert.equal(ok, false)
  assert.equal(createCalls.length, 0, "a non-owned /new must not create")
  assert.equal(daemon.acked.length, 0)
})

test("handleDelivery: session.create failure does NOT ack (pending stays for retry)", async () => {
  const { client } = makeClient({ ses_a: "/proj" })
  client.session.create = async () => ({ error: { status: 400, body: "boom" } })
  const daemon = makeFakeDaemon()

  const ok = await handleDelivery(
    { uid: "7", sessionID: "ses_a", body: "x", from: "a@b.c", command: "new" },
    {
      daemonUrl: "http://daemon",
      instanceId: "inst-1",
      directory: "/proj",
      getClient: () => client,
      fetchImpl: daemon.fetchImpl,
      error: () => {},
      newSessionDeps: { config: null },
    }
  )

  assert.equal(ok, false)
  assert.equal(daemon.acked.length, 0, "a failed spawn must NEVER ack")
})

// ---------------------------------------------------------------------------
// startSubscription (SSE stream + reconnect catch-up)
// ---------------------------------------------------------------------------

test("subscription: an SSE delivery event is claimed, injected, and acked", async () => {
  const { client, promptCalls } = makeClient({ ses_own: "/proj" })
  const daemon = makeFakeDaemon()
  const stream = makeEventStream()
  daemon.setEventStream(stream)

  const stop = startSubscription({
    daemonUrl: "http://daemon",
    instanceId: "inst-1",
    directory: "/proj",
    getClient: () => client,
    fetchImpl: daemon.fetchImpl,
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
  })
  stops.push(stop)

  await daemon.eventsOpened.promise // wait for the SSE stream to be opened
  stream.pushDelivery({ uid: "8", sessionID: "ses_own", body: "go", from: "a@b.c" })

  await until(() => daemon.acked.length === 1)
  assert.deepEqual(daemon.claimed, [{ uid: "8", sessionID: "ses_own", instanceId: "inst-1" }])
  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].path.id, "ses_own")
})

test("subscription: reconnect catch-up (GET /pending) re-processes an owned pending", async () => {
  const { client, promptCalls } = makeClient({ ses_own: "/proj" })
  const pending = [{ uid: "9", sessionID: "ses_own", body: "recovered", from: "a@b.c" }]
  const daemon = makeFakeDaemon({ pending })
  daemon.setEventStream(makeEventStream())

  const stop = startSubscription({
    daemonUrl: "http://daemon",
    instanceId: "inst-1",
    directory: "/proj",
    getClient: () => client,
    fetchImpl: daemon.fetchImpl,
    reconnectBaseMs: 5,
    reconnectMaxMs: 5,
  })
  stops.push(stop)

  await until(() => daemon.acked.length === 1)
  assert.deepEqual(daemon.claimed, [{ uid: "9", sessionID: "ses_own", instanceId: "inst-1" }])
  assert.equal(promptCalls.length, 1)
  assert.equal(promptCalls[0].path.id, "ses_own")
})

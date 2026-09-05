// afk daemon mode-gate HTTP surface unit tests.
//
// Exercises the GLOBAL email-mode endpoints (added to createHttpServer) against
// a real in-process registry + pending-store + mode-store on an ephemeral port:
//   - GET  /mode    reads the current mode (default "off")
//   - POST /mode    validates "on"|"off", persists, and broadcasts a `mode` SSE
//                   event to connected clients
//   - GET  /events  SSE: sends the current mode as an initial `mode` event on
//                   connect (so a (re)connecting instance learns it)
// No IMAP/SMTP, no live opencode.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRegistry } from "../store/registry.js"
import { createPendingStore } from "../store/pending-store.js"
import { createModeStore } from "../store/mode-store.js"
import { createHttpServer } from "../daemon.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), "afk-mode-http-"))

let server
let baseUrl
let modeStore

before(async () => {
  const registry = createRegistry()
  const pendingStore = createPendingStore({ path: join(tmp, "pending.json") })
  modeStore = createModeStore({ path: join(tmp, "mode.json") })
  const built = createHttpServer(registry, pendingStore, { modeStore })
  server = built.server
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// GET /mode
// ---------------------------------------------------------------------------

test("GET /mode → {ok:true, mode:'off'} by default", async () => {
  const res = await fetch(`${baseUrl}/mode`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, mode: "off" })
})

// ---------------------------------------------------------------------------
// POST /mode
// ---------------------------------------------------------------------------

test("POST /mode {mode:'on'} → sets + persists → {ok:true, mode:'on'}", async () => {
  const res = await fetch(`${baseUrl}/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "on" }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, mode: "on" })
  assert.equal(modeStore.get(), "on", "the store must reflect the new mode")

  // Persisted: a fresh store on the SAME path reads "on" (survives restart).
  const restarted = createModeStore({ path: join(tmp, "mode.json") })
  assert.equal(restarted.get(), "on", "the mode must be persisted to disk")
})

test("POST /mode {mode:'off'} → sets + persists → {ok:true, mode:'off'}", async () => {
  const res = await fetch(`${baseUrl}/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "off" }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, mode: "off" })
  assert.equal(modeStore.get(), "off")
})

test("POST /mode with an invalid mode → 400 and the store is unchanged", async () => {
  modeStore.set("off")
  const res = await fetch(`${baseUrl}/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "banana" }),
  })
  assert.equal(res.status, 400)
  const data = await res.json()
  assert.equal(data.ok, false)
  assert.equal(modeStore.get(), "off", "an invalid mode must not change the store")
})

test("POST /mode with a missing mode → 400", async () => {
  const res = await fetch(`${baseUrl}/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
})

// ---------------------------------------------------------------------------
// SSE: initial mode event + live broadcast
// ---------------------------------------------------------------------------

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
        if (ev.event === "mode" && ev.data) queue.push(JSON.parse(ev.data))
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

test("GET /events sends the current mode as an initial `mode` event on connect", async () => {
  modeStore.set("on")
  const sse = await openSSE(`${baseUrl}/events`)
  try {
    const ev = await sse.next()
    assert.ok(ev, "connect must send an initial mode event")
    assert.deepEqual(ev, { mode: "on" })
  } finally {
    await sse.close()
  }
  modeStore.set("off")
})

test("POST /mode broadcasts a `mode` event to connected SSE clients", async () => {
  modeStore.set("off")
  const sse = await openSSE(`${baseUrl}/events`)
  try {
    // Drain the initial mode event (off).
    assert.deepEqual(await sse.next(), { mode: "off" })

    // Flip the mode via the HTTP endpoint → a live `mode` event must fire.
    const res = await fetch(`${baseUrl}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "on" }),
    })
    assert.equal(res.status, 200)

    const ev = await sse.next()
    assert.ok(ev, "a live mode broadcast must reach the connected client")
    assert.deepEqual(ev, { mode: "on" })
  } finally {
    await sse.close()
  }
  modeStore.set("off")
})

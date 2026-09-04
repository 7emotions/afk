// email-wake daemon HTTP server unit test.
//
// Exercises the daemon's HTTP surface (createHttpServer) against a real in-
// process registry + pending-store on an ephemeral port: GET /health,
// POST /register (single-outstanding guard, no serverUrl — routing is gone),
// and DELETE /register (release). This is the exact contract the plugin client
// (index.js) and the request_decision tool rely on. No IMAP/SMTP, no live
// opencode, no real mailbox.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"

import { createRegistry } from "../store/registry.js"
import { createPendingStore } from "../store/pending-store.js"
import { createHttpServer } from "../daemon.js"

let server
let baseUrl
const registry = createRegistry()
const pendingStore = createPendingStore({ path: "/tmp/email-wake-daemon-server-pending.json" })

before(async () => {
  const built = createHttpServer(registry, pendingStore)
  server = built.server
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test("GET /health → {ok:true}", async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test("POST /register stores a session → alreadyPending:false, then true on repeat", async () => {
  const first = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: "ses_http1" }),
  })
  assert.deepEqual(await first.json(), { ok: true, alreadyPending: false })

  const second = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: "ses_http1" }),
  })
  assert.deepEqual(await second.json(), { ok: true, alreadyPending: true })

  assert.equal(registry.has("ses_http1"), true, "repeat must keep the reservation (single-outstanding guard)")
})

test("POST /register with missing sessionID → 400", async () => {
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })
  assert.equal(res.status, 400)
  const data = await res.json()
  assert.equal(data.ok, false)
})

test("DELETE /register releases the session", async () => {
  await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: "ses_http3" }),
  })
  assert.equal(registry.has("ses_http3"), true)

  const del = await fetch(`${baseUrl}/register`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: "ses_http3" }),
  })
  assert.deepEqual(await del.json(), { ok: true })
  assert.equal(registry.has("ses_http3"), false)
})

test("unknown route → 404", async () => {
  const res = await fetch(`${baseUrl}/nope`)
  assert.equal(res.status, 404)
  const data = await res.json()
  assert.equal(data.ok, false)
})

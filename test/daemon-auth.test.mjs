// afk daemon HTTP auth regression tests (issue #2).
//
// Exercises the Bearer-token + Host-loopback guards added to createHttpServer:
//   - unauthenticated requests to every privileged endpoint → 401
//   - a wrong bearer token → 401
//   - the correct token → 200
//   - /health stays unauthenticated (liveness probe leaks nothing)
//   - a non-loopback Host header → 403 (DNS rebinding)
//   - registry cap → 429 when full (memory-exhaustion DoS)
// No IMAP/SMTP, no live opencode.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"

import { createRegistry } from "../store/registry.js"
import { createPendingStore } from "../store/pending-store.js"
import { createHttpServer } from "../daemon.js"

const SECRET = "test-daemon-secret"

let server
let baseUrl
let port

before(async () => {
  const registry = createRegistry()
  const pendingStore = createPendingStore({ path: "/tmp/afk-daemon-auth-pending.json" })
  const built = createHttpServer(registry, pendingStore, { secret: SECRET })
  server = built.server
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = server.address().port
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

// A raw http.request so the Host header can be forced (undici fetch forbids it).
function rawRequest({ path, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.on("error", reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

test("unauthenticated requests to every privileged endpoint return 401 (issue #2)", async () => {
  // Auth is checked BEFORE body parsing, so no body is needed to prove the 401
  // gate (and omitting it avoids the server resetting mid-body-write).
  const cases = [
    { path: "/pending" },
    { path: "/mode" },
    { path: "/mode", method: "POST" },
    { path: "/register", method: "POST" },
    { path: "/register", method: "DELETE" },
    { path: "/claim", method: "POST" },
    { path: "/ack", method: "POST" },
  ]
  for (const c of cases) {
    const res = await rawRequest(c)
    assert.equal(res.status, 401, `${c.method ?? "GET"} ${c.path} must require auth`)
  }
})

test("a wrong bearer token is rejected with 401", async () => {
  const res = await rawRequest({ path: "/mode", headers: { authorization: "Bearer wrong-token" } })
  assert.equal(res.status, 401)
})

test("the correct bearer token is accepted (200)", async () => {
  const res = await rawRequest({ path: "/mode", headers: { authorization: `Bearer ${SECRET}` } })
  assert.equal(res.status, 200)
})

test("/health is unauthenticated (liveness probe)", async () => {
  const res = await rawRequest({ path: "/health" })
  assert.equal(res.status, 200)
})

test("a non-loopback Host header is rejected with 403 (DNS rebinding)", async () => {
  const res = await rawRequest({
    path: "/mode",
    headers: { authorization: `Bearer ${SECRET}`, host: "evil.example.com" },
  })
  assert.equal(res.status, 403)
})

test("POST /register returns 429 when the registry is at its cap", async () => {
  // A fresh server with a tiny cap isolates this from the shared one above.
  const reg = createRegistry({ maxEntries: 1 })
  const pendingStore = createPendingStore({ path: "/tmp/afk-daemon-auth-cap.json" })
  const built = createHttpServer(reg, pendingStore, { secret: SECRET })
  const s = built.server
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve))
  const p = s.address().port

  const post = (sessionID) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: p,
          path: "/register",
          method: "POST",
          headers: {
            host: `127.0.0.1:${p}`,
            "content-type": "application/json",
            authorization: `Bearer ${SECRET}`,
          },
        },
        (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode))
        }
      )
      req.on("error", reject)
      req.end(JSON.stringify({ sessionID }))
    })

  assert.equal(await post("ses_a"), 200)
  assert.equal(await post("ses_b"), 429, "second session beyond the cap must be refused")
  await new Promise((resolve) => s.close(resolve))
})

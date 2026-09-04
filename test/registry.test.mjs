// email-wake daemon registry unit tests.
//
// Covers reserve/release, dedupe semantics (alreadyPending), and TTL expiry.
// Pure in-memory module — no network, no IMAP/SMTP. A fake clock is injected
// via `now` so TTL expiry is deterministic.
//
// NOTE: routing (sessionID → serverUrl) is gone in the PUSH architecture; the
// registry only enforces the single-outstanding-decision guard.

import { test } from "node:test"
import assert from "node:assert/strict"

import { createRegistry, REGISTRY_TTL_MS } from "../store/registry.js"

test("register reserves a session → alreadyPending false, then true on repeat", () => {
  const reg = createRegistry()
  const first = reg.register("ses_1")
  assert.deepEqual(first, { alreadyPending: false })
  assert.equal(reg.has("ses_1"), true)
  assert.equal(reg.size(), 1)

  const second = reg.register("ses_1")
  assert.deepEqual(second, { alreadyPending: true })
  assert.equal(reg.size(), 1, "re-register must not create a second entry")
})

test("has returns false for an unknown session", () => {
  const reg = createRegistry()
  assert.equal(reg.has("ses_unknown"), false)
})

test("release removes the entry (idempotent)", () => {
  const reg = createRegistry()
  reg.register("ses_1")
  reg.release("ses_1")
  assert.equal(reg.has("ses_1"), false)
  reg.release("ses_1") // idempotent — no throw
  assert.equal(reg.size(), 0)
})

test("TTL: an entry older than REGISTRY_TTL_MS is pruned on access", () => {
  let now = 1_000_000
  const reg = createRegistry({ now: () => now })
  reg.register("ses_old")
  assert.equal(reg.has("ses_old"), true)

  now += REGISTRY_TTL_MS + 1
  assert.equal(reg.has("ses_old"), false, "expired entry must not be served")
  assert.equal(reg.size(), 0)
})

test("TTL: a fresh entry survives; only old entries are pruned", () => {
  let now = 1_000_000
  const reg = createRegistry({ now: () => now })
  reg.register("ses_old")
  now += REGISTRY_TTL_MS - 1000
  reg.register("ses_new")
  now += 2000 // ses_old is now expired; ses_new is not

  assert.equal(reg.has("ses_old"), false)
  assert.equal(reg.has("ses_new"), true)
  assert.equal(reg.size(), 1)
})

test("TTL: re-register refreshes the expiry clock", () => {
  let now = 1_000_000
  const reg = createRegistry({ now: () => now })
  reg.register("ses_1")
  now += REGISTRY_TTL_MS - 1000 // about to expire
  reg.register("ses_1") // refresh
  now += 2000 // would have expired without the refresh

  assert.equal(reg.has("ses_1"), true, "re-register must refresh the TTL")
})

test("registry is isolated per instance (two registries do not share entries)", () => {
  const a = createRegistry()
  const b = createRegistry()
  a.register("ses_1")
  assert.equal(b.has("ses_1"), false)
})

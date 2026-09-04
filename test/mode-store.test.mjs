// email-wake mode-store unit tests.
//
// The GLOBAL email-mode gate: a durable `{ mode: "on"|"off" }` flag in mode.json.
// "off" means the human is at the screen and request_decision must refuse (the
// agent falls back to the built-in question tool); "on" means the human has left
// (/afk) and request_decision may email. Mirrors pending-store.js: a JSON file
// (mode.json, gitignored), loaded on start, written synchronously on set, with
// EMAIL_WAKE_MODE overriding the path (tests point it at a temp dir so the real
// <plugin>/mode.json is never touched).

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "email-wake-mode-"))
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// Set the env override BEFORE importing mode-store.js (mirrors the journal
// redirect pattern in negative.test.mjs) so the module's default path points at
// a throwaway temp file, never the real <plugin>/mode.json.
process.env.EMAIL_WAKE_MODE = join(tmp, "env-mode.json")

const { createModeStore, DEFAULT_MODE } = await import("../mode-store.js")

// A fresh store on a unique path (per-test isolation without cross-talk).
function makeStore(opts = {}) {
  const path = join(tmp, `mode-${Math.random().toString(36).slice(2)}.json`)
  return { store: createModeStore({ path, ...opts }), path }
}

test("DEFAULT_MODE is 'off' and a missing file yields 'off'", () => {
  assert.equal(DEFAULT_MODE, "off")
  const { store } = makeStore()
  assert.equal(store.get(), "off", "a missing mode.json must read as 'off'")
})

test("set('on') persists to disk; a NEW store on the same path re-loads 'on'", () => {
  const { store, path } = makeStore()
  store.set("on")
  assert.equal(store.get(), "on")

  // Simulate a daemon restart: a fresh store reading the SAME file sees "on".
  const restarted = createModeStore({ path })
  assert.equal(restarted.get(), "on")
})

test("set('off') → 'off'; set('on') → 'on' (round-trip)", () => {
  const { store } = makeStore()
  store.set("on")
  assert.equal(store.get(), "on")
  store.set("off")
  assert.equal(store.get(), "off")
})

test("a missing/corrupt/mis-shaped mode.json is tolerated (reads 'off')", () => {
  const corrupt = join(tmp, `corrupt-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(corrupt, "{not valid json", "utf8")
  assert.equal(createModeStore({ path: corrupt }).get(), "off", "corrupt file must read as 'off'")

  const misShaped = join(tmp, `misshaped-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(misShaped, JSON.stringify({ mode: "banana" }), "utf8")
  assert.equal(createModeStore({ path: misShaped }).get(), "off", "unknown mode value must read as 'off'")
})

test("set rejects a value that is not 'on'/'off'", () => {
  const { store } = makeStore()
  assert.throws(() => store.set("banana"), /invalid mode/)
  assert.equal(store.get(), "off", "a rejected set must not change the stored mode")
})

test("EMAIL_WAKE_MODE overrides the default path (set via createModeStore() writes there)", () => {
  const envPath = process.env.EMAIL_WAKE_MODE
  const store = createModeStore() // no explicit path → uses the env override
  store.set("on")
  assert.equal(store.get(), "on")
  assert.ok(existsSync(envPath), "createModeStore() must persist to the EMAIL_WAKE_MODE path")
})

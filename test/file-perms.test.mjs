// afk sensitive-file permission regression tests (issue #5).
//
// Proves every store that persists credentials / reply bodies / state writes its
// file with 0600 so no group/other local user can read it.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "afk-perms-"))
process.env.AFK_DAEMON_SECRET = join(tmp, "daemon-secret")

const { createPendingStore } = await import("../store/pending-store.js")
const { createModeStore } = await import("../store/mode-store.js")
const { ensureSecret } = await import("../store/secret.js")
const { ensureStateDir } = await import("../store/paths.js")

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function mode(path) {
  return statSync(path).mode & 0o777
}

test("pending-store writes 0600 (issue #5)", () => {
  const path = join(tmp, "pending.json")
  createPendingStore({ path }).add({ uid: "1", sessionID: "s", body: "secret body", from: "a@b.c" })
  assert.equal(mode(path), 0o600)
})

test("mode-store writes 0600", () => {
  const path = join(tmp, "mode.json")
  createModeStore({ path }).set("on")
  assert.equal(mode(path), 0o600)
})

test("the shared secret is created 0600 (issues #3/#5)", () => {
  ensureSecret()
  assert.equal(mode(join(tmp, "daemon-secret")), 0o600)
})

test("ensureStateDir creates the state dir 0700 (issue #12)", () => {
  ensureStateDir({ XDG_STATE_HOME: join(tmp, "state-home") })
  assert.equal(mode(join(tmp, "state-home", "opencode", "afk")), 0o700)
})

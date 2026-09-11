// afk default runtime-state path tests (issue #12).
//
// The 5 runtime-state modules — secret, mode-store, uid-cursor, pending-store,
// inject — freeze their DEFAULT file path from process.env AT IMPORT TIME: with
// no AFK_* override, each resolves under `$XDG_STATE_HOME/opencode/afk/`. This
// file proves those defaults hermetically: XDG_STATE_HOME points at a temp dir,
// every AFK_* override is deleted before import, and the real
// ~/.local/state/opencode/afk/ is never touched.
//
// Env is prepared BEFORE the dynamic imports (mirrors the "set env before
// import" pattern in mode-store.test.mjs / uid-cursor.test.mjs). node --test
// runs each file in its own worker, so this env cannot leak into other files.
//
// The store modules persist with plain writeFileSync (no mkdir), so the state
// dir is created up front with ensureStateDir() before any write assertion.
//
// No network, no IMAP/SMTP — hermetic temp dirs, injected env only.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "afk-state-paths-"))
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Env BEFORE imports: the 5 modules resolve their default path at import time.
// ---------------------------------------------------------------------------

const stateHome = join(tmp, "state-home")
process.env.XDG_STATE_HOME = stateHome

// No AFK_* override — the XDG state-dir defaults are what this file proves.
delete process.env.AFK_DAEMON_SECRET
delete process.env.AFK_MODE
delete process.env.AFK_LAST_UID
delete process.env.AFK_PENDING
delete process.env.AFK_JOURNAL

const stateRoot = join(stateHome, "opencode", "afk")

const { ensureStateDir } = await import("../store/paths.js")
const secret = await import("../store/secret.js")
const modeStore = await import("../store/mode-store.js")
const cursor = await import("../store/uid-cursor.js")
const pending = await import("../store/pending-store.js")
const inject = await import("../core/inject.js")

// The store modules write with plain writeFileSync (no mkdir), so the state
// dir must exist before any write assertion. ensureStateDir also pins 0700.
ensureStateDir({ XDG_STATE_HOME: stateHome })

// ---------------------------------------------------------------------------
// Default paths under $XDG_STATE_HOME/opencode/afk/
// ---------------------------------------------------------------------------

test("daemon-secret default path resolves under the XDG state dir", () => {
  assert.equal(secret.secretPath(), join(stateRoot, "daemon-secret"))
})

test("mode-store persists mode.json under the XDG state dir", () => {
  modeStore.createModeStore().set("on")
  assert.ok(readFileSync(join(stateRoot, "mode.json"), "utf8").includes('"on"'))
})

test("uid-cursor persists last-uid.json under the XDG state dir", () => {
  cursor.initCursor(1, "v1")
  assert.equal(existsSync(join(stateRoot, "last-uid.json")), true)
})

test("pending-store persists pending.json under the XDG state dir", () => {
  pending.createPendingStore().add({ uid: "1", sessionID: "s", body: "b", from: "a@b.c" })
  assert.equal(existsSync(join(stateRoot, "pending.json")), true)
})

test("journal persists journal.json under the XDG state dir", async () => {
  await inject.markSeenAndJournal(null, "INBOX", "123")
  assert.ok(readFileSync(join(stateRoot, "journal.json"), "utf8").includes("123"))
})

test("the XDG state dir is created with mode 0700", () => {
  assert.equal(statSync(stateRoot).mode & 0o777, 0o700)
})

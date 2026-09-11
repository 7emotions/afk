// afk runtime-state path unit tests (issue #12).
//
// stateDir/statePath/ensureStateDir resolve the stable XDG state dir that
// survives `opencode-afk@latest` reinstalls. migrateLegacyState is the
// one-shot, non-clobbering, atomic copy of the 5 legacy runtime files.
//
// The migration tests must control BOTH sides — the legacy source layout AND
// the target state dir — so they copy store/paths.js into a temp "store" dir
// and import THAT copy: the module's __dirname then points at the temp
// legacy layout, and the repo's real runtime files are never touched.
//
// No network, no IMAP/SMTP — hermetic temp dirs, injected env only.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { stateDir, statePath, ensureStateDir } from "../store/paths.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

const tmp = mkdtempSync(join(tmpdir(), "afk-paths-"))
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// stateDir / statePath / ensureStateDir — pure path resolution
// ---------------------------------------------------------------------------

test("stateDir({}) falls back to ~/.local/state/opencode/afk", () => {
  assert.ok(stateDir({}).endsWith(join(".local", "state", "opencode", "afk")))
})

test("stateDir honors XDG_STATE_HOME", () => {
  assert.equal(stateDir({ XDG_STATE_HOME: "/x" }), "/x/opencode/afk")
})

test("stateDir honors HOME when XDG_STATE_HOME is unset", () => {
  assert.equal(stateDir({ HOME: "/h" }), "/h/.local/state/opencode/afk")
})

test("statePath joins the state dir with the file name", () => {
  assert.equal(statePath({ XDG_STATE_HOME: "/x" }, "mode.json"), "/x/opencode/afk/mode.json")
})

test("ensureStateDir creates the state dir 0700 and is idempotent", () => {
  const base = join(tmp, `ens-${Math.random().toString(36).slice(2)}`)
  ensureStateDir({ XDG_STATE_HOME: base })
  ensureStateDir({ XDG_STATE_HOME: base }) // second call must not throw
  assert.equal(statSync(join(base, "opencode", "afk")).mode & 0o777, 0o700)
})

test("ensureStateDir chmods an EXISTING dir to 0700 (FIX #2)", () => {
  const base = join(tmp, `ens-${Math.random().toString(36).slice(2)}`)
  const dir = join(base, "opencode", "afk")
  mkdirSync(dir, { recursive: true, mode: 0o755 }) // pre-existing, looser perms
  ensureStateDir({ XDG_STATE_HOME: base })
  assert.equal(statSync(dir).mode & 0o777, 0o700, "existing dir must be tightened to 0700")
})

// ---------------------------------------------------------------------------
// migrateLegacyState — hermetic fixture (see header comment)
// ---------------------------------------------------------------------------

const legacyRoot = join(tmp, "legacy")
const legacyStore = join(legacyRoot, "store")
const legacyCore = join(legacyRoot, "core")
mkdirSync(legacyStore, { recursive: true })
mkdirSync(legacyCore, { recursive: true })

// Copy as paths.mjs: outside package.json's "type":"module" scope, a .js copy
// would be treated as CommonJS (Node < 22.7) and the import below would fail.
copyFileSync(join(__dirname, "..", "store", "paths.js"), join(legacyStore, "paths.mjs"))

// Import the copy so its __dirname == legacyStore.
const paths = await import(pathToFileURL(join(legacyStore, "paths.mjs")).href)

const LEGACY = {
  "daemon-secret": "SECRET-1",
  "mode.json": '{"mode":"on"}',
  "last-uid.json": '{"uidValidity":"v1","lastUid":42}',
  "pending.json": "[]",
  "journal.json": '["1"]',
}

function seedLegacy() {
  for (const name of ["daemon-secret", "mode.json", "last-uid.json", "pending.json"]) {
    writeFileSync(join(legacyStore, name), LEGACY[name])
  }
  writeFileSync(join(legacyCore, "journal.json"), LEGACY["journal.json"])
}

function freshState() {
  return join(tmp, `state-${Math.random().toString(36).slice(2)}`)
}

function migratedDir(stateRoot) {
  return join(stateRoot, "opencode", "afk")
}

test("migrateLegacyState copies all 5 files verbatim, 0600 files under a 0700 dir", () => {
  const stateRoot = freshState()
  seedLegacy()
  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot })
  const dir = migratedDir(stateRoot)
  assert.equal(statSync(dir).mode & 0o777, 0o700, "state dir must be 0700")
  for (const [name, content] of Object.entries(LEGACY)) {
    const p = join(dir, name)
    assert.equal(readFileSync(p, "utf8"), content, `${name} content must match`)
    assert.equal(statSync(p).mode & 0o777, 0o600, `${name} must be 0600`)
  }
})

test("migrateLegacyState is idempotent — a second run is a no-op", () => {
  const stateRoot = freshState()
  seedLegacy()
  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot })
  const dir = migratedDir(stateRoot)
  const before = Object.fromEntries(
    Object.keys(LEGACY).map((name) => [name, readFileSync(join(dir, name), "utf8")])
  )
  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot })
  const second = Object.fromEntries(
    Object.keys(LEGACY).map((name) => [name, readFileSync(join(dir, name), "utf8")])
  )
  assert.deepEqual(second, before, "second migration must not change anything")
})

test("migrateLegacyState never overwrites an existing target (non-clobber)", () => {
  const stateRoot = freshState()
  seedLegacy()
  // Pre-create the target with NEWER content than the legacy source.
  const dir = migratedDir(stateRoot)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "daemon-secret"), "NEW")
  writeFileSync(join(legacyStore, "daemon-secret"), "OLD")
  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot })
  assert.equal(readFileSync(join(dir, "daemon-secret"), "utf8"), "NEW", "existing target wins")
  // The remaining 4 still migrate normally.
  assert.equal(readFileSync(join(dir, "mode.json"), "utf8"), LEGACY["mode.json"])
})

test("an AFK_* override skips that file (AFK_MODE → no mode.json in the state dir)", () => {
  const stateRoot = freshState()
  seedLegacy()
  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot, AFK_MODE: "/tmp/x-mode.json" })
  const dir = migratedDir(stateRoot)
  assert.equal(existsSync(join(dir, "mode.json")), false, "mode.json must be skipped")
  // The other 4 may still migrate.
  for (const name of ["daemon-secret", "last-uid.json", "pending.json", "journal.json"]) {
    assert.equal(readFileSync(join(dir, name), "utf8"), LEGACY[name], `${name} must migrate`)
  }
})

test("an EMPTY AFK_* override does NOT skip migration (FIX #5)", () => {
  const stateRoot = freshState()
  seedLegacy()
  // AFK_MODE="" is falsy — consumers fall back to the state-dir default, so
  // the legacy file must still be migrated.
  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot, AFK_MODE: "" })
  const dir = migratedDir(stateRoot)
  assert.equal(readFileSync(join(dir, "mode.json"), "utf8"), LEGACY["mode.json"], "empty override must not skip")
})

test("migrateLegacyState(env, legacyStoreDir) migrates from an explicit legacy dir (FIX #1)", () => {
  const stateRoot = freshState()
  // A second legacy layout, independent of the module copy's __dirname.
  const root = join(tmp, `legacy2-${Math.random().toString(36).slice(2)}`)
  const explicitStore = join(root, "store")
  const explicitCore = join(root, "core")
  mkdirSync(explicitStore, { recursive: true })
  mkdirSync(explicitCore, { recursive: true })
  for (const name of ["daemon-secret", "mode.json", "last-uid.json", "pending.json"]) {
    writeFileSync(join(explicitStore, name), LEGACY[name])
  }
  writeFileSync(join(explicitCore, "journal.json"), LEGACY["journal.json"])

  paths.migrateLegacyState({ XDG_STATE_HOME: stateRoot }, explicitStore)
  const dir = migratedDir(stateRoot)
  for (const [name, content] of Object.entries(LEGACY)) {
    assert.equal(readFileSync(join(dir, name), "utf8"), content, `${name} must migrate from explicit dir`)
  }
})

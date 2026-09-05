// afk config tuning unit tests.
//
// Proves the tuning block is (a) optional with the CURRENT values as defaults
// and (b) overridable per-field via `raw.tuning`. The current values must match
// the historic hardcoded constants so behavior is unchanged unless overridden:
//   claimTtlMs      60_000   (pending-store.js CLAIM_TTL_MS)
//   reconnectBaseMs   1_000  (subscribe.js  DEFAULT_RECONNECT_BASE_MS)
//   reconnectMaxMs   30_000  (subscribe.js  DEFAULT_RECONNECT_MAX_MS)
//   idleRenewMs  1_500_000   (watcher.js   IDLE_RENEW_MS = 25*60*1000)
//   autoIdleDelayMs   1_000  (watcher.js   AUTO_IDLE_DELAY_MS)
//   backoffInitialMs  1_000  (watcher.js   BACKOFF_INITIAL_MS)
//   backoffMaxMs     60_000  (watcher.js   BACKOFF_MAX_MS)
//
// No network, no IMAP/SMTP — hermetic temp config files, empty env (so the
// real process env can never leak AFK_* overrides into the assertions).

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig, DEFAULT_TUNING } from "../config.js"

const tmp = mkdtempSync(join(tmpdir(), "afk-config-"))
after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// Write a config file to a unique temp path and load it with an EMPTY env (so
// the ambient process env cannot override anything).
function load({ tuning, extra = {} } = {}) {
  const path = join(tmp, `config-${Math.random().toString(36).slice(2)}.json`)
  const raw = {
    imap: { host: "imap.qq.com", port: 993, secure: true, user: "u@qq.com", password: "p" },
    smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "u@qq.com", password: "p" },
    ...extra,
  }
  if (tuning !== undefined) raw.tuning = tuning
  writeFileSync(path, JSON.stringify(raw), "utf8")
  return loadConfig({ path, env: {} })
}

test("DEFAULT_TUNING matches the historic hardcoded constants (unchanged behavior)", () => {
  assert.deepEqual(DEFAULT_TUNING, {
    claimTtlMs: 60_000,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30_000,
    idleRenewMs: 1_500_000,
    autoIdleDelayMs: 1000,
    backoffInitialMs: 1000,
    backoffMaxMs: 60_000,
  })
})

test("loadConfig without a tuning block exposes config.tuning === defaults", () => {
  const config = load()
  assert.deepEqual(config.tuning, DEFAULT_TUNING)
})

test("loadConfig merges a partial tuning override over the defaults", () => {
  const config = load({ tuning: { claimTtlMs: 5_000, backoffMaxMs: 120_000 } })
  assert.equal(config.tuning.claimTtlMs, 5_000)
  assert.equal(config.tuning.backoffMaxMs, 120_000)
  // Unmentioned fields keep their defaults.
  assert.equal(config.tuning.reconnectBaseMs, DEFAULT_TUNING.reconnectBaseMs)
  assert.equal(config.tuning.reconnectMaxMs, DEFAULT_TUNING.reconnectMaxMs)
  assert.equal(config.tuning.idleRenewMs, DEFAULT_TUNING.idleRenewMs)
  assert.equal(config.tuning.autoIdleDelayMs, DEFAULT_TUNING.autoIdleDelayMs)
  assert.equal(config.tuning.backoffInitialMs, DEFAULT_TUNING.backoffInitialMs)
})

test("loadConfig with an empty tuning object yields pure defaults", () => {
  const config = load({ tuning: {} })
  assert.deepEqual(config.tuning, DEFAULT_TUNING)
})

test("redact (config.toJSON) includes the tuning block without leaking credentials", () => {
  const config = load({ tuning: { claimTtlMs: 7_000 } })
  const serialized = JSON.parse(JSON.stringify(config))
  assert.deepEqual(serialized.tuning.claimTtlMs, 7_000)
  assert.equal(serialized.imap.password, "***", "password must be masked in the serialized form")
  assert.equal(serialized.smtp.password, "***")
})

// ---------------------------------------------------------------------------
// Config path resolution chain
// ---------------------------------------------------------------------------

function writeValidConfig(path, user = "u@qq.com") {
  writeFileSync(
    path,
    JSON.stringify({
      imap: { host: "imap.qq.com", port: 993, secure: true, user, password: "p" },
      smtp: { host: "smtp.qq.com", port: 465, secure: true, user, password: "p" },
    }),
    "utf8"
  )
}

function mkOpencodeDir() {
  const dir = join(tmp, `opencode-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

test("user-level ~/.config/opencode/afk.json wins over the plugin-dir default", () => {
  const opencodeDir = mkOpencodeDir()
  const userPath = join(opencodeDir, "afk.json")
  writeValidConfig(userPath, "user-level@qq.com")
  const config = loadConfig({ env: { OPENCODE_CONFIG_DIR: opencodeDir } })
  assert.equal(config.imap.user, "user-level@qq.com")
})

test("AFK_CONFIG overrides the user-level config", () => {
  const opencodeDir = mkOpencodeDir()
  writeValidConfig(join(opencodeDir, "afk.json"), "user-level@qq.com")
  const envPath = join(tmp, `config-${Math.random().toString(36).slice(2)}.json`)
  writeValidConfig(envPath, "env-override@qq.com")
  const config = loadConfig({
    env: { OPENCODE_CONFIG_DIR: opencodeDir, AFK_CONFIG: envPath },
  })
  assert.equal(config.imap.user, "env-override@qq.com")
})

test("no user-level config -> falls back to the plugin-dir default (missing -> ENOENT error)", () => {
  const opencodeDir = mkOpencodeDir() // dir exists but has no afk.json
  // The repo's own plugin dir has no config.json (gitignored), so the fallback
  // hits DEFAULT_CONFIG_PATH and fails to read — proving the user-level file
  // was NOT picked and the legacy plugin-dir default was used.
  assert.throws(
    () => loadConfig({ env: { OPENCODE_CONFIG_DIR: opencodeDir } }),
    /failed to read config file/
  )
})

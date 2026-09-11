// afk runtime-state paths — stable XDG state dir (issue #12).
//
// Resolves every runtime-state file (daemon secret, mode, last-uid cursor,
// pending queue, journal) under ONE stable XDG user directory:
//
//   $XDG_STATE_HOME || ~/.local/state  +  /opencode/afk/
//
// Unlike the plugin dir, the state dir survives `opencode-afk@latest`
// reinstalls (npm refreshes the plugin into a fresh cache dir on every
// update). `migrateLegacyState()` is a one-shot, non-clobbering copy of the
// 5 legacy files from their old plugin-dir locations into the state dir.

import { homedir } from "node:os"
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, chmodSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state")
  return join(base, "opencode", "afk")
}

export function statePath(env = process.env, name) {
  return join(stateDir(env), name)
}

// FIX #2: mkdirSync's `mode` only applies to a NEWLY-created directory; an
// already-existing dir (e.g. 0755) is not tightened. chmod it explicitly so the
// dir holding the shared secret is always owner-only (0700).
export function ensureStateDir(env = process.env) {
  const dir = stateDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

const LEGACY_FILES = [
  { rel: "daemon-secret", name: "daemon-secret", envKey: "AFK_DAEMON_SECRET" },
  { rel: "mode.json", name: "mode.json", envKey: "AFK_MODE" },
  { rel: "last-uid.json", name: "last-uid.json", envKey: "AFK_LAST_UID" },
  { rel: "pending.json", name: "pending.json", envKey: "AFK_PENDING" },
  { rel: join("..", "core", "journal.json"), name: "journal.json", envKey: "AFK_JOURNAL" },
]

// One-shot, non-clobbering, atomic migration of the 5 legacy runtime files into
// the XDG state dir.
//
// FIX #1: `legacyStoreDir` (default = this module's store/ dir) lets the caller
// (install.js) point migration at a DIFFERENT legacy location — e.g. the old
// plugin dir's store/ BEFORE install.js `rmSync`s it.
//
// FIX #5: an override is skipped only when it is NON-EMPTY (`if (env[envKey])`),
// matching the consumers' `process.env.AFK_X || statePath(...)` truthiness — so
// `AFK_MODE=""` no longer skips migration while the consumer reads the default.
//
// FIX #3: atomic publish via write-temp + linkSync (hard-link is atomic, and
// fails EEXIST if the destination exists) instead of copyFileSync — a concurrent
// reader can never observe a half-written file.
export function migrateLegacyState(env = process.env, legacyStoreDir = __dirname) {
  ensureStateDir(env)
  for (const { rel, name, envKey } of LEGACY_FILES) {
    if (env[envKey]) continue
    const src = join(legacyStoreDir, rel)
    const dst = statePath(env, name)
    let content
    try {
      content = readFileSync(src)
    } catch (err) {
      if (err && err.code === "ENOENT") continue // no legacy file to migrate
      throw err
    }
    const tmp = `${dst}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    try {
      writeFileSync(tmp, content, { mode: 0o600 })
      linkSync(tmp, dst) // atomic publish; EEXIST if dst already exists
    } catch (err) {
      if (err && err.code === "EEXIST") continue // target exists — never overwrite
      throw err
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* tmp may not exist (write failed) or was already linked */
      }
    }
  }
}

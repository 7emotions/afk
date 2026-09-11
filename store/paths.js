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
import { mkdirSync, copyFileSync, chmodSync, constants } from "node:fs"
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

export function ensureStateDir(env = process.env) {
  mkdirSync(stateDir(env), { recursive: true, mode: 0o700 })
}

// The 5 runtime-state files. legacyPath() resolves the CURRENT (legacy)
// location: the 4 store files live in store/, journal.json lives in core/.
// name is the target filename under the state dir (journal is NOT nested
// under stateDir/core/ — it goes to stateDir/journal.json).
const LEGACY_FILES = [
  { legacy: () => join(__dirname, "daemon-secret"), name: "daemon-secret", envKey: "AFK_DAEMON_SECRET" },
  { legacy: () => join(__dirname, "mode.json"), name: "mode.json", envKey: "AFK_MODE" },
  { legacy: () => join(__dirname, "last-uid.json"), name: "last-uid.json", envKey: "AFK_LAST_UID" },
  { legacy: () => join(__dirname, "pending.json"), name: "pending.json", envKey: "AFK_PENDING" },
  { legacy: () => join(__dirname, "..", "core", "journal.json"), name: "journal.json", envKey: "AFK_JOURNAL" },
]

export function migrateLegacyState(env = process.env) {
  ensureStateDir(env)
  for (const { legacy, name, envKey } of LEGACY_FILES) {
    if (env[envKey] !== undefined) continue // user set an explicit override — leave state dir alone
    const src = legacy()
    const dst = statePath(env, name)
    try {
      copyFileSync(src, dst, constants.COPYFILE_EXCL) // atomic: fail if target exists
      chmodSync(dst, 0o600)
    } catch (err) {
      // EEXIST = target already exists (skip, never overwrite — avoids split-brain)
      // ENOENT = no legacy file to migrate (fresh install — skip)
      if (err && (err.code === "EEXIST" || err.code === "ENOENT")) continue
      throw err
    }
  }
}

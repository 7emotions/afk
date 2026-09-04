// email-wake mode-store — durable GLOBAL email-mode gate (daemon-side).
//
// A single `{ mode: "on"|"off" }` flag that decides whether request_decision
// may email the human. "on" means the human has left the screen (/afk) and
// request_decision may email; "off" means the human is at the screen and
// request_decision must refuse (the agent falls back to opencode's built-in
// question tool instead). The mode is GLOBAL — one mode.json per machine, NOT
// per-session or per-directory — because the human is either at the screen or
// not, regardless of how many instances/sessions are running.
//
// Persistence: a JSON file (mode.json, gitignored — mirrors journal.json /
// last-uid.json / pending.json). Loaded on start; written synchronously on every
// set. Missing/corrupt/mis-shaped → the default "off" (safe: never email until
// the human explicitly opts in via /afk).
//
// EMAIL_WAKE_MODE overrides the path (mirrors EMAIL_WAKE_JOURNAL /
// EMAIL_WAKE_LAST_UID / EMAIL_WAKE_PENDING; tests use it to keep the real file
// clean).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Mode path: <plugin dir>/mode.json by default. EMAIL_WAKE_MODE overrides it.
const MODE_PATH =
  process.env.EMAIL_WAKE_MODE ||
  join(dirname(fileURLToPath(import.meta.url)), "mode.json")

// The safe default: refuse to email until the human opts in.
export const DEFAULT_MODE = "off"

// Tolerantly load the persisted mode. Missing/corrupt/mis-shaped → DEFAULT_MODE.
function load(path) {
  try {
    if (!existsSync(path)) return DEFAULT_MODE
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && (parsed.mode === "on" || parsed.mode === "off")) return parsed.mode
    return DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

/**
 * Create the durable global mode store.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]  JSON file path (default mode.json next to this module).
 * @returns {{get: () => string, set: (mode: string) => string}}
 */
export function createModeStore(opts = {}) {
  const path = opts.path ?? MODE_PATH

  let mode = load(path)

  function persist() {
    writeFileSync(path, JSON.stringify({ mode }, null, 2) + "\n", "utf8")
  }

  return {
    /** The current mode ("on"|"off"). */
    get() {
      return mode
    },

    /**
     * Set the mode. Validates "on"|"off" (throws otherwise) and persists
     * synchronously so the change survives a daemon restart.
     * @returns {string} the new mode.
     */
    set(next) {
      if (next !== "on" && next !== "off") {
        throw new Error(`invalid mode: ${next}`)
      }
      mode = next
      persist()
      return mode
    },
  }
}

export default createModeStore

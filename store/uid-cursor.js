// afk UID cursor — detection state.
//
// A persistent "highest processed UID" cursor. Detection no longer depends on
// `\Seen` (the human's mail client may mark a reply \Seen BEFORE the daemon
// scans, hiding it from an UNSEEN search) nor on SUBJECT indexing (which lags
// ~15s on QQ). Instead the daemon scans UIDs GREATER than this cursor — a small
// incremental window of only new mail since the last scan — and advances the
// cursor past the highest UID it has SEEN, processed or not (so a self-copy or
// non-token mail can never wedge the cursor). On a fresh start the cursor is
// initialized to the mailbox's current highest UID (uidNext - 1) so history is
// never reprocessed.
//
// Stored as `{ uidValidity, lastUid }` in a small JSON file (gitignored).
// uidValidity guards against a mailbox recreate resetting UIDs: if the stored
// uidValidity no longer matches the mailbox, the cursor is treated as
// uninitialized and re-anchored to the current max UID.
//
// No IMAP, no network — pure fs. Mirrors inject.js's journal convention
// (AFK_LAST_UID env override, in-memory cache, tolerant read).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Cursor path: <plugin dir>/last-uid.json by default. AFK_LAST_UID
// overrides it (mirrors the AFK_JOURNAL convention; tests use it to keep
// the real cursor clean).
const CURSOR_PATH =
  process.env.AFK_LAST_UID ||
  join(dirname(fileURLToPath(import.meta.url)), "last-uid.json")

// In-memory cache. null = "not loaded yet" (or no persisted value).
let cursorCache = null

// Normalize a UIDVALIDITY value to the string form we persist and compare.
function normValidity(uidValidity) {
  return String(uidValidity ?? "")
}

// Read the persisted cursor. A missing/corrupt/mis-shaped file is treated as
// uninitialized (null) — start fresh.
function readPersisted() {
  try {
    if (!existsSync(CURSOR_PATH)) return null
    const parsed = JSON.parse(readFileSync(CURSOR_PATH, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const lastUid = Number(parsed.lastUid)
    if (!Number.isInteger(lastUid) || lastUid < 0) return null
    return { uidValidity: normValidity(parsed.uidValidity), lastUid }
  } catch {
    return null
  }
}

function load() {
  if (cursorCache === null) cursorCache = readPersisted()
  return cursorCache
}

function write(state) {
  cursorCache = state
  writeFileSync(CURSOR_PATH, JSON.stringify(state, null, 2) + "\n", "utf8")
}

// Monotonic set: anchor or advance the cursor to `lastUid` for `uidValidity`.
// Within the same uidValidity the cursor only ever moves FORWARD; a new
// uidValidity resets the anchor.
function setCursor(lastUid, uidValidity) {
  const cur = load()
  const v = normValidity(uidValidity)
  const n = Number(lastUid)
  const value = Number.isInteger(n) && n >= 0 ? n : 0
  if (cur && cur.uidValidity === v) {
    write({ uidValidity: v, lastUid: Math.max(cur.lastUid, value) })
  } else {
    write({ uidValidity: v, lastUid: value })
  }
}

/**
 * The current cursor's lastUid, or null when uninitialized (no persisted value,
 * OR the persisted uidValidity differs from the mailbox's current uidValidity —
 * a mailbox recreate reset UIDs, so the cursor must re-anchor).
 *
 * @param {string|bigint} uidValidity  The mailbox's current UIDVALIDITY.
 * @returns {number|null}
 */
export function getCursor(uidValidity) {
  const cur = load()
  if (!cur) return null
  if (cur.uidValidity !== normValidity(uidValidity)) return null
  return cur.lastUid
}

/**
 * Anchor the cursor on a fresh start (no existing cursor for this uidValidity).
 * Idempotent/monotonic: never moves an existing cursor backward.
 * @param {number} lastUid
 * @param {string|bigint} uidValidity
 */
export function initCursor(lastUid, uidValidity) {
  setCursor(lastUid, uidValidity)
}

/**
 * Advance the cursor to `lastUid` (monotonic within the same uidValidity).
 * @param {number} lastUid
 * @param {string|bigint} uidValidity
 */
export function advanceCursor(lastUid, uidValidity) {
  setCursor(lastUid, uidValidity)
}

/**
 * Clear the in-memory cache (tests). Does NOT touch the file.
 */
export function resetCursor() {
  cursorCache = null
}

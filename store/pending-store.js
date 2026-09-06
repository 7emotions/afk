// afk pending-store — durable pending deliveries (daemon-side).
//
// The durable half of the P0 fix. After the daemon parses a reply it does NOT
// mark \Seen and does NOT inject (cross-process HTTP injection is silently
// dropped by opencode). Instead it persists the reply HERE — on disk — keyed by
// UID, and broadcasts it over SSE. The owning plugin instance claims it, injects
// it IN-PROCESS, and acks it; only the ack marks \Seen + journals + removes the
// pending. If the daemon crashes between parse and ack, the entry survives on
// disk and is re-broadcast on the next instance connect — no message loss.
//
// Each entry: { uid, sessionID, body, from, command?, queuedAt, claimedBy?, claimedAt? }.
//   - uid       : IMAP UID (primary key — one message = one UID = one session).
//   - sessionID : the ROOT session this reply routes to (from the [omo:] token).
//   - body/from : the parsed reply payload.
//   - command   : "new" when the reply is a "/new <task>" new-session request
//                 (the owning instance spawns a session instead of injecting).
//   - queuedAt  : when it was persisted.
//   - claimedBy : the instanceId that currently holds the claim (undefined when
//                 unclaimed). Multi-instance dedupe: first claimant wins.
//   - claimedAt : claim timestamp — used to steal a STALE claim (a claimant that
//                 crashed before acking must not wedge the entry forever).
//
// Persistence: a JSON file (pending.json, gitignored — mirrors journal.json /
// last-uid.json). Loaded on start; written synchronously on every mutation.
//
// UID normalisation: every UID is stored/compared as a string. This keeps the
// journal (inject.js) and this store consistent regardless of whether the UID
// arrived as a number (IMAP search) or a string (JSON over HTTP).

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

// Pending path: <plugin dir>/pending.json by default. AFK_PENDING
// overrides it (mirrors the AFK_JOURNAL / AFK_LAST_UID convention;
// tests use it to keep the real file clean).
const PENDING_PATH =
  process.env.AFK_PENDING ||
  join(dirname(fileURLToPath(import.meta.url)), "pending.json")

// How long a claim stays authoritative before another instance may steal it.
// In-process injection + ack completes in milliseconds, so 60s is generous for
// the happy path yet short enough that a crashed claimant recovers promptly.
export const CLAIM_TTL_MS = 60_000

// Tolerantly load the persisted pending file. Missing/corrupt/mis-shaped → empty.
function load(path) {
  const map = new Map()
  let parsed
  try {
    if (!existsSync(path)) return map
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return map
  }
  if (!Array.isArray(parsed)) return map
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue
    const uid = entry.uid != null ? String(entry.uid) : ""
    if (!uid) continue
    map.set(uid, {
      uid,
      sessionID: typeof entry.sessionID === "string" ? entry.sessionID : "",
      body: typeof entry.body === "string" ? entry.body : "",
      from: typeof entry.from === "string" ? entry.from : "",
      command: entry.command === "new" ? "new" : undefined,
      queuedAt: typeof entry.queuedAt === "number" ? entry.queuedAt : 0,
      claimedBy: typeof entry.claimedBy === "string" && entry.claimedBy ? entry.claimedBy : undefined,
      claimedAt: typeof entry.claimedAt === "number" ? entry.claimedAt : undefined,
    })
  }
  return map
}

// A plain-object snapshot of an entry (never leak the internal reference).
function toEntry(entry) {
  return {
    uid: entry.uid,
    sessionID: entry.sessionID,
    body: entry.body,
    from: entry.from,
    command: entry.command === "new" ? "new" : undefined,
    queuedAt: entry.queuedAt,
    claimedBy: entry.claimedBy,
    claimedAt: entry.claimedAt,
  }
}

/**
 * Create a durable pending store.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]        JSON file path (default pending.json next to this module).
 * @param {number} [opts.claimTtlMs]  Claim staleness window (default CLAIM_TTL_MS).
 * @param {() => number} [opts.now]   Clock (default Date.now; tests inject one).
 * @returns {{add, list, listClaimable, get, claim, canAck, remove, size, reset}}
 */
export function createPendingStore(opts = {}) {
  const path = opts.path ?? PENDING_PATH
  const now = opts.now ?? (() => Date.now())
  const claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS

  const items = load(path)

  function persist() {
    writeFileSync(path, JSON.stringify([...items.values()], null, 2) + "\n", "utf8")
  }

  // True when a claim is held by a different instance but is old enough to steal.
  function isStale(entry) {
    return (
      entry.claimedBy !== undefined &&
      entry.claimedAt != null &&
      now() - entry.claimedAt > claimTtlMs
    )
  }

  return {
    /**
     * Persist (or recognise) a pending reply, keyed by UID. Idempotent: re-adding
     * the same UID returns `{ created: false }` so callers can skip a duplicate
     * SSE broadcast.
     * @returns {{created: boolean, entry: object}}
     */
    add({ uid, sessionID, body, from, command }) {
      const key = String(uid)
      const existing = items.get(key)
      if (existing) return { created: false, entry: toEntry(existing) }
      const entry = {
        uid: key,
        sessionID,
        body,
        from,
        command: command === "new" ? "new" : undefined,
        queuedAt: now(),
        claimedBy: undefined,
        claimedAt: undefined,
      }
      items.set(key, entry)
      persist()
      return { created: true, entry: toEntry(entry) }
    },

    /** All pending entries (snapshots). */
    list() {
      return [...items.values()].map(toEntry)
    },

    /** Pending entries that may be (re)broadcast: unclaimed OR stale-claimed. */
    listClaimable() {
      return [...items.values()].filter((e) => e.claimedBy === undefined || isStale(e)).map(toEntry)
    },

    /** One entry by UID (snapshot), or null. */
    get(uid) {
      const entry = items.get(String(uid))
      return entry ? toEntry(entry) : null
    },

    /**
     * Atomically claim a pending for an instance. First claimant wins.
     * @returns {{claimed: boolean, missing?: boolean, mismatch?: boolean}}
     */
    claim({ uid, sessionID, instanceId }) {
      const entry = items.get(String(uid))
      if (!entry) return { claimed: false, missing: true }
      if (entry.sessionID !== sessionID) return { claimed: false, mismatch: true }
      if (entry.claimedBy === undefined) {
        entry.claimedBy = instanceId
        entry.claimedAt = now()
        persist()
        return { claimed: true }
      }
      if (entry.claimedBy === instanceId) return { claimed: true } // idempotent
      if (isStale(entry)) {
        entry.claimedBy = instanceId
        entry.claimedAt = now()
        persist()
        return { claimed: true }
      }
      return { claimed: false }
    },

    /** True iff `instanceId` currently holds the claim on this pending. */
    canAck({ uid, sessionID, instanceId }) {
      const entry = items.get(String(uid))
      if (!entry) return false
      if (entry.sessionID !== sessionID) return false
      return entry.claimedBy === instanceId
    },

    /** Remove a pending entry (idempotent). Persists. */
    remove(uid) {
      items.delete(String(uid))
      persist()
    },

    /** Number of live pending entries. */
    size() {
      return items.size
    },

    /** Clear all entries and persist the empty state (tests). */
    reset() {
      items.clear()
      persist()
    },
  }
}

export default createPendingStore

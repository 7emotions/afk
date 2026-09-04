// email-wake daemon registry.
//
// The single-watcher daemon is the ONE decision-maker for a shared mailbox. This
// module is its in-memory guard for the single-outstanding-decision rule: it
// tracks which ROOT sessionIDs currently have a decision outstanding.
//
//   register(sessionID) → { alreadyPending }
//       Reserves the slot (or refreshes an existing reservation's TTL).
//       `alreadyPending` is true iff the sessionID was ALREADY registered — this
//       is the single-outstanding-decision guard: request_decision consults it
//       BEFORE sending, so a second ask for the same session never mails twice.
//   release(sessionID)
//       Remove the reservation (after a reply is acked, or on SMTP-send
//       failure). Idempotent.
//   has(sessionID) / size()
//
// NOTE (PUSH architecture): routing is GONE. In the old design the registry
// mapped sessionID → the owning instance's serverUrl so the daemon could
// HTTP-inject a reply into the right instance. Injection no longer routes by
// serverUrl: the daemon broadcasts the reply over SSE to every connected
// instance, and each instance self-checks ownership (via session.directory) and
// claims it. The registry only enforces ONE-outstanding-decision-per-session.
//
// TTL: entries older than REGISTRY_TTL_MS are pruned lazily (on any access), so
// a decision from a dead instance cannot linger forever. The registry is
// intentionally in-memory (per the daemon's single-process lifetime): a daemon
// restart drops pending registrations — the daemon is long-lived and this is a
// documented tradeoff, not a leak. (A reply that arrives while its reservation
// was dropped is still delivered — the pending-store is keyed by the reply's own
// UID, not by the registry.)

// 24h — decisions from dead instances must not linger forever.
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Create an in-memory single-outstanding-decision registry.
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]  Entry TTL (default REGISTRY_TTL_MS).
 * @param {() => number} [opts.now]  Clock (default Date.now; tests inject one).
 * @returns {{register, release, has, size}}
 */
export function createRegistry(opts = {}) {
  const ttlMs = opts.ttlMs ?? REGISTRY_TTL_MS
  const now = opts.now ?? (() => Date.now())

  // sessionID → { addedAt }
  const entries = new Map()

  // Drop expired entries. Called lazily on every access so a dead entry can
  // never be served after its TTL, regardless of access patterns.
  function prune() {
    const cutoff = now() - ttlMs
    for (const [sessionID, entry] of entries) {
      if (entry.addedAt < cutoff) entries.delete(sessionID)
    }
  }

  return {
    /**
     * Register (or re-register) a session's outstanding decision.
     * @param {string} sessionID
     * @returns {{alreadyPending: boolean}} true iff the session was already present.
     */
    register(sessionID) {
      prune()
      const existing = entries.get(sessionID)
      if (existing) {
        existing.addedAt = now()
        return { alreadyPending: true }
      }
      entries.set(sessionID, { addedAt: now() })
      return { alreadyPending: false }
    },

    /** Remove an entry (idempotent). */
    release(sessionID) {
      entries.delete(sessionID)
    },

    /** @returns {boolean} */
    has(sessionID) {
      prune()
      return entries.has(sessionID)
    },

    /** @returns {number} Number of live (non-expired) entries. */
    size() {
      prune()
      return entries.size
    },
  }
}

export default createRegistry

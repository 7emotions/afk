// afk shared secret — the one credential both the plugin and the daemon trust.
//
// A single random 256-bit secret lives in a 0600 file next to the other store
// files. It backs TWO independent security boundaries:
//
//   1. Daemon HTTP auth (issue #2): every daemon endpoint (except /health)
//      requires `Authorization: Bearer <secret>`. The plugin and the daemon run
//      as the same user and share this file, so the token costs nothing to
//      distribute and can never be read by another local user.
//   2. Routing-token signing (issue #3 / #1): outbound email subjects carry
//      `[omo:ses_X.<HMAC(secret, ses_X)>]` instead of a plaintext session ID.
//      An attacker who does not know the secret cannot forge a routing token,
//      and a tampered token fails verification.
//
// Creation is atomic: the first process to run calls ensureSecret(), which
// writes with `flag:"wx"` (fail-if-exists) so a concurrent plugin/daemon race
// resolves to ONE winner's value (the loser reads it back). The file is
// chmod'ed 0600 after creation so no group/other user can read it.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto"
import { statePath } from "./paths.js"

// Secret path: <store>/daemon-secret by default. AFK_DAEMON_SECRET overrides it
// (mirrors the AFK_JOURNAL / AFK_LAST_UID / AFK_PENDING / AFK_MODE convention;
// tests use it to keep the real file clean).
const SECRET_PATH =
  process.env.AFK_DAEMON_SECRET ||
  statePath(process.env, "daemon-secret")

/** @returns {string} The secret file path (exposed for tests/diagnostics). */
export function secretPath() {
  return SECRET_PATH
}

/**
 * Read the shared secret, or null when it does not exist yet.
 * Tolerates a missing/unreadable file (returns null).
 * @returns {string|null}
 */
export function readSecret() {
  try {
    if (!existsSync(SECRET_PATH)) return null
    const value = readFileSync(SECRET_PATH, "utf8").trim()
    return value || null
  } catch {
    return null
  }
}

/**
 * Ensure the shared secret exists, creating it (0600) atomically if missing.
 * First-writer-wins: a concurrent creator's `wx` write fails with EEXIST and the
 * winner's value is read back — so the plugin and the daemon always agree.
 * @returns {string} The secret.
 */
export function ensureSecret() {
  const existing = readSecret()
  if (existing) return existing

  const secret = randomBytes(32).toString("hex")
  try {
    writeFileSync(SECRET_PATH, secret + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" })
    return secret
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return readSecret() || secret
    }
    // Best-effort fallback (e.g. an unwritable dir): write + chmod. If even this
    // fails the caller gets the in-memory secret, which at least lets a single
    // process keep working for its own lifetime.
    try {
      writeFileSync(SECRET_PATH, secret + "\n", { encoding: "utf8", mode: 0o600 })
      chmodSync(SECRET_PATH, 0o600)
    } catch {
      /* keep the in-memory secret */
    }
    return secret
  }
}

/**
 * HMAC-SHA256 of `message` under `secret`, hex-encoded and truncated to 16 bytes
 * (32 hex chars) — short enough for an email subject, still 128-bit security.
 * @param {string} message
 * @param {string} secret
 * @returns {string}
 */
export function hmacHex(message, secret) {
  return createHmac("sha256", secret).update(message).digest("hex").slice(0, 32)
}

/**
 * Constant-time string comparison (length-checked first). Used for the Bearer
 * token and the routing-token signature so neither leaks via timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8")
  const bb = Buffer.from(String(b), "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * The `Authorization` header the plugin sends to the daemon, or an empty object
 * when the secret does not exist yet (the daemon has not been spawned — every
 * privileged endpoint would be down anyway, and /health needs no auth).
 * @returns {{authorization: string}|{}}
 */
export function bearerHeader() {
  const secret = readSecret()
  return secret ? { authorization: `Bearer ${secret}` } : {}
}

// afk message processing pipeline (T5).
//
// fetch → parse → PERSIST. Ties together the already-built pieces:
//   - reply-parse.js (T6) `parseReply`          — pure reply detection + routing
//   - inject.js      (T7) `buildPayload`/`isJournaled` — dedupe + payload framing
//   - watcher.js     (T4) the single imapflow client that owns the connection
//   - uid-cursor.js       persistent "highest processed UID" cursor
//
// Both entry paths funnel through scanAndProcess():
//   - CATCH-UP (one-time reconciliation): run once after every successful
//     connect()+mailboxOpen() (initial AND reconnect), BEFORE relying on IDLE.
//   - LIVE (IDLE push): the watcher's `exists` event calls onMail, which runs
//     the same scan. Event-driven, not polling.
//
// DETECTION (UID cursor, NOT `\Seen`): the scan searches for messages whose UID
// is GREATER than a persistent cursor — a small incremental window of only new
// mail since the last scan. It does NOT filter by `\Seen` (the human's mail
// client may mark a reply \Seen before the daemon scans, hiding it from an
// UNSEEN search) and does NOT filter by SUBJECT (QQ's SUBJECT index lags a
// just-delivered message by ~15s). Each UID in the window is fetched and
// parseReply rejects non-token/non-reply mail (zero-action, same as before).
// After processing, the cursor advances past the highest UID seen — processed
// or not — so a self-copy / non-token mail can never wedge it.
//
// PUSH ARCHITECTURE NOTE: processMail does NOT mark \Seen and does NOT journal.
// On a parsed reply it only PERSISTS it (via the `injectReply` seam, which the
// daemon overrides with a durable pending-store + SSE broadcast). `\Seen` +
// journal move to the daemon's `/ack` handler, which runs only AFTER the owning
// plugin instance has injected the reply in-process. Recovery from a crash
// between persist and ack is guaranteed by the DURABLE pending-store (not by the
// cursor): the cursor still advances past every UID it has seen, and a persisted
// pending is re-broadcast on the next instance connect — no loss.

import { simpleParser } from "mailparser"
import { parseReply } from "./reply-parse.js"
import { injectReply, isJournaled } from "./inject.js"
import { getCursor, initCursor, advanceCursor } from "../store/uid-cursor.js"

// Default cursor ops (real file-backed uid-cursor.js). Tests inject an in-memory
// fake via `deps.cursor` to avoid file I/O and cross-test state.
const defaultCursorOps = { get: getCursor, init: initCursor, advance: advanceCursor }

function debugEnabled() {
  return process.env.AFK_DEBUG === "1" || process.env.AFK_DEBUG === "true"
}

function debug(...args) {
  if (debugEnabled()) {
    console.error("[afk:process]", ...args)
  }
}

function error(...args) {
  console.error("[afk:process:error]", ...args)
}

/**
 * Map a mailparser ParsedMail into reply-parse's input contract
 * `{ subject, from, inReplyTo, text, html }`.
 *
 * - subject   : decoded subject (string)
 * - from      : sender address (first address in the From: envelope)
 * - inReplyTo : In-Reply-To header (string | null)
 * - text      : decoded text/plain body (string | null)
 * - html      : decoded text/html body (string | null; mailparser uses `false` when absent)
 *
 * @param {object} parsed  mailparser `simpleParser` output.
 * @returns {{subject: string, from: string, inReplyTo: string|null, text: string|null, html: string|null}}
 */
export function toStructuredEmail(parsed) {
  const fromValue = parsed && parsed.from
  const first = Array.isArray(fromValue?.value) ? fromValue.value[0] : null
  const from = first?.address || fromValue?.text || ""
  return {
    subject: typeof parsed?.subject === "string" ? parsed.subject : "",
    from,
    inReplyTo: typeof parsed?.inReplyTo === "string" ? parsed.inReplyTo : null,
    text: typeof parsed?.text === "string" ? parsed.text : null,
    html: typeof parsed?.html === "string" ? parsed.html : null,
  }
}

/**
 * Process one message (by UID): fetch → parse → persist (no ack).
 *
 * The P0 fix's core change: processMail does NOT mark \Seen and does NOT
 * journal. On a parsed reply it persists the reply via the `injectReply` seam
 * (the daemon overrides this with a durable pending-store + SSE broadcast) and
 * returns. The `\Seen` + journal ack happens LATER, in the daemon's `/ack`
 * handler, only after the owning instance injected the reply in-process. This
 * guarantees a crash between persist and ack leaves the mail UNSEEN and the
 * pending durable — no loss.
 *
 * @param {object} imapClient  imapflow client (mailbox open).
 * @param {object} client      Injected OpenCode SDK client (ignored by the
 *   daemon's custom seam; passed through to the default inject.js injectReply).
 * @param {object} config      resolved config (config.folder used for ack symmetry).
 * @param {number|string} uid  message UID.
 * @param {object} [deps]      test seam: parse/inject/journaled/log.
 *   deps.injectReply  — (client, {sessionID, body, from, uid}) => {ok}; the daemon
 *   overrides this with a store that persists the reply into its durable
 *   pending-store (and broadcasts it over SSE). Default: inject.js's in-process
 *   injectReply (used by the plugin in-process, not the daemon).
 * @returns {Promise<{uid: number|string, ok: boolean, skipped?: boolean, stored?: boolean, sessionID?: string, error?: string}>}
 */
export async function processMail(imapClient, client, config, uid, deps = {}) {
  const parse = deps.parse ?? simpleParser
  const inject = deps.injectReply ?? injectReply
  const journaled = deps.isJournaled ?? isJournaled
  const debugFn = deps.debug ?? deps.log ?? debug
  const errorFn = deps.error ?? deps.log ?? error

  const id = String(uid)

  // Dedupe guard: a UID we already acked (journaled) must never be re-processed.
  if (journaled(uid)) {
    debugFn(`uid ${id}: already journaled — skip`)
    return { uid, ok: true, skipped: true }
  }

  // Fetch the full raw RFC822 message by UID (source = complete message).
  let msg
  try {
    msg = await imapClient.fetchOne(id, { source: true, uid: true }, { uid: true })
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    errorFn(`uid ${id}: fetch failed (${message}) — leaving unseen`)
    return { uid, ok: false, error: `fetch: ${message}` }
  }

  if (!msg || !Buffer.isBuffer(msg.source)) {
    errorFn(`uid ${id}: fetch returned no source — leaving unseen`)
    return { uid, ok: false, error: "fetch: no source" }
  }

  // MIME-parse the raw source into headers + text/html bodies.
  let parsed
  try {
    parsed = await parse(msg.source)
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    errorFn(`uid ${id}: parse failed (${message}) — leaving unseen`)
    return { uid, ok: false, error: `parse: ${message}` }
  }

  const reply = parseReply(toStructuredEmail(parsed))
  if (!reply) {
    // Subject contained "[omo:" but it is not a decision reply (e.g. the
    // agent's own outbound copy, or a malformed token). Nothing to persist.
    debugFn(`uid ${id}: not a decision reply (self-copy or malformed) — leaving unseen`)
    return { uid, ok: true, skipped: true }
  }

  // Sender allow-list guard (prompt-injection protection): only replies FROM a
  // configured address may be injected. A stranger who copies the subject token
  // cannot push content into the session. Allow list is lowercased in config.
  const sender = String(reply.from || "").toLowerCase()
  const allowList = Array.isArray(config.allowList) ? config.allowList : []
  if (allowList.length > 0 && !allowList.includes(sender)) {
    debugFn(`uid ${id}: sender ${sender} not in allowList — ignoring`)
    return { uid, ok: true, skipped: true, reason: "sender-not-allowed" }
  }

  // Persist (daemon: durable pending-store + SSE broadcast; plugin: in-process
  // inject). `uid` is passed so the daemon's store can key the pending entry —
  // inject.js's default injectReply ignores it. NO \Seen, NO journal here.
  const result = await inject(client, {
    sessionID: reply.sessionID,
    body: reply.body,
    from: reply.from,
    uid,
  })
  if (!result || result.ok !== true) {
    const message = (result && result.error) || "unknown persistence failure"
    errorFn(`uid ${id}: persist failed (${message}) — leaving UNSEEN for retry`)
    return { uid, ok: false, error: message }
  }

  debugFn(`uid ${id}: reply persisted for ${reply.sessionID} (awaiting in-process inject + ack)`)
  return { uid, ok: true, stored: true, sessionID: reply.sessionID }
}

// Resolve the cursor to scan from. On a fresh start (no persisted cursor, or a
// uidValidity change) anchor it to the mailbox's current highest UID so history
// is never reprocessed. The highest existing UID is `uidNext - 1` (UIDs are
// assigned monotonically; uidNext is the next UID to be assigned), which avoids
// a full-mailbox search.
async function resolveCursor(imapClient, cursorOps, debugFn) {
  const uidValidity = imapClient.mailbox?.uidValidity
  const existing = cursorOps.get(uidValidity)
  if (existing !== null) return existing

  const uidNext = imapClient.mailbox?.uidNext
  let anchor =
    typeof uidNext === "number" && uidNext > 0
      ? uidNext - 1
      : await (async () => {
          const all = await imapClient.search({ all: true }, { uid: true })
          return Array.isArray(all) && all.length > 0 ? Math.max(...all.map(Number)) : 0
        })()

  cursorOps.init(anchor, uidValidity)
  debugFn(`UID cursor initialized to ${anchor} (fresh start)`)
  return anchor
}

/**
 * Scan for messages whose UID is greater than the persistent cursor, then
 * process each via processMail. Used by BOTH the catch-up path (after
 * connect+mailboxOpen) and the live IDLE path (onMail). One-time/event-driven —
 * never polled.
 *
 * DETECTION does NOT use `\Seen` (the human may have read the reply first) and
 * does NOT use SUBJECT (QQ's SUBJECT index lags ~15s). It searches the small
 * incremental UID window `> cursor` and lets processMail's parseReply reject
 * non-token/non-reply mail. After processing, the cursor advances to the
 * highest UID seen — processed or not — so a self-copy / non-token mail can
 * never wedge it.
 *
 * @param {object} imapClient  imapflow client (mailbox open).
 * @param {object} client      injected OpenCode SDK client.
 * @param {object} config      resolved config.
 * @param {object} [deps]      passed through to processMail; also carries the
 *   cursor seam below.
 * @param {{get:Function, init:Function, advance:Function}} [deps.cursor]
 *   Test seam for the UID cursor (defaults to the real uid-cursor.js).
 * @returns {Promise<Array<object>>} Per-UID results (empty when no new mail).
 */
export async function scanAndProcess(imapClient, client, config, deps = {}) {
  const debugFn = deps.debug ?? deps.log ?? debug
  const cursorOps = deps.cursor ?? defaultCursorOps

  const cursor = await resolveCursor(imapClient, cursorOps, debugFn)

  // UID-range search: only mail NEWER than the cursor. No seen/subject filter.
  const uids = await imapClient.search({ uid: `${cursor + 1}:*` }, { uid: true })

  if (!Array.isArray(uids) || uids.length === 0) {
    return []
  }

  const highest = Math.max(...uids.map(Number))
  debugFn(`scan found ${uids.length} message(s) with UID > ${cursor} (highest ${highest})`)

  const results = []
  for (const uid of uids) {
    results.push(await processMail(imapClient, client, config, uid, deps))
  }

  // Advance past the highest UID SEEN, regardless of whether each message was
  // processed or skipped — so a self-copy / non-token mail cannot wedge it.
  cursorOps.advance(highest, imapClient.mailbox?.uidValidity)
  debugFn(`advanced UID cursor to ${highest}`)

  return results
}

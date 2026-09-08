// afk reply detection + parsing (T6).
//
// PURE-logic module: given an already-structured email object, decide whether
// it is a decision reply and extract the routing token (session ID) + a
// plain-text reply body. No IMAP, no SMTP, no network I/O, no injection, no
// pending state. Everything here is a pure function of its inputs.
//
// Input contract (produced by T5 / the IMAP fetch layer, NOT here):
//   { subject, from, inReplyTo, text, html }
//   - subject   : raw subject string, e.g. "Re: [omo:ses_x] hello"
//   - from      : sender address (string)
//   - inReplyTo : In-Reply-To / References header (string | null | undefined)
//   - text      : text/plain part (string | null | undefined)
//   - html      : text/html part (string | null | undefined)
//
// The routing token is `[omo:<sessionID>.<sig>]` (signed — see below).
// The agent's OWN outbound email (T3) carries subject `[omo:…] <subject>`
// with NO `Re:`/`回复:` prefix and NO In-Reply-To header — parseReply() must
// reject that self-sent copy so it never round-trips into a live session.

import { hmacHex, constantTimeEqual } from "../store/secret.js"

// ---------------------------------------------------------------------------
// Routing token
// ---------------------------------------------------------------------------

// Captures the session ID embedded in a `[omo:ses_...]` routing token. The
// signed suffix `.<sig>` (issue #3) is OPTIONAL at this layer so the pure
// extraction logic stays backward-compatible; signature VERIFICATION is a
// separate step (verifySignedToken) performed by the processing pipeline.
const TOKEN_RE = /\[omo:(ses_[A-Za-z0-9]+)(?:\.[a-f0-9]+)?\]/

/**
 * Extract the session ID from a subject containing `[omo:ses_...]`.
 * @param {string} subject
 * @returns {string|null} The captured session ID, or null when absent.
 */
export function extractToken(subject) {
  if (typeof subject !== "string") return null
  const m = subject.match(TOKEN_RE)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Signed routing token (issue #3 / #1)
// ---------------------------------------------------------------------------

// The signed token: `ses_<id>.<sig>` where
//   sig = HMAC-SHA256(secret, "<sessionID>") truncated to 32 hex chars.
// DETERMINISTIC (no nonce): the token is stable per session, so the human may
// reply to ANY number of the session's emails (and reply to the same email
// multiple times) — replay protection is intentionally NOT enforced, because
// supplementary replies are a normal part of the workflow. The signature still
// prevents FORGING a token for a session the attacker does not hold the secret
// for.
const SIG_HEX_LENGTH = 32
const SIGNED_TOKEN_RE = new RegExp(
  `\\[omo:(ses_[A-Za-z0-9]+)\\.([a-f0-9]{${SIG_HEX_LENGTH}})\\]`
)

/**
 * Sign a routing token for `sessionID` under `secret`. Deterministic: the same
 * session always yields the same token (a stable per-session routing identity).
 * @param {string} sessionID
 * @param {string} secret
 * @returns {string} `ses_<id>.<sig>`
 */
export function signToken(sessionID, secret) {
  return `${sessionID}.${hmacHex(sessionID, secret)}`
}

/**
 * Parse a signed routing token out of a subject.
 * @param {string} subject
 * @returns {{sessionID: string, sig: string}|null} null when the subject
 *   carries no signed token (missing sig included).
 */
export function parseSignedToken(subject) {
  if (typeof subject !== "string") return null
  const m = subject.match(SIGNED_TOKEN_RE)
  return m ? { sessionID: m[1], sig: m[2] } : null
}

/**
 * Verify a subject's routing-token signature against `secret`.
 * False when the token is missing/unsigned OR the signature does not match
 * (a tampered session ID or a forged token).
 * @param {string} subject
 * @param {string} secret
 * @returns {boolean}
 */
export function verifySignedToken(subject, secret) {
  const token = parseSignedToken(subject)
  if (!token || !secret) return false
  const expected = hmacHex(token.sessionID, secret)
  return constantTimeEqual(token.sig, expected)
}

// ---------------------------------------------------------------------------
// Sender authentication (SPF/DKIM/DMARC — issue #1)
// ---------------------------------------------------------------------------

/**
 * Detect a FAILED sender-authentication result from the provider's
 * `Authentication-Results` headers (mailparser exposes them as
 * `authenticationResults: [{ value: "…; dkim=fail …; spf=fail …; dmarc=fail …" }]`).
 *
 * A forged `From:` address that fails SPF/DKIM/DMARC is rejected here — this is
 * the real defence against allow-list bypass (issue #1): the allow-list matches
 * the forged address, but the provider's own auth headers prove the sender is
 * not who they claim to be.
 *
 * @param {Array<{value?: string}>|undefined} authenticationResults
 * @returns {boolean} true when any header reports dkim/spf/dmarc = fail.
 */
export function authenticationFailed(authenticationResults) {
  if (!Array.isArray(authenticationResults)) return false
  for (const entry of authenticationResults) {
    const value = String(entry && entry.value ? entry.value : "")
    if (/\b(?:dkim|spf|dmarc)=fail\b/i.test(value)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Reply detection
// ---------------------------------------------------------------------------

// Reply-prefix marker. Case-insensitive; tolerates leading whitespace, an
// optional opening bracket (`[` / fullwidth `【`), and an ASCII or fullwidth
// colon (`:` / `：`) — QQ and other Chinese clients often use `回复：`/`答复：`
// and may not emit a literal `Re:` or an In-Reply-To header at all.
const REPLY_PREFIX_RE = /^\s*(?:\[|【)?\s*(?:re|回复|答复|fw|转发)\s*[:：]/i

/**
 * Decide whether an email is a reply to one of our outbound messages.
 *
 * True when either:
 *   - `inReplyTo` is a non-empty string (header-driven reply), OR
 *   - `subject` starts with a reply prefix (`Re:` / `回复:` / `答复:` / `Fw:` /
 *     `转发:`, case-insensitive, leading whitespace + bracket tolerated).
 *
 * The agent's own outbound (`[omo:ses_x] <subject>`, no prefix, no header)
 * is rejected here — returning false.
 *
 * @param {string} subject
 * @param {string|null|undefined} inReplyTo
 * @returns {boolean}
 */
export function isReply(subject, inReplyTo) {
  if (typeof inReplyTo === "string" && inReplyTo.trim().length > 0) return true
  if (typeof subject === "string" && REPLY_PREFIX_RE.test(subject)) return true
  return false
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

// Lines that mark the start of a quoted / original-thread block. Everything
// from the first such line onward is dropped.
const QUOTE_LINE_RES = [
  /^\s*>/, // "> quoted ..."
  /^\s*-{2,}\s*.*(?:original\s+message|原始邮件|转发的邮件|转发邮件|回复邮件)/i, // ---Original Message---
  /^\s*on\b.*\bwrote\s*[:：]/i, // "On ... wrote:"
  /写道/, // "在 ... 写道"
  /发自我的/, // "发自我的 iPhone" (QQ signature)
]

function isQuoteLine(line) {
  if (!line || !line.trim()) return false
  return QUOTE_LINE_RES.some((re) => re.test(line))
}

// Strip HTML tags and decode basic entities, leaving plain text.
function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ") // remove remaining tags
    .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      const low = e.toLowerCase()
      if (low === "amp") return "&"
      if (low === "lt") return "<"
      if (low === "gt") return ">"
      if (low === "quot") return '"'
      if (low === "apos") return "'"
      if (low === "nbsp") return " "
      const code = low.startsWith("#x")
        ? parseInt(low.slice(2), 16)
        : parseInt(low.slice(1), 10)
      return Number.isNaN(code) ? m : String.fromCharCode(code)
    })
}

// Maximum body length (T7 injects `body` into a live session; keep it bounded).
const MAX_BODY_LENGTH = 4000

/**
 * Extract a plain-text reply body.
 *
 * Prefers the `text` part when non-empty; otherwise strips HTML from `html`.
 * Then drops the quoted/original-thread tail, collapses whitespace, truncates
 * to ≤4000 chars, and falls back to "(无正文)" when nothing remains.
 *
 * @param {string|null|undefined} text
 * @param {string|null|undefined} html
 * @returns {string}
 */
export function extractBody(text, html) {
  let raw = null
  if (typeof text === "string" && text.trim().length > 0) {
    raw = text
  } else if (typeof html === "string" && html.trim().length > 0) {
    raw = stripHtml(html)
  }
  if (raw === null) return "(无正文)"

  // Drop everything from the first quoted/original-thread line onward.
  const lines = raw.split(/\r?\n/)
  const cut = lines.findIndex(isQuoteLine)
  const kept = cut === -1 ? lines : lines.slice(0, cut)

  let body = kept.join("\n").replace(/\s+/g, " ").trim()

  if (body.length > MAX_BODY_LENGTH) {
    body = body.slice(0, MAX_BODY_LENGTH).trim()
  }

  return body.length > 0 ? body : "(无正文)"
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

/**
 * Parse a structured email into a decision-reply result.
 *
 * @param {object} mail
 * @param {string} mail.subject
 * @param {string} [mail.from]
 * @param {string|null|undefined} [mail.inReplyTo]
 * @param {string|null|undefined} [mail.text]
 * @param {string|null|undefined} [mail.html]
 * @returns {{sessionID: string, body: string, from?: string, command?: "new"}|null}
 *   The parsed reply, or null when there is no token, or it is not a reply
 *   (including the agent's own self-sent copy). `command: "new"` marks a
 *   "/new <task>" body — a request to spawn a NEW session in the replying
 *   session's directory, seeded with <task>, instead of injecting here.
 */
export function parseReply({ subject, from, inReplyTo, text, html }) {
  const sessionID = extractToken(subject)
  if (!sessionID) return null
  if (!isReply(subject, inReplyTo)) return null
  const body = extractBody(text, html)
  // The /new command: the human replies to a session's email with a body that
  // STARTS with "/new <task>" → instead of injecting into that session, spawn a
  // NEW session in the SAME directory (the replying session's directory, which
  // the token resolves) and seed it with <task>. A bare "/new" with no task
  // text falls back to a normal reply (nothing useful to seed a session with).
  const m = /^\/new\s+([\s\S]+)$/.exec(body)
  if (m) return { sessionID, body: m[1].trim(), from, command: "new" }
  return { sessionID, body, from }
}

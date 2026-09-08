// afk shared email core (mailer).
//
// The pieces every outbound-email tool (request_decision, notify_user) shares:
//   - resolveRootSessionID : walk the parentID chain up to the ROOT session.
//   - stampSubject         : prefix the subject with the `[omo:<rootSessionID>]`
//                            routing token so a reply can be matched back.
//   - sendMail             : one plain-text SMTP send (nodemailer), with an
//                            injectable transport factory for hermetic tests.
//
// Each tool keeps its own orchestration ON TOP of this core: request_decision
// reserves a single-outstanding-decision slot before sending and releases it on
// send failure; notify_user sends fire-and-forget (no slot). The human's REPLY
// routing needs none of this per-tool state: the daemon parses the
// `[omo:ses_...]` token out of any incoming reply and delivers it over SSE, so
// replying to EITHER kind of email wakes the session the same way.

import nodemailer from "nodemailer"

import { signToken } from "./core/reply-parse.js"
import { readSecret, ensureSecret } from "./store/secret.js"

// Resolve the ROOT session of `startSessionID` by walking the parentID chain up
// until a session with no parentID is found. Mirrors the lineage walk in
// subagent-spawn-limits.ts. Throws on any failure (no data, SDK error, cycle).
export async function resolveRootSessionID(client, startSessionID, directory) {
  const visited = new Set()
  let current = startSessionID
  for (;;) {
    if (visited.has(current)) {
      throw new Error(`afk: session parent cycle while resolving ${startSessionID}`)
    }
    visited.add(current)

    // v1 SDK client: HTTP-style shape { path: { id }, query: { directory } }.
    // (The flat { sessionID } shape is the v2 client and would "not found".)
    const response = await client.session.get({
      path: { id: current },
      ...(directory ? { query: { directory } } : {}),
    })
    if (response.error) throw new Error(String(response.error))
    if (!response.data) throw new Error(`afk: no session data for ${current}`)

    if (!response.data.parentID) return current
    current = response.data.parentID
  }
}

// Prefix an email subject with a SIGNED routing token (issue #3). The token is
// HMAC-signed with the shared secret so a reply carrying it can be verified and
// a forged/tampered token is rejected by the daemon. The daemon extracts the
// session ID from any incoming reply and routes it back to the stamped session.
// `secret` is optional (tests inject it); default: the shared secret file,
// created on demand (first writer wins) so the plugin never blocks on the daemon.
export function stampSubject(rootSessionID, subject, secret) {
  const key = secret ?? readSecret() ?? ensureSecret()
  const token = signToken(rootSessionID, key)
  return `[omo:${token}] ${subject}`
}

// Default transport factory (nodemailer). Tests inject a fake via sendMail's
// third argument so no real SMTP is ever touched.
export function createTransport(smtpOpts) {
  return nodemailer.createTransport(smtpOpts)
}

// Send one plain-text email over SMTP. Resolves with nodemailer's sendMail info;
// THROWS on failure — the caller decides how to degrade (release a reservation,
// surface an [ERROR], ...). No HTML, no pretend success.
//
// @param {object} config  Resolved config (config.smtp.{host,port,secure,user,password}).
// @param {{to: string, subject: string, text: string}} mail
// @param {Function} [transportFactory]  (smtpOpts) => transporter (default nodemailer).
export async function sendMail(config, { to, subject, text }, transportFactory = createTransport) {
  const transporter = transportFactory({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  })
  return transporter.sendMail({
    from: config.smtp.user,
    to,
    subject,
    text,
  })
}

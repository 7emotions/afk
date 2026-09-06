// afk /new — spawn a fresh opencode session from an email reply.
//
// The human replies to any afk email (subject carries the [omo:<sessionA>]
// token) with a body starting "/new <task>". Instead of injecting into session
// A, the owning instance (the one whose directory == A's directory; among
// several such instances the first to claim wins) creates a NEW session B in
// the SAME directory and seeds it with <task> as its first prompt.
//
// The task text goes through the same DATA-NOT-INSTRUCTION framing as injected
// replies (buildPayload) — the email is untrusted content, never an executable
// instruction. The new session's own request_decision / notify_user emails then
// route via its fresh [omo:<sessionB>] token like any other session.
//
// After a successful spawn the user gets a best-effort confirmation email
// stamped with session B's token, so replying to it talks to the NEW session.
// Confirmation is fire-and-forget: no config / SMTP failure ever fails the
// spawn itself.

import { loadConfig } from "../config.js"
import { loadMessages } from "../messages.js"
import { sendMail, stampSubject } from "../mailer.js"
import { buildPayload } from "./inject.js"

const MAX_TITLE_LENGTH = 60

function sessionTitle(body) {
  const firstLine = (body.split("\n")[0] || "afk task").trim()
  return firstLine.length > MAX_TITLE_LENGTH ? `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : firstLine
}

/**
 * Create a new session in `directory` and seed it with `body` (framed as data).
 *
 * @param {object} client  Injected v1 SDK client.
 * @param {{directory: string, body: string, from?: string}} args
 * @param {object} [deps]  config/transport overrides (tests).
 * @returns {Promise<{ok: boolean, sessionID?: string, error?: string}>}
 *   Never rejects. `ok:false` → the caller leaves the pending for retry.
 */
export async function createSessionAndPrompt(client, { directory, body, from }, deps = {}) {
  const title = sessionTitle(body)
  try {
    const created = await client.session.create({
      body: { title },
      query: { directory },
    })
    if (created?.error) {
      return { ok: false, error: `session.create: ${String(created.error)}` }
    }
    const newSessionID = created?.data?.id
    if (!newSessionID) {
      return { ok: false, error: "session.create returned no session id" }
    }
    const prompted = await client.session.promptAsync({
      path: { id: newSessionID },
      body: { parts: [{ type: "text", text: buildPayload({ from, body }) }] },
      query: { directory },
    })
    if (prompted?.error) {
      return { ok: false, error: `session.promptAsync: ${String(prompted.error)}` }
    }
    await sendCreatedConfirmation({ sessionID: newSessionID, title, directory }, deps)
    return { ok: true, sessionID: newSessionID }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// Best-effort: a missing/broken config or SMTP failure must not fail the spawn.
async function sendCreatedConfirmation({ sessionID, title, directory }, deps = {}) {
  let config
  if (deps.config === undefined) {
    try {
      config = loadConfig()
    } catch {
      return
    }
  } else {
    config = deps.config
  }
  if (!config) return // tests pass { config: null } to skip the real SMTP send
  const messages = deps.getMessages ? deps.getMessages() : loadMessages(config)
  const subject = stampSubject(sessionID, messages.newSessionBody.createdSubject)
  const text = [
    `${messages.newSessionBody.createdIntro}`,
    "",
    `session: ${sessionID}`,
    `directory: ${directory}`,
    `task: ${title}`,
    "",
    messages.newSessionBody.replyHint,
  ].join("\n")
  try {
    await sendMail(
      config,
      { to: config.recipient || config.smtp.user, subject, text },
      deps.createTransport
    )
  } catch {
    /* fire-and-forget */
  }
}

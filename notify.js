// afk notify_user tool — one-way FYI email for key conclusions.
//
// The non-blocking complement to request_decision: the agent emails the away
// human a key conclusion / progress update and KEEPS WORKING. It occupies NO
// single-outstanding-decision slot (multiple FYIs are allowed; a pending
// request_decision is unaffected) and does not pause the turn.
//
// The subject is still stamped `[omo:<rootSessionID>]`, so the reply-routing
// machinery (daemon parse -> pending -> SSE -> inject) treats a human reply to
// an FYI exactly like a reply to a decision: it is injected back into the
// session as feedback ("data, not instruction"). FYI emails are reply-capable
// even though nothing is waiting on them.
//
// Same guards as request_decision: email mode must be "on" (the human ran /afk;
// otherwise just state the conclusion in the conversation) and MAIN SESSION
// ONLY (a subagent's conclusion is relayed by the main agent).

import { tool } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { loadMessages } from "./messages.js"
import { resolveRootSessionID, sendMail, stampSubject } from "./mailer.js"

function renderNotifyBody({ message }, messages) {
  return `${message}\n\n${messages.notifyBody.replyHint}`
}

// Tool factory. Deps mirror request-decision minus register/release (no slot):
//   deps.getClient         — () => client        (injected SDK client)
//   deps.getDirectory      — () => directory     (working directory)
//   deps.getMode           — () => Promise<"on"|"off"|unknown> (GET /mode). When
//                            null/absent the gate is SKIPPED (legacy behavior).
//   deps.config            — preloaded config    (default: loadConfig())
//   deps.createTransport   — (smtpOpts) => transporter (default: mailer's nodemailer)
//   deps.getMessages       — () => messages table (default: loadMessages(config))
export function createNotifyUserTool(deps = {}) {
  const getClient = deps.getClient ?? (() => null)
  const getDirectory = deps.getDirectory ?? (() => null)
  const getMode = deps.getMode ?? null
  const resolveConfig = deps.config !== undefined ? () => deps.config : loadConfig
  const createTransport = deps.createTransport
  const getMessages = deps.getMessages ?? (() => loadMessages(resolveConfig()))

  return tool({
    description:
      "Email the human a one-way FYI about a key conclusion or progress update, " +
      "WITHOUT pausing. MAIN SESSION ONLY: calling from a subagent is rejected " +
      "(conclusions should be relayed by the main session). Emails only when " +
      "email mode is on (the human ran /afk and left the screen) — otherwise it " +
      "refuses: just state the conclusion in the conversation instead. Unlike " +
      "request_decision, this does NOT pause your turn and does NOT occupy the " +
      "single-outstanding-decision slot — keep working after it returns. The " +
      "subject carries the routing token, so if the human replies to this email, " +
      "the reply is injected back into this session as feedback you may " +
      "incorporate. Use it when you finish a task, reach a significant finding, " +
      "or hit a milestone the away human would want to know about.",
    args: {
      subject: tool.schema.string().describe("Short subject line for the notification email"),
      message: tool.schema.string().describe("The conclusion / update text to email"),
    },
    async execute(args, toolContext) {
      const client = getClient()
      if (!client) {
        return "[ERROR] afk client not available; the plugin has not been initialized"
      }

      const currentSessionID = toolContext.sessionID
      if (!currentSessionID) {
        return "[ERROR] afk: missing sessionID in tool context"
      }

      const messages = getMessages()

      // GLOBAL email-mode gate (checked FIRST). The human must have left the
      // screen (mode "on", set by /afk) before any email is allowed. When off,
      // refuse: the human is at the screen, so state the conclusion in the
      // conversation instead.
      if (getMode) {
        let mode
        try {
          mode = await getMode()
        } catch {
          mode = "off" // cannot determine the mode → refuse (safe default)
        }
        if (mode !== "on") {
          return messages.tool.notifyModeOff
        }
      }

      const directory = getDirectory() || toolContext.directory

      // Walk to the root session. If that fails (no client data, cycle, SDK
      // error), refuse: conclusions belong to the main session.
      let rootSessionID
      try {
        rootSessionID = await resolveRootSessionID(client, currentSessionID, directory)
      } catch {
        return messages.tool.mainSessionOnly
      }
      if (rootSessionID !== currentSessionID) {
        return messages.tool.mainSessionOnly
      }

      const config = resolveConfig()
      const to = config.recipient || config.smtp.user
      try {
        // Optional dep: undefined → sendMail's nodemailer default factory.
        await sendMail(
          config,
          {
            to,
            subject: stampSubject(rootSessionID, args.subject),
            text: renderNotifyBody(args, messages),
          },
          createTransport
        )
      } catch (error) {
        return `[ERROR] ${error instanceof Error ? error.message : String(error)}`
      }

      return messages.tool.notified
    },
  })
}

export default createNotifyUserTool

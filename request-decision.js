// afk request_decision tool (T3 + daemon registration).
//
// Lets the agent email the human a decision question, stamping the subject with
// a routing token `[omo:<rootSessionID>]` so a future reply can be matched back
// to the session that asked.
//
// Single-outstanding-decision guard is SERVER-SIDE (the daemon's registry):
//   1. resolve the root session (parentID walk).
//   2. POST /register {sessionID: root}. The daemon returns alreadyPending:true
//      if the session already has an outstanding decision → the tool returns
//      `messages.tool.alreadyPending` WITHOUT sending a second email. (Registering
//      BEFORE sending
//      reserves the slot so a double ask never mails twice; the daemon is
//      single-instance so the reserve is race-free.)
//   3. SMTP-send the question (plain-text only, no HTML, no pretend-success).
//   4. On send failure, release the reservation so no stale entry lingers.
//
// NO reply parsing, NO catch-up, NO injection here — that is the SSE subscriber
// (subscribe.js) and the daemon's job. The reply is delivered PUSH-style: the
// daemon broadcasts it over SSE, and the in-process subscriber claims/injects
// it. request_decision no longer starts a per-session poller.

import { tool } from "@opencode-ai/plugin"
import { loadConfig } from "./config.js"
import { loadMessages } from "./messages.js"
import { resolveRootSessionID, sendMail, stampSubject } from "./mailer.js"

// Render the decision email body from the structured slots. A good decision
// email carries the agent's ANALYSIS (context + options/tradeoffs +
// recommendation), not just a bare question — so the human can answer with a
// single token instead of re-deriving the analysis from scratch.
//
// Labels come from `messages.decisionBody` (i18n — default English, overridable
// via config.messages) so the email reads in the deployment's language.
function renderDecisionBody({ question, context, options, recommendation }, messages) {
  const { context: contextLabel, question: questionLabel, options: optionsLabel, recommendation: recommendationLabel, replyInstruction } = messages.decisionBody
  const lines = []
  if (context) {
    lines.push(contextLabel, context, "")
  }
  lines.push(`${questionLabel} ${question}`, "")
  if (Array.isArray(options) && options.length > 0) {
    lines.push(optionsLabel)
    for (const option of options) lines.push(`- ${option}`)
    lines.push("")
  }
  if (recommendation) {
    lines.push(`${recommendationLabel} ${recommendation}`, "")
  }
  lines.push(replyInstruction)
  return lines.join("\n")
}

// Tool factory.
//
// deps.getClient         — () => client           (injected SDK client)
// deps.getDirectory      — () => directory        (working directory)
// deps.registerDecision  — ({sessionID}) => Promise<{alreadyPending}>
//                          (POST /register; throws when the daemon is down)
// deps.releaseDecision   — (sessionID) => Promise<void> (DELETE /register)
// deps.getMode           — () => Promise<"on"|"off"|unknown> (GET /mode). When
//                          null/absent the gate is SKIPPED (legacy behavior —
//                          the plugin always injects a real one).
// deps.config            — preloaded config       (default: loadConfig())
// deps.createTransport   — (smtpOpts) => transporter (default: nodemailer)
// deps.getMessages       — () => messages table (default: loadMessages(config))
export function createRequestDecisionTool(deps = {}) {
  const getClient = deps.getClient ?? (() => null)
  const getDirectory = deps.getDirectory ?? (() => null)
  const registerDecision = deps.registerDecision ?? null
  const releaseDecision = deps.releaseDecision ?? null
  const getMode = deps.getMode ?? null
  const resolveConfig = deps.config !== undefined ? () => deps.config : loadConfig
  const createTransport = deps.createTransport
  const getMessages = deps.getMessages ?? (() => loadMessages(resolveConfig()))

  return tool({
    description:
      "Email the human a decision question, then pause and end the current turn. " +
      "MAIN SESSION ONLY: calling from a subagent is rejected (decisions must carry " +
      "the main session's full context). Before calling when it will email, checkpoint " +
      "your todos (write them into the message body, then clear them) so todo-continuation " +
      "does not resume you while the reply is pending. Sends an email to the configured " +
      "recipient with a routing token in the subject so a reply can be matched back to this " +
      "session. Use this when you must ask the human to make a decision before you " +
      "can safely continue. For a NON-trivial decision, fill context/options/" +
      "recommendation so the human can answer with a single token instead of " +
      "re-deriving your analysis. After calling this, STOP and do no further work " +
      "until the human's reply is injected.",
    args: {
      subject: tool.schema.string().describe("Short subject line for the decision email"),
      question: tool.schema.string().describe("The single, answerable decision question"),
      context: tool.schema.string().optional().describe("Background: why this decision is needed now"),
      options: tool.schema.array(tool.schema.string()).optional().describe("Options with tradeoffs, e.g. 'A. in-place (fast, brief risk)'"),
      recommendation: tool.schema.string().optional().describe("Your recommendation and why"),
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

      // GLOBAL email-mode gate (checked FIRST, before the root-session walk).
      // The human must have left the screen (mode "on", set by /afk) before any
      // email is allowed. When off, refuse and point the agent at opencode's
      // built-in `question` tool instead — no email, no register.
      if (getMode) {
        let mode
        try {
          mode = await getMode()
        } catch {
          mode = "off" // cannot determine the mode → refuse (safe default)
        }
        if (mode !== "on") {
          return messages.tool.modeOff
        }
      }

      const directory = getDirectory() || toolContext.directory

      // Walk to the root session. If that fails (no client data, cycle, SDK
      // error), refuse: decisions must be requested from the main session.
      let rootSessionID
      try {
        rootSessionID = await resolveRootSessionID(client, currentSessionID, directory)
      } catch {
        return messages.tool.mainSessionOnly
      }

      // A subagent's session has a parentID, so its resolved root != itself.
      // Reject it: decisions belong to the main session (which keeps the full
      // decision context), never to a short-lived subagent.
      if (rootSessionID !== currentSessionID) {
        return messages.tool.mainSessionOnly
      }

      // ONE outstanding decision per root session (server-side guard). Register
      // BEFORE sending so a second ask never mails twice. The daemon is
      // single-instance, so this reserve is race-free.
      let reserved = false
      if (registerDecision) {
        try {
          const reg = await registerDecision({ sessionID: rootSessionID })
          if (reg.alreadyPending) {
            return messages.tool.alreadyPending
          }
          reserved = true
        } catch (err) {
          // Daemon down: log loudly, then still ask the human (degraded — the
          // reply may not auto-route until the daemon recovers). Never crash.
          console.error("[afk] daemon register failed:", err.message)
        }
      }

      const config = resolveConfig()
      const to = config.recipient || config.smtp.user
      const subject = stampSubject(rootSessionID, args.subject)
      const text = renderDecisionBody(args, messages)

      try {
        // Optional dep: undefined → sendMail's nodemailer default factory.
        await sendMail(config, { to, subject, text }, createTransport)
      } catch (error) {
        // Do NOT pretend it was sent; release the reservation so no stale
        // registry entry lingers (a later ask can reserve fresh).
        if (reserved && releaseDecision) {
          await releaseDecision(rootSessionID).catch(() => {})
        }
        return `[ERROR] ${error instanceof Error ? error.message : String(error)}`
      }

      // The reply is delivered PUSH-style by the SSE subscriber (started once on
      // plugin load) — no per-session poller here.

      return messages.tool.requested
    },
  })
}

export default createRequestDecisionTool

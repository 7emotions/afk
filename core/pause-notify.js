// afk pause notification — email the away human when a working burst ends.
//
// The reliability fix for "the agent finished/paused a burst and went quiet
// without notifying": instead of trusting the agent to remember notify_user at
// every conclusion, THIS module watches opencode's own turn-end signal.
//
//   handleEvent(event) is wired to the plugin's Hooks.event, which receives
//   every opencode event in-process. On `session.idle` (a turn completed) for a
//   ROOT session in THIS instance's directory, it arms a cooldown timer. If the
//   session shows activity again (a new turn started) the timer is cancelled;
//   if it stays quiet past the cooldown the burst is over → the human gets one
//   email summarizing where the session stopped. Replying to it (subject is
//   stamped [omo:<sessionID>]) tells the agent to continue.
//
// Skips (checked at fire time, so nothing is decided on the hot event path):
//   - email mode not "on" (the human is at the screen)
//   - the session is gone / not a root session / not in this directory
//   - the last assistant turn contains a request_decision / notify_user tool
//     call — that turn already emailed the human, this would be a duplicate
//   - the session has no assistant text to summarize
//
// Everything is best-effort: any failure is swallowed (never crash the plugin),
// and emails are sent fire-and-forget after the cooldown, never on the event
// path.

export const EMAIL_TOOLS = new Set(["request_decision", "notify_user"])

// Events that prove the session is working again (cancel a pending wait). A
// new turn means its own session.idle will re-arm when it finishes.
const ACTIVITY_EVENT_TYPES = new Set([
  "session.status",
  "session.updated",
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "todo.updated",
  "command.executed",
])

export const DEFAULT_COOLDOWN_MS = 60_000
const MAX_SUMMARY_CHARS = 800

/**
 * Create the pause notifier.
 *
 * @param {object} opts
 * @param {string} opts.directory    This instance's directory (ownership check).
 * @param {() => object|null} opts.getClient  In-process SDK client accessor.
 * @param {() => Promise<"on"|"off">} opts.getMode  Daemon /mode (refuse unless "on").
 * @param {(mail: {sessionID: string, title: string, summary: string}) => Promise<unknown>} opts.sendEmail
 * @param {number} [opts.cooldownMs]  Quiet window before the burst is "over".
 * @param {Function} [opts.setTimer] / [opts.clearTimer]  Timer seams (tests).
 * @returns {{handleEvent: (input: {event: object}) => Promise<void>}}
 */
export function createPauseNotifier({
  directory,
  getClient,
  getMode,
  sendEmail,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  // sessionID -> timer handle of a pending "burst over" check.
  const waits = new Map()

  function cancelWait(sessionID) {
    const timer = waits.get(sessionID)
    if (timer === undefined) return
    clearTimer(timer)
    waits.delete(sessionID)
  }

  async function checkBurstOver(sessionID) {
    waits.delete(sessionID)
    try {
      await maybeNotify(sessionID)
    } catch {
      /* best-effort — a failed check must never break the plugin */
    }
  }

  async function maybeNotify(sessionID) {
    const mode = getMode ? await getMode() : "on"
    if (mode !== "on") return
    const client = getClient ? getClient() : null
    if (!client) return

    const session = await client.session.get({ path: { id: sessionID } }).catch(() => null)
    const data = session?.data
    if (!data || data.directory !== directory || data.parentID) return

    const messages = await client.session.messages({ path: { id: sessionID } }).catch(() => null)
    const summary = lastAssistantSummary(messages?.data)
    if (!summary || summary.toolEmailed) return

    await sendEmail({ sessionID, title: data.title || "session", summary: summary.text })
  }

  /**
   * Feed every opencode event here (wired to Hooks.event).
   * @param {{event: object}} input
   */
  async function handleEvent({ event }) {
    const sessionID = event?.properties?.sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (event.type === "session.idle") {
      cancelWait(sessionID) // re-arm: only the LAST idle's wait may fire
      waits.set(sessionID, setTimer(() => checkBurstOver(sessionID), cooldownMs))
    } else if (ACTIVITY_EVENT_TYPES.has(event.type)) {
      cancelWait(sessionID) // the session started working again
    }
  }

  return { handleEvent }
}

// Walk the session's messages backwards to the newest assistant text. Returns
// { text } when there is something to summarize, or { toolEmailed: true } when
// the newest assistant turn ended with one of our email tools (that turn
// already notified the human — a pause email would be a duplicate).
function lastAssistantSummary(messages) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i]
    if (entry?.info?.role !== "assistant") continue
    if (!Array.isArray(entry.parts)) continue

    const emailed = entry.parts.some((p) => p?.type === "tool" && EMAIL_TOOLS.has(p.tool))
    if (emailed) return { toolEmailed: true }

    const text = entry.parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text.length > 0) {
      return { text: text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text }
    }
  }
  return null
}

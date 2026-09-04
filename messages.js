// email-wake user/agent-facing messages (i18n).
//
// Every string the plugin shows to the human (the decision email) or returns to
// the agent (tool return strings) lives here, keyed by semantic name. Defaults
// are English; an optional `config.messages` object deep-merges over the
// defaults, so a deployment can localize the email and tool strings without
// touching code.
//
// `loadMessages(config)` is the single entry point: it returns a deep copy of
// the default messages with any `config.messages` keys merged in. The deep copy
// matters — callers must never mutate the shared defaults.
//
// NOTE: the DATA-NOT-INSTRUCTION framing in inject.js (`buildPayload`) is a
// SEPARATE concern and is intentionally NOT part of this table — it is a
// security framing, not a display string, and its default behavior is left
// unchanged.

// English defaults. Keep the shape stable: callers (request-decision.js) read
// these semantic keys, so renaming a key is a breaking change to the contract.
export const DEFAULT_MESSAGES = {
  decisionBody: {
    context: "Context:",
    question: "Decision:",
    options: "Options:",
    recommendation: "Recommendation:",
    replyInstruction: "Reply to this email with your answer",
  },
  tool: {
    requested:
      "Decision requested — pause and end this turn; wait for the reply to be injected",
    alreadyPending: "A decision is already pending — wait for the reply",
    mainSessionOnly: "Call from the main session only",
    modeOff:
      "Email mode is off — the human is at the screen. Use the question tool to ask in the conversation instead.",
    modeOn:
      "Email mode is ON — the human has left the screen; request_decision will email them.",
    modeDisabled:
      "Email mode is OFF — request_decision will use the question tool instead.",
  },
}

// Deep-clone a plain object/array tree (primitives pass through). Ensures the
// returned messages never share a nested reference with DEFAULT_MESSAGES.
function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (value && typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value)) out[key] = deepClone(value[key])
    return out
  }
  return value
}

// Deep-merge `override` over `base`, returning a fresh object. `base` is always
// deep-cloned first so its nested objects are never mutated; then each override
// key is merged (recursively for plain objects) or replaces the base value.
function deepMerge(base, override) {
  const out = deepClone(base)
  for (const key of Object.keys(override ?? {})) {
    const b = out[key]
    const o = override[key]
    if (
      b &&
      o &&
      typeof b === "object" &&
      typeof o === "object" &&
      !Array.isArray(b) &&
      !Array.isArray(o)
    ) {
      out[key] = deepMerge(b, o)
    } else {
      out[key] = deepClone(o)
    }
  }
  return out
}

/**
 * Resolve the messages for a config: DEFAULT_MESSAGES deep-merged with
 * `config.messages` (if any). A missing/empty override yields the English
 * defaults. Returns a fresh object every call — callers must not mutate it.
 *
 * @param {object} [config]  Resolved config (config.messages optional).
 * @returns {object}  A copy of the messages table.
 */
export function loadMessages(config) {
  return deepMerge(DEFAULT_MESSAGES, config?.messages ?? {})
}

export default DEFAULT_MESSAGES

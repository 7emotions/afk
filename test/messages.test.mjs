// afk messages i18n unit tests.
//
// Proves the two sides of the i18n change:
//   (a) DEFAULT_MESSAGES is English and loadMessages({}) returns it (default).
//   (b) loadMessages deep-merges a partial config.messages override — overridden
//       keys change, unmentioned keys keep their English default.
//   (c) request_decision reads messages through its getMessages dependency: the
//       default path (loadMessages(resolveConfig())) renders English, and a
//       config.messages override localizes the email body + tool strings.
//
// No network, no IMAP/SMTP, no live opencode.

import { test } from "node:test"
import assert from "node:assert/strict"

import { DEFAULT_MESSAGES, loadMessages } from "../messages.js"
import { createRequestDecisionTool } from "../request-decision.js"

test("DEFAULT_MESSAGES is English (default language)", () => {
  assert.equal(DEFAULT_MESSAGES.decisionBody.context, "Context:")
  assert.equal(DEFAULT_MESSAGES.decisionBody.question, "Decision:")
  assert.equal(DEFAULT_MESSAGES.decisionBody.options, "Options:")
  assert.equal(DEFAULT_MESSAGES.decisionBody.recommendation, "Recommendation:")
  assert.equal(DEFAULT_MESSAGES.decisionBody.replyInstruction, "Reply to this email with your answer")
  assert.equal(
    DEFAULT_MESSAGES.tool.requested,
    "Decision requested — pause and end this turn; wait for the reply to be injected"
  )
  assert.equal(DEFAULT_MESSAGES.tool.alreadyPending, "A decision is already pending — wait for the reply")
  assert.equal(DEFAULT_MESSAGES.tool.mainSessionOnly, "Call from the main session only")
  assert.equal(
    DEFAULT_MESSAGES.tool.modeOff,
    "Email mode is off — the human is at the screen. Use the question tool to ask in the conversation instead."
  )
  assert.equal(
    DEFAULT_MESSAGES.tool.modeOn,
    "Email mode is ON — the human has left the screen; request_decision will email them."
  )
  assert.equal(
    DEFAULT_MESSAGES.tool.modeDisabled,
    "Email mode is OFF — request_decision will use the question tool instead."
  )
})

test("loadMessages({}) returns the English defaults (deep copy, no mutation of DEFAULT)", () => {
  const resolved = loadMessages({})
  assert.deepEqual(resolved, DEFAULT_MESSAGES)

  // The returned object must be a COPY: mutating it must not touch DEFAULT_MESSAGES.
  resolved.tool.requested = "mutated"
  assert.equal(
    DEFAULT_MESSAGES.tool.requested,
    "Decision requested — pause and end this turn; wait for the reply to be injected"
  )
})

test("loadMessages deep-merges a partial config.messages override, preserving unmentioned keys", () => {
  const config = {
    messages: {
      tool: { requested: "Pregunta enviada — pausa y espera la respuesta" },
    },
  }
  const resolved = loadMessages(config)

  // Overridden key changes…
  assert.equal(resolved.tool.requested, "Pregunta enviada — pausa y espera la respuesta")
  // …but its siblings and the whole decisionBody block keep the English default.
  assert.equal(resolved.tool.alreadyPending, DEFAULT_MESSAGES.tool.alreadyPending)
  assert.equal(resolved.tool.mainSessionOnly, DEFAULT_MESSAGES.tool.mainSessionOnly)
  assert.deepEqual(resolved.decisionBody, DEFAULT_MESSAGES.decisionBody)
})

test("loadMessages tolerates a missing/empty messages block (returns defaults)", () => {
  assert.deepEqual(loadMessages(undefined), DEFAULT_MESSAGES)
  assert.deepEqual(loadMessages({ messages: {} }), DEFAULT_MESSAGES)
  assert.deepEqual(loadMessages({}), DEFAULT_MESSAGES)
})

// A minimal hermetic tool harness (mirrors request-decision.test.mjs) that lets
// us drive request_decision without a live client/daemon/SMTP.
function makeTool({ config }) {
  const calls = []
  const sessions = { "root-1": { id: "root-1", parentID: undefined } }
  const client = {
    session: {
      get: async ({ path }) => {
        const data = sessions[path?.id]
        return data ? { data } : { error: "not found" }
      },
    },
  }
  const toolDef = createRequestDecisionTool({
    getClient: () => client,
    getDirectory: () => "/tmp/afk-messages-test",
    registerDecision: async () => ({ alreadyPending: false }),
    config,
    createTransport: () => ({
      sendMail: async (mail) => {
        calls.push({ mail })
        return { messageId: "<mock-messages@afk.test>" }
      },
    }),
  })
  return { toolDef, calls }
}

test("request_decision default path renders English body + tool string (no messages override)", async () => {
  const { toolDef, calls } = makeTool({
    config: {
      smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "sender@test.com", password: "s" },
      recipient: "recipient@test.com",
      folder: "INBOX",
    },
  })

  const result = await toolDef.execute(
    { subject: "Pick one", question: "A or B?" },
    { sessionID: "root-1" }
  )
  assert.match(result, /Decision requested/)
  assert.equal(calls[0].mail.text, "Decision: A or B?\n\nReply to this email with your answer")
})

test("request_decision renders localized body + tool string from config.messages", async () => {
  const { toolDef, calls } = makeTool({
    config: {
      smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "sender@test.com", password: "s" },
      recipient: "recipient@test.com",
      folder: "INBOX",
      messages: {
        decisionBody: {
          question: "决定：",
          replyInstruction: "请直接回复本邮件作答",
        },
        tool: { requested: "已请求，等待回复" },
      },
    },
  })

  const result = await toolDef.execute(
    { subject: "选一个", question: "A 还是 B？" },
    { sessionID: "root-1" }
  )
  assert.equal(result, "已请求，等待回复")
  // Overridden labels are used; unmentioned labels keep their English default.
  assert.equal(calls[0].mail.text, "决定： A 还是 B？\n\n请直接回复本邮件作答")
})

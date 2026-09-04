// email-wake request_decision unit test (T3 + daemon-registration flow).
//
// node:test + assert. Mocks the nodemailer transport (via the tool factory's
// `createTransport` dependency) so NO real mail is sent, and mocks the daemon
// register/release calls so NO real daemon is contacted. Hermetic config + mock
// SDK client so no real OpenCode session is touched. Routing (serverUrl) and the
// per-session poller are GONE in the PUSH architecture — the tool only registers
// a reservation; delivery is the SSE subscriber's job.

import test from "node:test"
import assert from "node:assert/strict"

import { createRequestDecisionTool } from "../request-decision.js"

// Hermetic config (never reads config.json, never real credentials).
const config = {
  smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "sender@test.com", password: "secret" },
  recipient: "recipient@test.com",
  folder: "INBOX",
}

// Mock SDK client: parentID chain child-1 -> root-1 (no parent). v1 HTTP-style
// signature `session.get({ path: { id } })`.
const sessions = {
  "child-1": { id: "child-1", parentID: "root-1" },
  "root-1": { id: "root-1", parentID: undefined },
}
const client = {
  session: {
    get: async ({ path }) => {
      const sessionID = path?.id
      const data = sessions[sessionID]
      if (!data) return { error: `session ${sessionID} not found` }
      return { data }
    },
  },
}

// Build a tool instance wired to the mocks above. `registerDecision` defaults to
// succeeding once; override via opts for pending/throw cases.
function makeTool({
  transport = "ok",
  registerDecision = async () => ({ alreadyPending: false }),
  getMode = undefined,
} = {}) {
  const calls = []
  const registerCalls = []
  const releaseCalls = []
  const createTransport = (opts) => {
    const transporter = {
      sendMail: async (mail) => {
        calls.push({ opts, mail })
        if (transport === "throw") throw new Error("SMTP 550 mailbox unavailable")
        return { messageId: `<mock-${calls.length}@email-wake.test>` }
      },
    }
    return transporter
  }
  const toolDef = createRequestDecisionTool({
    getClient: () => client,
    getDirectory: () => "/tmp/email-wake-test",
    registerDecision: async (arg) => {
      registerCalls.push(arg)
      return registerDecision(arg)
    },
    releaseDecision: async (sessionID) => {
      releaseCalls.push(sessionID)
    },
    getMode,
    config,
    createTransport,
  })
  return { toolDef, calls, registerCalls, releaseCalls }
}

test("subject is rewritten to [omo:<rootSessionID>] <subject>", async () => {
  const { toolDef, calls } = makeTool()
  const result = await toolDef.execute(
    { subject: "Approve deployment?", question: "Should we deploy to prod?" },
    { sessionID: "root-1" }
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mail.subject, "[omo:root-1] Approve deployment?")
  assert.match(result, /Decision requested/)
})

test("from/to/text body are correct and no HTML is sent", async () => {
  const { toolDef, calls } = makeTool()
  await toolDef.execute(
    { subject: "Color choice", question: "Red or blue?" },
    { sessionID: "root-1" }
  )
  const mail = calls[0].mail
  assert.equal(mail.from, "sender@test.com")
  assert.equal(mail.to, "recipient@test.com")
  assert.equal(mail.text, "Decision: Red or blue?\n\nReply to this email with your answer")
  assert.equal(mail.html, undefined)
  assert.equal("html" in mail, false)
})

test("body renders context/options/recommendation when provided", async () => {
  const { toolDef, calls } = makeTool()
  await toolDef.execute(
    {
      subject: "Deploy",
      question: "选 A 还是 B？",
      context: "重构完成，95/95 测试通过",
      options: ["A. 原地迁移（快，30s 中断）", "B. 双写过渡（稳，多花 2h）"],
      recommendation: "推荐 A，内部工具低峰可接受",
    },
    { sessionID: "root-1" }
  )
  assert.equal(
    calls[0].mail.text,
    [
      "Context:",
      "重构完成，95/95 测试通过",
      "",
      "Decision: 选 A 还是 B？",
      "",
      "Options:",
      "- A. 原地迁移（快，30s 中断）",
      "- B. 双写过渡（稳，多花 2h）",
      "",
      "Recommendation: 推荐 A，内部工具低峰可接受",
      "",
      "Reply to this email with your answer",
    ].join("\n")
  )
})

test("registers the root session with the daemon before sending (no serverUrl — routing is gone)", async () => {
  const { toolDef, registerCalls } = makeTool()
  await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "root-1" })
  assert.equal(registerCalls.length, 1)
  assert.deepEqual(registerCalls[0], { sessionID: "root-1" })
})

test("alreadyPending from the daemon → A decision is already pending and NO second email", async () => {
  let n = 0
  const { toolDef, calls, registerCalls } = makeTool({
    registerDecision: async () => ({ alreadyPending: n++ > 0 }),
  })
  const ctx = { sessionID: "root-1" }

  const first = await toolDef.execute({ subject: "A", question: "one?" }, ctx)
  assert.match(first, /Decision requested/)
  assert.equal(calls.length, 1)

  const second = await toolDef.execute({ subject: "B", question: "two?" }, ctx)
  assert.equal(second, "A decision is already pending — wait for the reply")
  assert.equal(calls.length, 1, "no second email on alreadyPending")
  assert.equal(registerCalls.length, 2, "register consulted before each send")
})

test("transport throws -> [ERROR] and the reservation is released", async () => {
  const { toolDef, releaseCalls } = makeTool({ transport: "throw" })
  const result = await toolDef.execute(
    { subject: "X", question: "y?" },
    { sessionID: "root-1" }
  )
  assert.ok(typeof result === "string" && result.startsWith("[ERROR]"), result)
  assert.deepEqual(releaseCalls, ["root-1"], "SMTP failure must release the reserved decision")
})

test("daemon register throws -> still sends the email (degraded) without crashing", async () => {
  const { toolDef, calls } = makeTool({
    registerDecision: async () => {
      throw new Error("daemon unreachable")
    },
  })
  const result = await toolDef.execute(
    { subject: "X", question: "y?" },
    { sessionID: "root-1" }
  )
  assert.match(result, /Decision requested/)
  assert.equal(calls.length, 1, "the human must still be asked even if the daemon is down")
})

test("missing client returns an [ERROR] and does not throw", async () => {
  const toolDef = createRequestDecisionTool({ config, createTransport: () => ({ sendMail: async () => ({ messageId: "x" }) }) })
  const result = await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "root-1" })
  assert.ok(typeof result === "string" && result.startsWith("[ERROR]"), result)
})

test("unresolvable root (no session data) returns Call from the main session only", async () => {
  const noDataClient = { session: { get: async () => ({ error: "not found" }) } }
  const toolDef = createRequestDecisionTool({
    getClient: () => noDataClient,
    registerDecision: async () => ({ alreadyPending: false }),
    config,
    createTransport: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  })
  const result = await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "ghost" })
  assert.equal(result, "Call from the main session only")
})

test("subagent (session with a parentID) is rejected → Call from the main session only, no email, no register", async () => {
  const { toolDef, calls, registerCalls } = makeTool()
  const result = await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "child-1" })
  assert.equal(result, "Call from the main session only")
  assert.equal(calls.length, 0, "no email sent for a subagent")
  assert.equal(registerCalls.length, 0, "no register for a subagent")
})

// ---------------------------------------------------------------------------
// GLOBAL email-mode gate
// ---------------------------------------------------------------------------

test("mode 'off' → returns modeOff and sends NO email and NO register", async () => {
  const { toolDef, calls, registerCalls } = makeTool({ getMode: async () => "off" })
  const result = await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "root-1" })
  assert.equal(
    result,
    "Email mode is off — the human is at the screen. Use the question tool to ask in the conversation instead."
  )
  assert.equal(calls.length, 0, "no email when mode is off")
  assert.equal(registerCalls.length, 0, "no register when mode is off")
})

test("mode 'on' → proceeds normally (email sent, register called)", async () => {
  const { toolDef, calls, registerCalls } = makeTool({ getMode: async () => "on" })
  const result = await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "root-1" })
  assert.match(result, /Decision requested/)
  assert.equal(calls.length, 1, "email sent when mode is on")
  assert.equal(registerCalls.length, 1, "register called when mode is on")
})

test("the mode gate runs BEFORE the main-session check (off → modeOff even for a subagent)", async () => {
  const { toolDef, calls, registerCalls } = makeTool({ getMode: async () => "off" })
  const result = await toolDef.execute({ subject: "A", question: "b?" }, { sessionID: "child-1" })
  assert.equal(
    result,
    "Email mode is off — the human is at the screen. Use the question tool to ask in the conversation instead."
  )
  assert.equal(calls.length, 0, "no email")
  assert.equal(registerCalls.length, 0, "no register")
})

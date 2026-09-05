// afk notify_user unit tests — one-way FYI email tool.
//
// node:test + assert. Mocks the nodemailer transport (via the tool factory's
// `createTransport` dependency) so NO real mail is sent, and mocks the SDK
// client so no real OpenCode session is touched. notify_user has NO daemon
// register/release deps (it occupies no single-outstanding-decision slot), so
// there is nothing HTTP to mock — only the mode gate, which is injected.

import test from "node:test"
import assert from "node:assert/strict"

import { createNotifyUserTool } from "../notify.js"

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

function makeTool({ transport = "ok", getMode = undefined } = {}) {
  const calls = []
  const createTransport = (opts) => {
    const transporter = {
      sendMail: async (mail) => {
        calls.push({ opts, mail })
        if (transport === "throw") throw new Error("SMTP 550 mailbox unavailable")
        return { messageId: `<mock-${calls.length}@afk.test>` }
      },
    }
    return transporter
  }
  const toolDef = createNotifyUserTool({
    getClient: () => client,
    getDirectory: () => "/tmp/afk-test",
    getMode,
    config,
    createTransport,
  })
  return { toolDef, calls }
}

test("subject is stamped [omo:<rootSessionID>] and body carries message + reply hint", async () => {
  const { toolDef, calls } = makeTool()
  const result = await toolDef.execute(
    { subject: "Reactor done", message: "重构完成，95/95 测试通过" },
    { sessionID: "root-1" }
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mail.subject, "[omo:root-1] Reactor done")
  assert.equal(
    calls[0].mail.text,
    "重构完成，95/95 测试通过\n\nReply to this email to send feedback to the running session."
  )
  assert.match(result, /Notification emailed/)
})

test("from/to are correct and no HTML is sent", async () => {
  const { toolDef, calls } = makeTool()
  await toolDef.execute({ subject: "S", message: "m" }, { sessionID: "root-1" })
  const mail = calls[0].mail
  assert.equal(mail.from, "sender@test.com")
  assert.equal(mail.to, "recipient@test.com")
  assert.equal(mail.html, undefined)
  assert.equal("html" in mail, false)
})

test("transport throws -> returns [ERROR] (no reservation to release)", async () => {
  const { toolDef } = makeTool({ transport: "throw" })
  const result = await toolDef.execute({ subject: "X", message: "y" }, { sessionID: "root-1" })
  assert.ok(typeof result === "string" && result.startsWith("[ERROR]"), result)
})

test("missing client returns an [ERROR] and does not throw", async () => {
  const toolDef = createNotifyUserTool({
    config,
    createTransport: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  })
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "root-1" })
  assert.ok(typeof result === "string" && result.startsWith("[ERROR]"), result)
})

test("unresolvable root (no session data) returns Call from the main session only", async () => {
  const noDataClient = { session: { get: async () => ({ error: "not found" }) } }
  const toolDef = createNotifyUserTool({
    getClient: () => noDataClient,
    config,
    createTransport: () => ({ sendMail: async () => ({ messageId: "x" }) }),
  })
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "ghost" })
  assert.equal(result, "Call from the main session only")
})

test("subagent (session with a parentID) is rejected -> main session only, no email", async () => {
  const { toolDef, calls } = makeTool()
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "child-1" })
  assert.equal(result, "Call from the main session only")
  assert.equal(calls.length, 0, "no email sent for a subagent")
})

// ---------------------------------------------------------------------------
// GLOBAL email-mode gate
// ---------------------------------------------------------------------------

test("mode 'off' -> returns notifyModeOff and sends NO email", async () => {
  const { toolDef, calls } = makeTool({ getMode: async () => "off" })
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "root-1" })
  assert.equal(
    result,
    "Email mode is off — the human is at the screen. State the conclusion in the conversation instead of emailing."
  )
  assert.equal(calls.length, 0, "no email when mode is off")
})

test("mode 'on' -> proceeds normally (email sent)", async () => {
  const { toolDef, calls } = makeTool({ getMode: async () => "on" })
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "root-1" })
  assert.match(result, /Notification emailed/)
  assert.equal(calls.length, 1, "email sent when mode is on")
})

test("getMode throws -> treated as off (safe default), no email", async () => {
  const { toolDef, calls } = makeTool({
    getMode: async () => {
      throw new Error("daemon down")
    },
  })
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "root-1" })
  assert.equal(
    result,
    "Email mode is off — the human is at the screen. State the conclusion in the conversation instead of emailing."
  )
  assert.equal(calls.length, 0)
})

test("the mode gate runs BEFORE the main-session check (off -> notifyModeOff even for a subagent)", async () => {
  const { toolDef, calls } = makeTool({ getMode: async () => "off" })
  const result = await toolDef.execute({ subject: "A", message: "b" }, { sessionID: "child-1" })
  assert.equal(
    result,
    "Email mode is off — the human is at the screen. State the conclusion in the conversation instead of emailing."
  )
  assert.equal(calls.length, 0)
})

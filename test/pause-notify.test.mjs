// afk pause-notify unit tests.
//
// Proves the turn-end safety net: on `session.idle` for an owned ROOT session,
// a cooldown is armed; if the session stays quiet past it, ONE email is sent
// with the last assistant summary; activity cancels; non-owned / subagent /
// already-emailed-by-tool / mode-off sessions never email. Real (short) timers.
// No network, no IMAP/SMTP — the email sink is injected.

import { test } from "node:test"
import assert from "node:assert/strict"

import { createPauseNotifier } from "../core/pause-notify.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, timeoutMs = 2000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(stepMs)
  }
  return cond()
}

const COOLDOWN = 20

// A root session in /proj with a final assistant text message.
function makeHarness({
  cooldownMs = COOLDOWN,
  mode = "on",
  sessions = {},
  messagesBySession = {},
} = {}) {
  const sent = []
  const client = {
    session: {
      get: async ({ path }) =>
        path?.id in sessions ? { data: sessions[path.id] } : { error: { status: 404 } },
      messages: async ({ path }) =>
        path?.id in messagesBySession ? { data: messagesBySession[path.id] } : { error: { status: 404 } },
    },
  }
  const notifier = createPauseNotifier({
    directory: "/proj",
    getClient: () => client,
    getMode: async () => mode,
    cooldownMs,
    sendEmail: async (mail) => sent.push(mail),
  })
  return { notifier, sent }
}

function rootSession(overrides = {}) {
  return { id: "ses_root", directory: "/proj", parentID: undefined, title: "my task", ...overrides }
}

function assistantMessage(parts) {
  return { info: { role: "assistant" }, parts }
}

const TEXT = [{ type: "text", text: "重构完成，95/95 测试通过" }]
const TOOL_CALL = [{ type: "tool", tool: "request_decision", callID: "c1" }]

test("idle + quiet past cooldown -> one email with the last assistant summary", async () => {
  const { notifier, sent } = makeHarness({
    sessions: { ses_root: rootSession() },
    messagesBySession: { ses_root: [assistantMessage(TEXT)] },
  })
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  assert.equal(await until(() => sent.length === 1), true)
  assert.deepEqual(sent[0], { sessionID: "ses_root", title: "my task", summary: "重构完成，95/95 测试通过" })
  // No duplicate from a second idle while the first wait already fired.
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  await sleep(COOLDOWN * 3)
  assert.equal(sent.length, 2, "each burst end emails once")
})

test("activity during the cooldown cancels the pending email", async () => {
  const { notifier, sent } = makeHarness({
    sessions: { ses_root: rootSession() },
    messagesBySession: { ses_root: [assistantMessage(TEXT)] },
  })
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  await notifier.handleEvent({ event: { type: "message.updated", properties: { sessionID: "ses_root" } } })
  await sleep(COOLDOWN * 3)
  assert.equal(sent.length, 0, "a resumed turn must cancel the pending email")
})

test("session not in this directory -> no email", async () => {
  const { notifier, sent } = makeHarness({
    sessions: { ses_other: rootSession({ directory: "/other" }) },
    messagesBySession: { ses_other: [assistantMessage(TEXT)] },
  })
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_other" } } })
  await sleep(COOLDOWN * 3)
  assert.equal(sent.length, 0)
})

test("subagent session (has parentID) -> no email", async () => {
  const { notifier, sent } = makeHarness({
    sessions: { ses_child: rootSession({ parentID: "ses_root" }) },
    messagesBySession: { ses_child: [assistantMessage(TEXT)] },
  })
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  await sleep(COOLDOWN * 3)
  assert.equal(sent.length, 0)
})

test("turn that ended with request_decision/notify_user -> no duplicate email", async () => {
  for (const tool of ["request_decision", "notify_user"]) {
    const { notifier, sent } = makeHarness({
      sessions: { ses_root: rootSession() },
      messagesBySession: { ses_root: [assistantMessage([...TOOL_CALL, ...TEXT])] },
    })
    await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
    await sleep(COOLDOWN * 3)
    assert.equal(sent.length, 0, `${tool} turn already emailed the human`)
  }
})

test("mode off -> no email", async () => {
  const { notifier, sent } = makeHarness({
    mode: "off",
    sessions: { ses_root: rootSession() },
    messagesBySession: { ses_root: [assistantMessage(TEXT)] },
  })
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  await sleep(COOLDOWN * 3)
  assert.equal(sent.length, 0)
})

test("no assistant text (nothing to summarize) -> no email", async () => {
  const { notifier, sent } = makeHarness({
    sessions: { ses_root: rootSession() },
    messagesBySession: { ses_root: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }] },
  })
  await notifier.handleEvent({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
  await sleep(COOLDOWN * 3)
  assert.equal(sent.length, 0)
})

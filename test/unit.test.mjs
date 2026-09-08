// afk T8 unit tests — gap-fill cases.
//
// Two genuine cross-module gaps:
//
//   1. SUBJECT-TOKEN ROUND-TRIP: request_decision stamps `[omo:<rootSessionID>]`
//      and reply-parse must extract that exact token back. The per-module tests
//      cover stamping and extraction in isolation, but never prove the token
//      produced is the one recovered — and request_decision's own test uses a
//      non-`ses_` fixture, so it cannot round-trip. This test uses a real
//      `ses_...` id.
//   2. MULTIPART BODY EXTRACTION: a multipart/alternative MIME message must
//      yield the text/plain part (preferred over text/html), end to end through
//      real mailparser → toStructuredEmail → parseReply.
//
// No network, no IMAP/SMTP, no live opencode server.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { simpleParser } from "mailparser"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Redirect the shared secret to a throwaway temp file BEFORE importing the
// modules that read it (mailer/secret).
const tmp = mkdtempSync(join(tmpdir(), "afk-unit-"))
process.env.AFK_DAEMON_SECRET = join(tmp, "daemon-secret")

const { createRequestDecisionTool } = await import("../request-decision.js")
const { extractToken, parseReply } = await import("../core/reply-parse.js")
const { toStructuredEmail } = await import("../core/process.js")

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Subject-token round-trip (request_decision stamp ↔ reply-parse extract)
// ---------------------------------------------------------------------------

test("round-trip: request_decision stamps [omo:<rootSessionID>] that reply-parse extracts back", async () => {
  const sessions = {
    ses_child: { id: "ses_child", parentID: "ses_root123" },
    ses_root123: { id: "ses_root123", parentID: undefined },
  }
  const client = {
    session: {
      get: async ({ path }) => {
        const sessionID = path?.id
        const data = sessions[sessionID]
        return data ? { data } : { error: "not found" }
      },
    },
  }

  let stampedSubject = null
  const createTransport = () => ({
    sendMail: async (mail) => {
      stampedSubject = mail.subject
      return { messageId: "<mock-roundtrip@afk.test>" }
    },
  })

  const toolDef = createRequestDecisionTool({
    getClient: () => client,
    getDirectory: () => "/tmp/afk-test",
    registerDecision: async () => ({ alreadyPending: false }),
    config: {
      smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "sender@test.com", password: "s" },
      recipient: "recipient@test.com",
      folder: "INBOX",
    },
    createTransport,
  })

  const res = await toolDef.execute(
    { subject: "Approve deployment?", question: "Should we deploy?" },
    { sessionID: "ses_root123" }
  )
  assert.match(res, /Decision requested/)
  assert.match(stampedSubject, /^\[omo:ses_root123\.[a-f0-9]{32}\] Approve deployment\?$/)

  // reply-parse must recover the very same token request_decision stamped, from
  // the human's reply.
  const replySubject = `Re: ${stampedSubject}`
  assert.equal(extractToken(replySubject), "ses_root123")
  const parsed = parseReply({
    subject: replySubject,
    from: "recipient@test.com",
    inReplyTo: null,
    text: "go ahead",
    html: "",
  })
  assert.equal(parsed.sessionID, "ses_root123")
  assert.equal(parsed.body, "go ahead")
})

// ---------------------------------------------------------------------------
// 2. Multipart body extraction (text/plain preferred over text/html)
// ---------------------------------------------------------------------------

test("multipart: text/plain part is extracted over the text/html part", async () => {
  const raw = [
    'From: "Human" <human@example.com>',
    "To: agent@qq.com",
    "Subject: Re: [omo:ses_mt] choice",
    "In-Reply-To: <abc@example.com>",
    "Message-ID: <xyz@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=XYZ",
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain body here",
    "--XYZ",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html body</p>",
    "--XYZ--",
  ].join("\r\n")

  const parsed = await simpleParser(raw)
  const structured = toStructuredEmail(parsed)

  assert.equal(structured.text, "plain body here")
  assert.equal(structured.html, "<p>html body</p>")

  const reply = parseReply(structured)
  assert.equal(reply.sessionID, "ses_mt")
  assert.equal(reply.body, "plain body here")
})

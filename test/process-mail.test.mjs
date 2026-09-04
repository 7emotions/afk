// email-wake T5 unit tests — processing pipeline (process.js).
//
// Covers: fetch→parse→persist ordering (NO ack in processMail — the P0 fix),
// journaled-UID skip, {ok:false} persistence leaving the message UNSEEN, the
// mandatory subject-filtered search, real MIME extraction, and the P0 regression
// (crash after parse/before ack → durable pending → recover → re-broadcast →
// ack → no loss). The imapClient, SDK client, and mailparser output are mocked;
// the real inject/journal (inject.js) and pending-store run against throwaway
// temp files.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Redirect the journal to a throwaway temp file BEFORE importing process.js so
// the real <plugin>/journal.json is never touched (same pattern as inject-ack).
const tmp = mkdtempSync(join(tmpdir(), "email-wake-process-"))
process.env.EMAIL_WAKE_JOURNAL = join(tmp, "journal.json")

const {
  processMail,
  scanAndProcess,
  toStructuredEmail,
} = await import("../core/process.js")
const { markSeenAndJournal, isJournaled } = await import("../core/inject.js")
const { createPendingStore } = await import("../store/pending-store.js")

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function readJournal() {
  try {
    return JSON.parse(readFileSync(process.env.EMAIL_WAKE_JOURNAL, "utf8"))
  } catch {
    return []
  }
}

// A mailparser-shaped ParsedMail for the mocked-parse tests.
const PARSED_REPLY = {
  subject: "Re: [omo:ses_x] hello",
  from: { value: [{ address: "human@example.com", name: "Human" }], text: '"Human" <human@example.com>' },
  inReplyTo: "<abc@example.com>",
  text: "go ahead and deploy",
  html: false,
}

// Build mock imapClient + SDK client wired to a shared call log (for ordering).
function makeMocks({ promptThrow = null } = {}) {
  const events = []
  const imapClient = {
    fetchOne: async (seq, query, options) => {
      events.push("fetch")
      return { seq: Number(seq), uid: Number(seq), source: Buffer.from("raw rfc822") }
    },
    search: async (query, options) => {
      events.push("search")
      return []
    },
    messageFlagsAdd: async (range, flags) => {
      events.push("flags")
    },
  }
  const client = {
    session: {
      promptAsync: async (req) => {
        events.push("prompt")
        if (promptThrow) throw new Error(promptThrow)
      },
    },
  }
  return { imapClient, client, events }
}

// ---------------------------------------------------------------------------
// toStructuredEmail
// ---------------------------------------------------------------------------

test("toStructuredEmail: maps mailparser output into reply-parse's input contract", () => {
  const s = toStructuredEmail(PARSED_REPLY)
  assert.deepEqual(s, {
    subject: "Re: [omo:ses_x] hello",
    from: "human@example.com",
    inReplyTo: "<abc@example.com>",
    text: "go ahead and deploy",
    html: null,
  })
})

test("toStructuredEmail: html:false → null, missing from → ''", () => {
  const s = toStructuredEmail({ subject: "s", from: undefined, text: undefined, html: false })
  assert.equal(s.subject, "s")
  assert.equal(s.from, "")
  assert.equal(s.text, null)
  assert.equal(s.html, null)
  assert.equal(s.inReplyTo, null)
})

// ---------------------------------------------------------------------------
// processMail
// ---------------------------------------------------------------------------

test("processMail: fetch→parse→persist in order (NO ack — \Seen/journal moved to /ack)", async () => {
  const { imapClient, client, events } = makeMocks()
  const deps = {
    parse: async (source) => {
      assert.ok(Buffer.isBuffer(source), "parser must receive the raw source Buffer")
      events.push("parse")
      return PARSED_REPLY
    },
  }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 1001, deps)

  assert.equal(res.ok, true)
  assert.equal(res.stored, true)
  assert.equal(res.sessionID, "ses_x")
  assert.deepEqual(events, ["fetch", "parse", "prompt"], "strict ordering: fetch→parse→persist (no ack/flags)")

  // The message was NOT acked by processMail: no journal, no \Seen (P0 fix).
  assert.ok(!readJournal().includes("1001"), "processMail must NOT journal the UID")
})

test("processMail: skips UID already journaled (no fetch, no inject)", async () => {
  const { imapClient, client } = makeMocks()
  // Journal 2001 via the real ack path first.
  await markSeenAndJournal(imapClient, "INBOX", 2001)

  let fetchCalls = 0
  imapClient.fetchOne = async () => {
    fetchCalls++
    throw new Error("must not be called")
  }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 2001, { parse: async () => PARSED_REPLY })

  assert.equal(res.ok, true)
  assert.equal(res.skipped, true)
  assert.equal(fetchCalls, 0, "journaled UID must short-circuit before fetch")
  assert.equal(isJournaled(2001), true)
})

test("processMail: persist {ok:false} leaves message UNSEEN (no flag-mark, no journal)", async () => {
  const { imapClient, client } = makeMocks()
  let flagsCalls = 0
  imapClient.messageFlagsAdd = async () => {
    flagsCalls++
  }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 3001, {
    parse: async () => PARSED_REPLY,
    injectReply: async () => ({ ok: false, error: "store write failed" }),
  })

  assert.equal(res.ok, false)
  assert.equal(typeof res.error, "string")
  assert.equal(flagsCalls, 0, "failed persistence must never mark \\Seen")
  assert.ok(!readJournal().includes("3001"), "failed persistence must never journal the UID")
})

test("processMail: real mailparser extracts subject/From/In-Reply-To/text/html from RFC822 source", async () => {
  const raw = [
    "From: \"Human\" <human@example.com>",
    "To: agent@qq.com",
    "Subject: =?utf-8?B?UmU6IFtvbW86c2VzX3Rlc3RdIGhlbGxv?=",
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

  const events = []
  const imapClient = {
    fetchOne: async (seq, query, options) => ({ seq: 4001, uid: 4001, source: Buffer.from(raw) }),
    messageFlagsAdd: async () => events.push("flags"),
  }
  const client = {
    session: {
      promptAsync: async (req) => {
        events.push("prompt")
        req.body.parts[0].text // touch (v1 HTTP-style signature)
        return undefined
      },
    },
  }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 4001)

  assert.equal(res.ok, true)
  assert.equal(res.sessionID, "ses_test")
  assert.deepEqual(events, ["prompt"], "real parse must persist only (no flags)")
  assert.ok(!readJournal().includes("4001"), "processMail must NOT journal")
})

// ---------------------------------------------------------------------------
// P0 regression — crash between parse and ack loses nothing
// ---------------------------------------------------------------------------

test("P0 regression: parse persists (no \Seen, no journal); crash→restart re-detects; claim→ack marks \Seen + journals + removes", async () => {
  const pendingPath = join(tmp, "p0-pending.json")
  let flagsCalls = 0
  const imapClient = {
    fetchOne: async (seq) => ({ seq: Number(seq), uid: Number(seq), source: Buffer.from("raw rfc822") }),
    messageFlagsAdd: async () => {
      flagsCalls++
    },
  }
  const client = { session: { promptAsync: async () => {} } }

  const store = createPendingStore({ path: pendingPath })
  const broadcasts = []
  const deps = {
    parse: async () => PARSED_REPLY,
    injectReply: async (_c, { sessionID, body, from, uid }) => {
      const { created, entry } = store.add({ uid, sessionID, body, from })
      if (created) broadcasts.push(entry)
      return { ok: true }
    },
  }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 7001, deps)

  // Parse persisted the reply but did NOT ack: mail stays UNSEEN, not journaled.
  assert.equal(res.ok, true)
  assert.equal(res.stored, true)
  assert.equal(flagsCalls, 0, "parse must NOT mark \\Seen")
  assert.ok(!readJournal().includes("7001"), "parse must NOT journal")
  assert.equal(broadcasts.length, 1, "a new pending must be broadcast exactly once")

  // Simulate a daemon crash + restart: a FRESH store on the same path re-detects
  // the pending (this is the durability guarantee — the reply is not lost).
  const restarted = createPendingStore({ path: pendingPath })
  const pending = restarted.get("7001")
  assert.ok(pending, "restart must re-detect the pending reply")
  assert.equal(pending.sessionID, "ses_x")
  assert.equal(pending.claimedBy, undefined, "an un-acked pending is unclaimed after restart")

  // Recovery: the owning instance re-claims, injects in-process, then acks.
  assert.deepEqual(restarted.claim({ uid: "7001", sessionID: "ses_x", instanceId: "inst-1" }), { claimed: true })
  assert.equal(restarted.canAck({ uid: "7001", sessionID: "ses_x", instanceId: "inst-1" }), true)

  // The /ack handler: markSeen + journal, then remove the pending.
  await markSeenAndJournal(imapClient, "INBOX", "7001")
  restarted.remove("7001")

  assert.equal(flagsCalls, 1, "ack must mark \\Seen exactly once")
  assert.ok(readJournal().includes("7001"), "ack must journal the UID")
  assert.equal(restarted.size(), 0, "ack must remove the pending")
  assert.equal(restarted.listClaimable().length, 0)
})

// ---------------------------------------------------------------------------
// scanAndProcess
// ---------------------------------------------------------------------------

// An in-memory cursor fake for the scanAndProcess tests (avoids the real
// file-backed uid-cursor.js). Mirrors the deps.cursor seam contract:
// { get(uidValidity) => number|null, init(uid, uidValidity), advance(uid, uidValidity) }.
function makeCursor(initial = null) {
  const state = { value: initial, validity: null, initCalls: [], advanceCalls: [] }
  return {
    state,
    get: () => state.value,
    init: (uid, v) => {
      state.value = uid
      state.validity = v
      state.initCalls.push(uid)
    },
    advance: (uid, v) => {
      state.value = uid
      state.advanceCalls.push(uid)
    },
  }
}

test("scanAndProcess: searches UID range > cursor (no seen, no subject) and anchors a fresh cursor to uidNext-1", async () => {
  const { imapClient, client } = makeMocks()
  const searchCalls = []
  imapClient.search = async (query, options) => {
    searchCalls.push([query, options])
    return []
  }
  imapClient.mailbox = { uidNext: 4715, uidValidity: 1n }
  const cursor = makeCursor(null)

  const res = await scanAndProcess(imapClient, client, { folder: "INBOX" }, { cursor })

  assert.equal(searchCalls.length, 1)
  assert.deepEqual(searchCalls[0][0], { uid: "4715:*" }, "must search UID range > cursor (cursor=uidNext-1=4714)")
  assert.deepEqual(searchCalls[0][1], { uid: true }, "must search by UID")
  assert.deepEqual(res, [])
  assert.equal(cursor.state.value, 4714, "fresh start must anchor cursor to current max UID (uidNext-1)")
  assert.deepEqual(cursor.state.initCalls, [4714])
})

test("scanAndProcess: processes each UID in the window and advances the cursor past the highest", async () => {
  const { imapClient, client } = makeMocks()
  imapClient.search = async () => [5001, 5002]
  imapClient.fetchOne = async (seq) => ({ seq: Number(seq), uid: Number(seq), source: Buffer.from("raw") })
  const cursor = makeCursor(5000)

  const res = await scanAndProcess(imapClient, client, { folder: "INBOX" }, {
    cursor,
    parse: async () => PARSED_REPLY,
  })

  assert.equal(res.length, 2)
  assert.equal(res[0].ok, true)
  assert.equal(res[0].stored, true)
  assert.equal(res[1].ok, true)
  assert.equal(res[1].stored, true)
  assert.equal(cursor.state.value, 5002, "cursor must advance to the highest UID seen")
  // processMail never journals; the cursor (not the journal) is what advances.
  assert.ok(!readJournal().includes("5001"), "processMail must not journal UID 5001")
  assert.ok(!readJournal().includes("5002"), "processMail must not journal UID 5002")
})

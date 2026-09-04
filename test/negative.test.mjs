// email-wake negative-path unit tests (T11).
//
// Dedicated negative cases for the two failure modes that MUST leave the source
// message untouched (so it is retried on a later scan):
//
//   (a) session-gone  — injection returns {ok:false} → NO ack: the message
//       stays UNSEEN and is never journaled, so a later scan retries it.
//   (b) duplicate UID — the same UID is delivered twice (IDLE push + catch-up,
//       or a re-delivery) → the journal dedupe guard short-circuits it, so the
//       message is injected exactly once.
//
// Both are exercised through processMail (process.js) with injected fakes: a
// fake injectReply returning {ok:false}, and a fake isJournaled returning true.
// The real journal is redirected to a throwaway temp file before import so the
// plugin's real <plugin>/journal.json is never touched.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Redirect the journal to a throwaway temp file BEFORE importing process.js so
// the real <plugin>/journal.json is never touched (same pattern as inject-ack
// and process-mail tests).
const tmp = mkdtempSync(join(tmpdir(), "email-wake-negative-"))
process.env.EMAIL_WAKE_JOURNAL = join(tmp, "journal.json")

const { processMail } = await import("../process.js")

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// Read the (redirected) journal tolerantly: a failed injection never acks, so
// the journal file may not exist yet — treat a missing file as an empty array
// (mirrors inject.js's own readJournal semantics).
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

// (a) ------------------------------------------------------------------------
// session-gone: a valid reply whose target session no longer exists surfaces as
// an injection {ok:false}. processMail must return ok:false and MUST NOT ack
// (no \Seen flag-mark, no journal append) so the message stays UNSEEN.

test("negative: inject {ok:false} (session gone) leaves message UNSEEN — no ack, no journal", async () => {
  let fetchCalls = 0
  let injectCalls = 0

  const imapClient = {
    fetchOne: async (seq) => {
      fetchCalls++
      return { seq: Number(seq), uid: Number(seq), source: Buffer.from("raw rfc822") }
    },
  }
  const client = { session: { promptAsync: async () => {} } }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 3001, {
    parse: async () => PARSED_REPLY,
    // A failed persistence/injection surfaces as {ok:false}. processMail never
    // acks (no \Seen, no journal), so the message stays UNSEEN for a later scan.
    injectReply: async () => {
      injectCalls++
      return { ok: false, error: "Unexpected server error (500)" }
    },
  })

  assert.equal(res.ok, false, "injection failure must report ok:false")
  assert.equal(typeof res.error, "string")
  assert.ok(res.error.length > 0)
  assert.equal(injectCalls, 1, "inject must have been attempted exactly once")
  assert.equal(fetchCalls, 1, "fetch must have run once")
  // Belt-and-braces: the (redirected) real journal must not contain the UID.
  assert.ok(!readJournal().includes("3001"), "failed injection must never journal the UID")
})

// (b) ------------------------------------------------------------------------
// duplicate delivery: the same UID is delivered more than once (e.g. an IDLE
// push overlapping a catch-up scan). The journal dedupe guard (isJournaled)
// must short-circuit before fetch/inject, so the message is processed once.

test("negative: duplicate UID delivery is processed once — journal dedupe short-circuits", async () => {
  let fetchCalls = 0
  let injectCalls = 0

  const imapClient = {
    fetchOne: async () => {
      fetchCalls++
      throw new Error("must not be called for an already-journaled UID")
    },
  }
  const client = { session: { promptAsync: async () => {} } }

  const res = await processMail(imapClient, client, { folder: "INBOX" }, 4001, {
    parse: async () => PARSED_REPLY,
    injectReply: async () => {
      injectCalls++
      return { ok: true }
    },
    // The fake journal says this UID was already processed.
    isJournaled: () => true,
  })

  assert.equal(res.ok, true)
  assert.equal(res.skipped, true, "already-journaled UID must be reported as skipped")
  assert.equal(fetchCalls, 0, "journaled UID must short-circuit before fetch")
  assert.equal(injectCalls, 0, "journaled UID must never be injected again")
})

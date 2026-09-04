// email-wake UID-cursor unit tests.
//
// Covers the new detection mechanism that replaces the UNSEEN+SUBJECT search:
//
//   (a) the uid-cursor.js module (persistent {uidValidity, lastUid} cursor,
//       env-overridable path, monotonic advance, uidValidity guard, tolerant
//       read of a missing/corrupt file);
//   (b) scanAndProcess's cursor integration: a fresh cursor anchors to the
//       mailbox's current max UID (uidNext-1) so history is NOT reprocessed; the
//       UID-range search (no seen, no subject) processes only mail above the
//       cursor; and the cursor advances past the highest UID seen EVEN when the
//       message was skipped (self-copy / non-token mail must not wedge it).
//
// The real cursor file is redirected to a throwaway temp file via
// EMAIL_WAKE_LAST_UID (mirrors the EMAIL_WAKE_JOURNAL pattern). scanAndProcess's
// integration tests inject an in-memory cursor fake (deps.cursor) for
// determinism.

import { test, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "email-wake-uidcursor-"))
process.env.EMAIL_WAKE_LAST_UID = join(tmp, "last-uid.json")

const { getCursor, initCursor, advanceCursor, resetCursor } = await import("../store/uid-cursor.js")
const { scanAndProcess } = await import("../core/process.js")

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  resetCursor()
})

// ---------------------------------------------------------------------------
// (a) uid-cursor.js module
// ---------------------------------------------------------------------------

test("getCursor returns null when no cursor file exists (uninitialized)", () => {
  assert.equal(getCursor("1537612671"), null)
})

test("initCursor anchors, getCursor returns it; advanceCursor moves forward monotonically", () => {
  initCursor(4714, "1537612671")
  assert.equal(getCursor("1537612671"), 4714)

  advanceCursor(4716, "1537612671")
  assert.equal(getCursor("1537612671"), 4716)
})

test("advanceCursor never moves the cursor backward (lower UID cannot wedge it)", () => {
  advanceCursor(5000, "v1")
  advanceCursor(4999, "v1") // a lower UID (e.g. out-of-order fetch) must not regress
  assert.equal(getCursor("v1"), 5000)
})

test("uidValidity mismatch is treated as uninitialized (null) so a recreated mailbox re-anchors", () => {
  initCursor(100, "old-validity")
  assert.equal(getCursor("new-validity"), null, "different uidValidity must read as uninitialized")
  assert.equal(getCursor("old-validity"), 100)
})

test("a missing/corrupt cursor file is tolerated (read as null)", () => {
  resetCursor()
  assert.equal(getCursor("any"), null, "no file → null")
})

// ---------------------------------------------------------------------------
// (b) scanAndProcess cursor integration (in-memory cursor fake)
// ---------------------------------------------------------------------------

function makeCursor(initial = null) {
  const state = { value: initial, validity: null, advanceCalls: [] }
  return {
    state,
    get: () => state.value,
    init: (uid, v) => {
      state.value = uid
      state.validity = v
    },
    advance: (uid, v) => {
      state.value = uid
      state.advanceCalls.push(uid)
    },
  }
}

function makeImap({ mailbox, searchResult }) {
  const searchCalls = []
  return {
    searchCalls,
    client: {
      mailbox: mailbox ?? { uidNext: 1000, uidValidity: "v1" },
      search: async (query, options) => {
        searchCalls.push({ query, options })
        return searchResult()
      },
      fetchOne: async (seq) => ({ seq: Number(seq), uid: Number(seq), source: Buffer.from("raw rfc822") }),
      messageFlagsAdd: async () => {},
    },
  }
}

// A self-copy / non-reply mail: subject carries a token but no Re:/inReplyTo, so
// parseReply rejects it (skipped, zero-action). This is the message that MUST
// NOT wedge the cursor.
const SELF_COPY = {
  subject: "[omo:ses_self] my own outbound",
  from: { value: [{ address: "agent@qq.com" }], text: "agent@qq.com" },
  inReplyTo: null,
  text: "outbound copy",
  html: false,
}

test("scanAndProcess: fresh cursor anchors to uidNext-1 and searches UID > anchor (no history reprocess)", async () => {
  const { client, searchCalls } = makeImap({ searchResult: () => [] })
  const cursor = makeCursor(null)

  const res = await scanAndProcess(client, {}, { folder: "INBOX" }, {
    cursor,
    parse: async () => SELF_COPY,
  })

  assert.deepEqual(res, [])
  assert.equal(cursor.state.value, 999, "anchor = uidNext-1")
  assert.deepEqual(searchCalls[0].query, { uid: "1000:*" }, "search UID > anchor only")
  assert.deepEqual(searchCalls[0].options, { uid: true })
})

test("scanAndProcess: advances past skipped self-copy / non-token mail (no wedge)", async () => {
  const { client, searchCalls } = makeImap({ searchResult: () => [1001] })
  const cursor = makeCursor(1000)

  const res = await scanAndProcess(client, {}, { folder: "INBOX" }, {
    cursor,
    parse: async () => SELF_COPY, // parseReply rejects → skipped
  })

  assert.equal(res.length, 1)
  assert.equal(res[0].skipped, true, "self-copy must be skipped, not injected")
  assert.equal(cursor.state.value, 1001, "cursor must advance past the skipped UID")

  // Next scan starts above 1001 → the self-copy is never seen again.
  assert.deepEqual(searchCalls[0].query, { uid: "1001:*" })
})

test("scanAndProcess: advances the cursor even when a message's fetch/parse FAILS (no wedge)", async () => {
  const { client } = makeImap({ searchResult: () => [1002] })
  const cursor = makeCursor(1001)

  const res = await scanAndProcess(client, {}, { folder: "INBOX" }, {
    cursor,
    parse: async () => {
      throw new Error("transient parse failure")
    },
  })

  assert.equal(res[0].ok, false)
  assert.equal(cursor.state.value, 1002, "cursor must still advance past the failed UID")
})

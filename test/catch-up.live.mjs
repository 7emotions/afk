// afk T5 integration test (real QQ account).
//
// Verifies the end-to-end "new mail → fetch → parse → inject → ack" path
// against a live imap.qq.com connection, exercising BOTH entry paths:
//
//   1. CATCH-UP (onReady): a Re: [omo:<token>] mail is sent and confirmed
//      delivered to INBOX BEFORE the watcher starts (simulating a gap while
//      "offline"); starting the watcher must reconcile it via the one-time
//      catch-up scan after mailboxOpen.
//   2. LIVE (onMail): a second Re: [omo:<token2>] mail is sent while IDLE is
//      engaged; the IDLE "exists" push must fetch + parse it event-driven.
//
// Injection is mocked/observed (no live opencode server); the real IMAP
// search/fetch, real mailparser MIME extraction, and the real ack
// (mark \Seen + journal) all run against the real account. The journal is
// redirected to a throwaway temp file so the plugin's real journal is untouched.
//
// Tokens are run-unique (ses_<epoch>) so cross-run leftovers can never collide
// with this run's assertions. A transient IMAP connection (used only for
// cleanup + delivery confirmation, closed before the watcher starts) makes the
// test deterministic against QQ's variable self-send delivery latency. The
// plugin's own runtime path uses the single watcher connection, as required.

import nodemailer from "nodemailer"
import { ImapFlow } from "imapflow"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Redirect the journal AND the UID cursor BEFORE importing watcher.js/process.js
// (which transitively import inject.js / uid-cursor.js, whose paths are captured
// at module load).
const tmp = mkdtempSync(join(tmpdir(), "afk-catchup-"))
process.env.AFK_JOURNAL = join(tmp, "journal.json")
process.env.AFK_LAST_UID = join(tmp, "last-uid.json")

const { loadConfig } = await import("../config.js")
const { startWatcher, stopWatcher, isWatcherHealthy } = await import("../core/watcher.js")
const { scanAndProcess } = await import("../core/process.js")

const config = loadConfig()
const recipient = config.recipient || config.smtp.user

// Run-unique tokens (all-alnum after "ses_", so reply-parse's token regex
// `ses_[A-Za-z0-9]+` captures the whole thing; uniqueness removes any
// cross-run / substring ambiguity).
const token1 = `ses_${Date.now()}`
const token2 = `ses_${Date.now() + 1}`

// Hard safety: never let the script hang past 200s.
setTimeout(() => {
  console.error("[TEST] global timeout (200s) reached — aborting")
  process.exit(2)
}, 200000)

let failures = 0
function check(name, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL"
  console.log(`[${mark}] ${name}${extra ? " — " + extra : ""}`)
  if (!cond) failures++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await sleep(100)
  }
  return false
}

async function sendSelfEmail(token, body) {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  })
  const info = await transporter.sendMail({
    from: config.smtp.user,
    to: recipient,
    subject: `Re: [omo:${token}] hello`,
    text: body,
  })
  console.log(`[SMTP] sent Re:[omo:${token}]: messageId=${info.messageId}`)
  return info
}

// Transient IMAP connection (TEST harness only — closed before the watcher runs).
function makeImap() {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  })
}

async function withImap(fn) {
  const imap = makeImap()
  await imap.connect()
  await imap.mailboxOpen(config.folder)
  try {
    return await fn(imap)
  } finally {
    await imap.logout().catch(() => {})
  }
}

// Mark every currently-unseen [omo: message as \Seen so leftover state from a
// previous (possibly failed) run cannot pollute this run's assertions. Each UID
// is marked as a `{uid}` object (imapflow resolves that to UID mode — passing a
// bare array would be treated as sequence numbers and silently no-op).
async function clearLeftovers() {
  await withImap(async (imap) => {
    const uids = await imap.search({ seen: false, subject: "[omo:" }, { uid: true })
    if (Array.isArray(uids) && uids.length > 0) {
      for (const uid of uids) {
        await imap.messageFlagsAdd({ uid }, ["\\Seen"])
      }
      console.log(`[CLEANUP] marked ${uids.length} leftover [omo: message(s) seen`)
    }
  })
}

// Wait until an UNSEEN message carrying the given [omo:<token>] subject exists.
async function waitForDelivery(token, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await withImap(async (imap) => {
      const uids = await imap.search({ seen: false, subject: `[omo:${token}` }, { uid: true })
      return Array.isArray(uids) && uids.length > 0
    })
    if (found) {
      console.log(`[DELIVERY] Re:[omo:${token}] present in INBOX (unseen)`)
      return true
    }
    if (Date.now() > deadline) return false
    await sleep(1000)
  }
}

// Observed injection results. The mock injectReply records the parsed reply and
// reports success, so the real ack (mark \Seen + journal) runs afterward. Note
// the (client, args) signature matches inject.js's injectReply.
const injected = []
const mockInjectReply = async (_client, { sessionID, body, from }) => {
  injected.push({ sessionID, body, from })
  console.log(`[INJECT-observed] sessionID=${sessionID} body=${JSON.stringify(body)} from=${from}`)
  return { ok: true }
}

// Shared handler for onReady (catch-up) and onMail (live): run the same
// subject-filtered scan + process against the live client, with inject mocked.
//
// The scan is retried (bounded, event-driven — still a single subject-filtered
// search per attempt) because QQ's IMAP SUBJECT search index lags message
// delivery by several seconds: a just-delivered message is fetchable by
// sequence number but not searchable by subject. For catch-up the first attempt
// already succeeds; for the live path the retries let the index catch up.
const handler = (imapClient) =>
  (async () => {
    const deadline = Date.now() + 60000
    for (;;) {
      const results = await scanAndProcess(imapClient, {}, config, { injectReply: mockInjectReply })
      if (results.length > 0) return
      if (Date.now() > deadline) return
      await sleep(2000)
    }
  })()

// ---------------------------------------------------------------------------
await clearLeftovers()

console.log("=== PHASE 1: CATCH-UP (mail delivered while offline, then watcher starts) ===")
await sendSelfEmail(token1, "hello from integration test (catch-up)")
const delivered1 = await waitForDelivery(token1, 60000)
check(`Re:[omo:${token1}] delivered to INBOX while offline`, delivered1)

await startWatcher(config, { onReady: handler, onMail: handler })
console.log("[START] watcher started; catch-up scan should run on connect")

const healthy = await waitFor(() => isWatcherHealthy(), 10000)
check("watcher healthy after start", healthy, `isWatcherHealthy=${isWatcherHealthy()}`)

const caughtUp = await waitFor(() => injected.some((r) => r.sessionID === token1), 30000)
check(
  "catch-up (onReady) fetched + parsed Re:[omo:<token1>]",
  caughtUp,
  `observed=${JSON.stringify(injected.map((r) => r.sessionID))}`
)

// ---------------------------------------------------------------------------
console.log("=== PHASE 2: LIVE IDLE (mail sent while watcher is idle) ===")
await sleep(2000) // let IDLE fully engage after the catch-up scan
await sendSelfEmail(token2, "world from integration test (live)")

const liveGot = await waitFor(() => injected.some((r) => r.sessionID === token2), 90000)
check(
  "live IDLE (onMail) fetched + parsed Re:[omo:<token2>]",
  liveGot,
  `observed=${JSON.stringify(injected.map((r) => r.sessionID))}`
)

// Assert the parsed body/from were extracted correctly from the caught-up mail.
const first = injected.find((r) => r.sessionID === token1)
if (first) {
  check("catch-up parsed body contains 'hello'", typeof first.body === "string" && first.body.includes("hello"), `body=${JSON.stringify(first.body)}`)
  check("catch-up extracted a from address", typeof first.from === "string" && first.from.length > 0, `from=${first.from}`)
}

await stopWatcher()
check("stopWatcher sets isWatcherHealthy()=false", !isWatcherHealthy())

// ---------------------------------------------------------------------------
console.log("")
console.log(failures === 0 ? "RESULT: ALL TESTS PASS" : `RESULT: ${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
// afk LIVE verification — UID-cursor detection fix.
//
// Proves the detection no longer depends on `\Seen` (the "回复了没反应" bug) by
// replacing the UNSEEN+SUBJECT search with a persistent UID cursor:
//
//   [1] SEEN-REPLY REGRESSION: deliver a reply, mark it \Seen (simulate the
//       human reading it in their mail client) BEFORE the scan, then assert the
//       scan STILL processes it (UID > cursor finds it despite \Seen) and queues
//       delivery.
//   [2] NO WEDGE: a self-copy (token, no Re:) and an unrelated mail (no token)
//       are fetched, skipped, and the cursor advances past them.
//   [3] FRESH START: after clearing the cursor, a fresh scan re-anchors to the
//       mailbox's current max UID and reprocesses NOTHING.
//   [4] FULL DAEMON LOOP: a fresh daemon + real QQ; register a throwaway
//       session, SMTP-send a reply, mark it \Seen immediately, and assert the
//       daemon still queues delivery (GET /delivery → delivered:true).
//
// Run:  node test/uidcursor.live.mjs
//
// Evidence: /home/lorenzo/.omo/evidence/task-uidcursor-afk.log
//
// Non-destructive: only SELF-addressed test mail is sent; every test message is
// marked \Seen at cleanup; the real journal/cursor are isolated via env vars.

import nodemailer from "nodemailer"
import { ImapFlow } from "imapflow"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, createWriteStream } from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, "..")
const DAEMON = join(PLUGIN_DIR, "daemon.js")
const EVIDENCE = "/home/lorenzo/.omo/evidence/task-uidcursor-afk.log"

// Isolate journal + cursor BEFORE importing process.js / uid-cursor.js (they
// capture their paths at module load).
const tmp = mkdtempSync(join(tmpdir(), "afk-uidcursor-"))
process.env.AFK_JOURNAL = join(tmp, "journal.json")
process.env.AFK_LAST_UID = join(tmp, "last-uid.json")
process.env.AFK_DEBUG = "1"

const { loadConfig } = await import(join(HERE, "../config.js"))
const { scanAndProcess } = await import(join(HERE, "../process.js"))
const { getCursor, resetCursor } = await import(join(HERE, "../uid-cursor.js"))

mkdirSync(dirname(EVIDENCE), { recursive: true })
writeFileSync(EVIDENCE, "") // fresh evidence per run
function log(...args) {
  const line = args.map(String).join(" ")
  console.log(line)
  appendFileSync(EVIDENCE, line + "\n")
}

let failures = 0
function check(name, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL"
  log(`[${mark}] ${name}${extra ? " — " + extra : ""}`)
  if (!cond) failures++
}

const ts = Date.now()
const REPLY_SESSION = `ses_uidcursor${ts}`
const SELFCOPY_SESSION = `ses_selfcopy${ts}`
const REPLY_SUBJECT = `Re: [omo:${REPLY_SESSION}] 测试`
const REPLY_BODY = "uidcursor regression reply body"
const SELFCOPY_SUBJECT = `[omo:${SELFCOPY_SESSION}] outbound copy`
const NONTOKEN_SUBJECT = `unrelated newsletter ${ts}`

const config = loadConfig()
const recipient = config.recipient || config.smtp.user

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeImap() {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  })
}

async function smtpSend(subject, text, inReplyTo) {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  })
  const info = await transporter.sendMail({
    from: config.smtp.user,
    to: recipient,
    subject,
    text,
    ...(inReplyTo ? { inReplyTo } : {}),
  })
  return info
}

async function waitForUidsAbove(imap, cursor, minCount = 1, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const uids = await imap.search({ uid: `${cursor + 1}:*` }, { uid: true })
    if (Array.isArray(uids) && uids.length >= minCount) return uids
    if (Date.now() > deadline) return uids ?? []
    await sleep(200)
  }
}

// Mark a set of UIDs \Seen (simulates the human reading them in a mail client).
async function markSeen(imap, uids) {
  for (const uid of uids) {
    await imap.messageFlagsAdd({ uid }, ["\\Seen"])
  }
}

// Records parsed-reply deliveries, mimicking the daemon's queue-store (returns
// {ok:true} so processMail proceeds to ack). Mirrors daemon.js makeQueueStore.
function makeQueueStore(deliveries) {
  return async (_client, { sessionID, body, from }) => {
    deliveries.push({ sessionID, body, from })
    log(`    [queue-store] queued delivery for ${sessionID} body=${JSON.stringify(body)}`)
    return { ok: true }
  }
}

// Wait for the daemon's delivery queue to hold the given session's reply.
async function waitDelivery(sessionID, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/delivery?sessionID=${encodeURIComponent(sessionID)}`)
      const data = await res.json()
      if (data?.delivered === true) return data
    } catch {}
    if (Date.now() > deadline) return null
    await sleep(300)
  }
}

// ---------------------------------------------------------------------------
// PART 1 — SEEN-REPLY REGRESSION (direct scanAndProcess, deterministic ordering)
// ---------------------------------------------------------------------------
async function part1() {
  log("=".repeat(70))
  log("PART 1 — SEEN-REPLY REGRESSION: reply marked \\Seen BEFORE scan must still be detected")
  resetCursor()
  const imap = makeImap()
  await imap.connect()
  const mb = await imap.mailboxOpen(config.folder)
  const anchor = (mb.uidNext ?? 1) - 1
  log(`  mailbox: exists=${mb.exists} uidNext=${mb.uidNext} anchor(uidNext-1)=${anchor}`)

  const deliveries = []
  const queueStore = makeQueueStore(deliveries)

  // Fresh-start anchor: first scan initializes the cursor to current max UID.
  const initial = await scanAndProcess(imap, null, config, { injectReply: queueStore })
  const anchored = getCursor(mb.uidValidity)
  log(`  initial scan anchored cursor to ${anchored}; results=${initial.length}`)
  check("cursor anchored to uidNext-1 on fresh start", anchored === anchor, `anchored=${anchored}`)

  // Deliver the reply, then mark it \Seen BEFORE scanning (the regression).
  await smtpSend(REPLY_SUBJECT, REPLY_BODY)
  log(`  reply sent: "${REPLY_SUBJECT}"`)
  const newUids = await waitForUidsAbove(imap, anchor)
  check("reply delivered (UID > cursor)", newUids.length > 0, `uids=${JSON.stringify(newUids)}`)
  await markSeen(imap, newUids)
  log(`  marked ${newUids.length} reply UID(s) \\Seen (simulated human read) BEFORE scanning`)

  const seenBeforeScan = await imap.search({ uid: `${anchor + 1}:*`, seen: false }, { uid: true })
  log(`  UNSEEN search now returns ${Array.isArray(seenBeforeScan) ? seenBeforeScan.length : 0} UID(s) — the OLD detection would find nothing here`)

  const res = await scanAndProcess(imap, null, config, { injectReply: queueStore })
  const hit = res.find((r) => r.sessionID === REPLY_SESSION)
  log(`  post-scan results=${res.length} delivery(ies)=${deliveries.length}`)
  for (const r of res) log(`    uid=${r.uid} ok=${r.ok} skipped=${!!r.skipped} injected=${!!r.injected} sessionID=${r.sessionID ?? "-"}`)

  check("Seen reply STILL processed (detected despite \\Seen)", Boolean(hit && hit.injected), `sessionID=${REPLY_SESSION}`)
  check("delivery queued for the Seen reply", deliveries.some((d) => d.sessionID === REPLY_SESSION))
  check("cursor advanced past the reply UID", getCursor(mb.uidValidity) >= Math.max(...newUids.map(Number)), `cursor=${getCursor(mb.uidValidity)}`)

  await imap.logout().catch(() => {})
  return { anchor, cursorAfter: getCursor(mb.uidValidity) }
}

// ---------------------------------------------------------------------------
// PART 2 — NO WEDGE (self-copy + non-token mail are skipped and advanced past)
// ---------------------------------------------------------------------------
async function part2(cursorAfter) {
  log("=".repeat(70))
  log("PART 2 — NO WEDGE: self-copy + non-token mail are skipped and the cursor advances past them")
  const imap = makeImap()
  await imap.connect()
  await imap.mailboxOpen(config.folder)

  const deliveries = []
  const queueStore = makeQueueStore(deliveries)

  await smtpSend(SELFCOPY_SUBJECT, "this is my own outbound copy")
  await smtpSend(NONTOKEN_SUBJECT, "totally unrelated mail, no token")
  log(`  sent self-copy "${SELFCOPY_SUBJECT}" and non-token "${NONTOKEN_SUBJECT}"`)
  const uids = await waitForUidsAbove(imap, cursorAfter, 2)
  check("self-copy + non-token mail delivered", uids.length >= 2, `uids=${JSON.stringify(uids)}`)
  const highestBefore = Math.max(...uids.map(Number))

  const res = await scanAndProcess(imap, null, config, { injectReply: queueStore })
  log(`  scan results=${res.length} delivery(ies)=${deliveries.length}`)
  for (const r of res) log(`    uid=${r.uid} ok=${r.ok} skipped=${!!r.skipped} injected=${!!r.injected}`)

  check("self-copy + non-token mail skipped (not injected)", deliveries.length === 0 && res.every((r) => r.skipped === true))
  check("cursor advanced past the highest skipped UID", getCursor(imap.mailbox?.uidValidity) >= highestBefore, `cursor=${getCursor(imap.mailbox?.uidValidity)} highest=${highestBefore}`)

  // A follow-up scan sees nothing (no wedge — the skipped mail is never reprocessed).
  const again = await scanAndProcess(imap, null, config, { injectReply: queueStore })
  check("follow-up scan returns [] (skipped mail did not wedge the cursor)", Array.isArray(again) && again.length === 0, `results=${again.length}`)

  await imap.logout().catch(() => {})
  return { cursorAfter: getCursor(imap.mailbox?.uidValidity) }
}

// ---------------------------------------------------------------------------
// PART 3 — FRESH START (cleared cursor re-anchors; no reprocess of history)
// ---------------------------------------------------------------------------
async function part3() {
  log("=".repeat(70))
  log("PART 3 — FRESH START: a cleared cursor re-anchors to current max UID; no history reprocess")
  const imap = makeImap()
  await imap.connect()
  const mb = await imap.mailboxOpen(config.folder)
  const anchor = (mb.uidNext ?? 1) - 1

  // Simulate a fresh daemon start: clear the persisted cursor + in-memory cache.
  try {
    rmSync(process.env.AFK_LAST_UID, { force: true })
  } catch {}
  resetCursor()
  log(`  cleared cursor (${process.env.AFK_LAST_UID}); current uidNext=${mb.uidNext}`)

  const deliveries = []
  const queueStore = makeQueueStore(deliveries)
  const res = await scanAndProcess(imap, null, config, { injectReply: queueStore })

  check("fresh scan re-anchored cursor to uidNext-1", getCursor(mb.uidValidity) === anchor, `cursor=${getCursor(mb.uidValidity)}`)
  check("fresh scan processed NOTHING (no reprocess of test history)", res.length === 0 && deliveries.length === 0, `results=${res.length} deliveries=${deliveries.length}`)

  await imap.logout().catch(() => {})
}

// ---------------------------------------------------------------------------
// PART 4 — FULL DAEMON LOOP (fresh daemon + real QQ; Seen reply → delivery queued)
// ---------------------------------------------------------------------------
const DAEMON_PORT = 4189
async function part4() {
  log("=".repeat(70))
  log("PART 4 — FULL DAEMON LOOP: register → SMTP reply → mark \\Seen → daemon queues delivery")

  const cursorFile = join(tmp, `daemon-last-uid-${process.pid}.json`)
  const journalFile = join(tmp, `daemon-journal-${process.pid}.json`)
  const daemonLogFile = join(tmp, `daemon-${process.pid}.log`)
  const logFd = createWriteStream(daemonLogFile, { flags: "a" })

  const daemon = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AFK_DAEMON_PORT: String(DAEMON_PORT),
      AFK_DEBUG: "1",
      AFK_JOURNAL: journalFile,
      AFK_LAST_UID: cursorFile,
    },
  })
  daemon.stdout.on("data", (d) => logFd.write(d))
  daemon.stderr.on("data", (d) => logFd.write(d))
  log(`  daemon spawned pid=${daemon.pid} port=${DAEMON_PORT}`)

  // Wait for /health.
  let healthy = false
  for (let i = 0; i < 75 && !healthy; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, { signal: AbortSignal.timeout(500) })
      healthy = (await r.json())?.ok === true
    } catch {}
    if (!healthy) await sleep(200)
  }
  check("daemon /health ok", healthy)

  // Wait for the watcher to connect (so IDLE is engaged) before sending.
  const daemonText = () => {
    try {
      return readFileSync(daemonLogFile, "utf8")
    } catch {
      return ""
    }
  }
  let connected = false
  for (let i = 0; i < 150 && !connected; i++) {
    if (daemonText().includes("connected to imap.qq.com")) connected = true
    else await sleep(200)
  }
  check("daemon watcher connected to imap.qq.com", connected)

  // Wait for the daemon's catch-up scan to ANCHOR its (fresh) cursor BEFORE we
  // send the reply — otherwise the reply would land below the fresh-start anchor
  // and be (correctly) treated as pre-existing history.
  let anchored = false
  for (let i = 0; i < 150 && !anchored; i++) {
    if (daemonText().includes("UID cursor initialized to")) anchored = true
    else await sleep(200)
  }
  check("daemon cursor anchored (fresh-start) before sending", anchored)

  // Register a throwaway decision (serverUrl is a dummy — the queue-store does
  // not inject, it only parks the reply in the delivery queue).
  const reg = await fetch(`http://127.0.0.1:${DAEMON_PORT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: REPLY_SESSION, serverUrl: "http://127.0.0.1:1" }),
  })
  const regBody = await reg.json()
  log(`  register ${REPLY_SESSION}: ${reg.status} ${JSON.stringify(regBody)}`)
  check("register accepted", regBody?.ok === true)

  // SMTP-send the reply, then mark it \Seen ASAP (simulate the human reading).
  await smtpSend(REPLY_SUBJECT, REPLY_BODY)
  log(`  reply sent: "${REPLY_SUBJECT}"`)

  // Mark \Seen as soon as the reply is findable by subject (best-effort race
  // with the daemon's IDLE scan — the deterministic Seen proof is in PART 1).
  const seenImap = makeImap()
  await seenImap.connect()
  await seenImap.mailboxOpen(config.folder)
  let marked = 0
  for (let i = 0; i < 150 && marked === 0; i++) {
    const uids = await seenImap.search({ subject: `[omo:${REPLY_SESSION}]` }, { uid: true })
    if (Array.isArray(uids) && uids.length > 0) {
      await markSeen(seenImap, uids)
      marked = uids.length
    } else {
      await sleep(200)
    }
  }
  log(`  marked ${marked} reply UID(s) \\Seen (simulated human read)`)

  const delivery = await waitDelivery(REPLY_SESSION, 60000)
  if (delivery) {
    log(`  delivery queued: body=${JSON.stringify(delivery.body)} from=${JSON.stringify(delivery.from)}`)
    check("daemon detected the Seen reply and queued delivery", delivery.body === REPLY_BODY)
  } else {
    check("daemon detected the Seen reply and queued delivery", false, "no delivery within 60s")
  }

  await seenImap.logout().catch(() => {})
  try {
    process.kill(-daemon.pid, "SIGTERM")
  } catch {
    try {
      daemon.kill("SIGTERM")
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Cleanup: mark every message created by THIS run \Seen (UID-based — the run
// starts above `anchor`, so search the small `UID > anchor` window for unseen
// mail and mark it; no SUBJECT search, which lags on QQ).
// ---------------------------------------------------------------------------
async function cleanup(anchor) {
  const notes = []
  try {
    const imap = makeImap()
    await imap.connect()
    await imap.mailboxOpen(config.folder)
    const uids = await imap.search({ uid: `${anchor + 1}:*`, seen: false }, { uid: true })
    await markSeen(imap, uids)
    notes.push(`marked ${uids.length} unseen UID(s) > ${anchor} \\Seen (this run's test mail)`)
    await imap.logout().catch(() => {})
  } catch (e) {
    notes.push(`(warn) mailbox cleanup: ${e.message}`)
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
    notes.push("temp dir removed")
  } catch {}
  log("--- CLEANUP RECEIPT ---")
  for (const n of notes) log("  " + n)
}

// ---------------------------------------------------------------------------
async function run() {
  log("=".repeat(70))
  log(`AFK UID-CURSOR LIVE VERIFICATION — ${new Date().toISOString()}`)
  log(`REPLY_SESSION=${REPLY_SESSION}`)
  log(`journal=${process.env.AFK_JOURNAL}`)
  log(`cursor=${process.env.AFK_LAST_UID}`)
  log("=".repeat(70))

  const p1 = await part1()
  await part2(p1.cursorAfter)
  await part3()
  await part4()

  log("=".repeat(70))
  log(failures === 0 ? "RESULT: ALL CHECKS PASS" : `RESULT: ${failures} CHECK(S) FAILED`)
  log("=".repeat(70))

  return p1.anchor
}

let ok = false
let runAnchor = 0
try {
  runAnchor = await run()
  ok = failures === 0
} catch (e) {
  log("=".repeat(70))
  log(`VERIFICATION FAILED: ${e?.message ?? String(e)}`)
  if (e?.stack) log(e.stack)
  log("=".repeat(70))
} finally {
  await cleanup(runAnchor)
}

log("DONE")
process.exitCode = ok ? 0 : 1

#!/usr/bin/env node
// watch-reply.live.mjs — live reply detector using the REAL hook watcher (IMAP IDLE).
//
// Uses watcher.js's startWatcher() — the EXACT code the afk daemon uses
// to detect new mail (imap.qq.com, IDLE push, auto-reconnect). NO polling.
//
// On every IDLE push (and catch-up scan after connect/reconnect) it scans the
// incremental UID window (UID > cursor, same detection strategy as the daemon),
// then for each new message logs:
//   - the envelope (subject / from / inReplyTo)
//   - the raw text/plain + text/html body
//   - the parseReply() result — the EXACT (sessionID, body, from) the hook
//     would inject with
//
// It does NOT queue / journal / inject anything: pure detect + parse + log, so
// you can verify the hook's DETECTION half live while you reply.
//
// Run:   node test/watch-reply.live.mjs
// Stop:  Ctrl-C
//
// Baseline: it starts at the mailbox's current max UID, so only mail that
// arrives AFTER you start it is logged. Send your reply after the
// "IDLE watch started" line appears.

import { loadConfig } from "../config.js"
import { startWatcher, stopWatcher } from "../core/watcher.js"
import { toStructuredEmail } from "../core/process.js"
import { parseReply, extractToken, isReply } from "../core/reply-parse.js"
import { simpleParser } from "mailparser"

const config = loadConfig()

// In-memory detection cursor: only mail with UID > cursor is processed.
// Advanced after each batch so a re-scan / re-push never double-logs.
let cursor = null
let scanInFlight = false

async function scanAndLog(client) {
  if (scanInFlight) return
  scanInFlight = true
  try {
    if (cursor === null) {
      // Fresh start: anchor to the mailbox's current max UID.
      const all = await client.search({ uid: "1:*" }, { uid: true })
      const maxUid = Array.isArray(all) && all.length > 0 ? Math.max(...all.map(Number)) : 0
      cursor = maxUid
      console.log(`[watch] baseline: current max UID = ${maxUid} — only NEW mail (UID > ${maxUid}) will be logged`)
      console.log(`[watch] IDLE watch started. NOW REPLY TO A DECISION EMAIL (or send a new [omo:...] reply).\n`)
      return
    }

    const uids = await client.search({ uid: `${cursor + 1}:*` }, { uid: true })
    if (!Array.isArray(uids) || uids.length === 0) return
    const sorted = [...uids].sort((a, b) => Number(a) - Number(b))

    for (const uid of sorted) {
      console.log(`\n========== 🔔 NEW MAIL DETECTED (IDLE push) — UID ${uid} @ ${new Date().toISOString()} ==========`)
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true })
      if (!msg || !Buffer.isBuffer(msg.source)) {
        console.log(`uid ${uid}: fetch returned no source`)
        continue
      }
      const parsed = await simpleParser(msg.source)
      const s = toStructuredEmail(parsed)

      console.log(`subject    : ${s.subject}`)
      console.log(`from       : ${s.from}`)
      console.log(`inReplyTo  : ${s.inReplyTo ?? "(none)"}`)
      console.log(`--- text/plain (RAW) ---\n${s.text ?? "(none)"}`)
      console.log(`--- text/html (RAW) ---\n${s.html ?? "(none)"}`)

      const token = extractToken(s.subject)
      const replyFlag = isReply(s.subject, s.inReplyTo)
      console.log(`--- parse ---`)
      console.log(`[omo:...] token present : ${token ? "YES → " + token : "no"}`)
      console.log(`isReply (prefix/header) : ${replyFlag}`)

      const result = parseReply(s)
      if (result) {
        console.log(`parseReply() RESULT      : sessionID=${result.sessionID}`)
        console.log(`                          body="${result.body}"`)
        console.log(`                          from=${result.from}`)
      } else {
        console.log(`parseReply() RESULT      : null (not a decision reply — ignored by the hook)`)
      }
    }

    cursor = Math.max(...sorted.map(Number))
  } catch (err) {
    console.error(`[watch] scan failed: ${err.message}`)
  } finally {
    scanInFlight = false
  }
}

const onMail = (client) => {
  void scanAndLog(client)
}
const onReady = async (client) => {
  console.log(`[watch] connected to ${config.imap.host} folder=${config.folder} (IDLE push active)`)
  await scanAndLog(client)
}

startWatcher(config, { onMail, onReady }).catch((err) => {
  console.error("FATAL:", err.message)
  process.exit(1)
})

process.on("SIGINT", async () => {
  console.log("\n[watch] stopping…")
  await stopWatcher()
  console.log("[watch] stopped")
  process.exit(0)
})

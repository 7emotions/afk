#!/usr/bin/env node
// Standalone receive+parse test for the email-wake plugin.
//
// Verifies the RECEIVE + PARSE half of the reply pipeline in isolation from the
// (broken) injection path:
//   1. IMAP-fetch replies from the real mailbox (an explicit UID, or the most
//      recent N messages).
//   2. Parse each with the REAL production pipeline used by the daemon:
//        mailparser.simpleParser -> toStructuredEmail (process.js) -> parseReply (reply-parse.js)
//   3. Log EVERYTHING: subject, from, inReplyTo, raw text/plain + text/html body,
//      and the parseReply result (extracted sessionID + cleaned body), so we can
//      SEE whether reception and parsing actually succeed.
//
// Run:
//   node test/receive-parse-test.mjs 4739          # fetch one specific UID
//   node test/receive-parse-test.mjs               # auto: newest 5 messages

import { ImapFlow } from "imapflow"
import { simpleParser } from "mailparser"
import { loadConfig } from "../config.js"
import { toStructuredEmail } from "../process.js"
import { parseReply } from "../reply-parse.js"

const config = loadConfig()
const explicitUid = process.argv[2] ? Number(process.argv[2]) : null

const client = new ImapFlow({
  host: config.imap.host,
  port: config.imap.port,
  secure: config.imap.secure,
  auth: { user: config.imap.user, pass: config.imap.password },
  logger: false,
})

const log = (label, value) => console.log(`${label}\n${JSON.stringify(value, null, 2)}\n`)

try {
  await client.connect()
  const lock = await client.getMailboxLock(config.folder)
  try {
    let uids
    if (explicitUid) {
      uids = [explicitUid]
    } else {
      const all = await client.search({ uid: "1:*" }, { uid: true })
      uids = Array.isArray(all) ? all.slice(-5) : []
      if (uids.length === 0) {
        console.log("mailbox empty")
        process.exit(0)
      }
    }

    for (const uid of uids) {
      console.log(`\n========== UID ${uid} ==========`)
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true })
      if (!msg || !Buffer.isBuffer(msg.source)) {
        console.log(`uid ${uid}: fetch returned no source`)
        continue
      }

      const parsed = await simpleParser(msg.source)
      const structured = toStructuredEmail(parsed)

      log("subject", structured.subject)
      log("from", structured.from)
      log("inReplyTo", structured.inReplyTo)
      log("text/plain (RAW)", structured.text)
      log("text/html (RAW)", structured.html)

      const reply = parseReply(structured)
      log("parseReply() RESULT", reply)
    }
  } finally {
    lock.release()
  }
  await client.logout()
  console.log("\nDONE")
} catch (err) {
  console.error("FATAL:", err)
  process.exit(1)
}

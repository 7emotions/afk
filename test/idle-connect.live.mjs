// afk T4 integration test (throwaway).
//
// 1. Integration: startWatcher -> IDLE push on self-send fires onMail within ~8s.
// 2. Reconnect: destroy underlying socket -> watcher reconnects + re-selects -> 2nd self-send fires.
// 3. Failure: wrong password -> clear error, no crash, isWatcherHealthy() stays false.

import { loadConfig } from "../config.js"
import { startWatcher, stopWatcher, isWatcherHealthy } from "../core/watcher.js"
import nodemailer from "nodemailer"

const config = loadConfig()
const recipient = config.recipient || config.smtp.user

// Hard safety: never let the script hang past 120s.
setTimeout(() => {
  console.error("[TEST] global timeout (120s) reached — aborting")
  process.exit(2)
}, 120000)

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

async function sendSelfEmail(tag) {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  })
  const info = await transporter.sendMail({
    from: config.smtp.user,
    to: recipient,
    subject: `[idle-test] ${tag} ${Date.now()}`,
    text: `afk T4 idle integration test (${tag})`,
  })
  console.log(`[SMTP] sent ${tag}: messageId=${info.messageId}`)
  return info
}

// ---------------------------------------------------------------------------
console.log("=== INTEGRATION: startWatcher + IDLE push ===")
let mailCount = 0
const handle = await startWatcher(config, { onMail: () => { mailCount++ } })
console.log("[START] watcher handle acquired")

const healthy = await waitFor(() => isWatcherHealthy(), 10000)
check("watcher healthy after start (authenticated + mailboxOpen)", healthy, `isWatcherHealthy=${isWatcherHealthy()}`)

await sleep(1500) // let IDLE fully engage (autoIdleDelay=1s)
const before = mailCount
await sendSelfEmail("integration")
const fired = await waitFor(() => mailCount > before, 8000)
check("onMail fired after self-send (IDLE push)", fired, `mailCount=${mailCount}`)

// ---------------------------------------------------------------------------
console.log("=== RECONNECT: force socket drop -> reconnect -> 2nd push ===")
const firstClient = handle.state.client
const sock = firstClient && firstClient.socket
console.log(`[RECONNECT] destroying underlying socket (present=${Boolean(sock)})`)
if (sock) sock.destroy()

const reconnected = await waitFor(() => isWatcherHealthy() && handle.state.client !== firstClient, 30000)
check("watcher reconnected after forced socket close (new client, re-selected)", reconnected, `isWatcherHealthy=${isWatcherHealthy()}`)

await sleep(1500) // let IDLE re-engage on the new connection
const before2 = mailCount
await sendSelfEmail("reconnect")
const fired2 = await waitFor(() => mailCount > before2, 8000)
check("onMail fired again after reconnect (2nd self-send)", fired2, `mailCount=${mailCount}`)

await stopWatcher()
check("stopWatcher sets isWatcherHealthy()=false", !isWatcherHealthy())

// ---------------------------------------------------------------------------
console.log("=== FAILURE: wrong password ===")
const badConfig = { ...config, imap: { ...config.imap, password: "definitely-wrong-password" } }
const outcome = await Promise.race([
  startWatcher(badConfig, { onMail: () => {} }).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, err })
  ),
  sleep(15000).then(() => ({ timeout: true })),
])

if (outcome.timeout) {
  check("wrong password reported a clear error (within 15s)", false, "timed out")
} else {
  check(
    "wrong password reported a clear error",
    !outcome.ok && outcome.err,
    outcome.ok ? "unexpectedly succeeded" : `msg=${outcome.err && outcome.err.message}`
  )
}
await sleep(500)
check("process did not crash after auth failure", true)
check("isWatcherHealthy() stays false after auth failure", !isWatcherHealthy())
await stopWatcher() // clear the background retry loop

// ---------------------------------------------------------------------------
console.log("")
console.log(failures === 0 ? "RESULT: ALL TESTS PASS" : `RESULT: ${failures} TEST(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
// email-wake LIVE daemon integration (single-watcher architecture).
//
// Proves the daemon's reply pipeline end-to-end against the real QQ mailbox,
// in an ISOLATED XDG sandbox (a throwaway opencode serve provides the target
// serverUrl; the real user opencode DB/instances are never touched):
//
//   1. start a sandbox `opencode serve --pure` (isolated XDG_* dirs) → its URL.
//   2. start the daemon (real QQ config, isolated EMAIL_WAKE_JOURNAL, debug on).
//   3. POST /register { sessionID: "ses_daemon<ts>", serverUrl: <serve URL> }.
//   4. SMTP-send `Re: [omo:ses_daemon<ts>] x` to the shared mailbox.
//   5. assert the daemon FOUND it, looked up the registry, and attempted an
//      HTTP-inject against the RIGHT serverUrl. The injected session need not
//      exist — {ok:false} (session-gone → 500) is acceptable; the PASS is the
//      "inject into <serve URL> for <sessionID>" log line (vs "not a registered
//      decision", which would mean the registry lookup failed).
//
// Run:  node test/daemon-live.mjs
//
// Evidence: /home/lorenzo/.omo/evidence/task-daemon-email-wake.log

import nodemailer from "nodemailer"
import { ImapFlow } from "imapflow"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, "..")
const DAEMON = join(PLUGIN_DIR, "daemon.js")
const OPENDCODE_BIN = "/home/lorenzo/.opencode/bin/opencode"
const EVIDENCE = "/home/lorenzo/.omo/evidence/task-daemon-email-wake.log"
const REAL_CONFIG_HOME = join(process.env.HOME ?? "/home/lorenzo", ".config")
const REAL_DATA_HOME = join(process.env.HOME ?? "/home/lorenzo", ".local/share")

const ts = Date.now()
const SESSION = `ses_daemon${ts}`
const REPLY_SUBJECT = `Re: [omo:${SESSION}] x`
const REPLY_BODY = "daemon live integration reply"
const DAEMON_PORT = 4178

mkdirSync(dirname(EVIDENCE), { recursive: true })
function log(...args) {
  const line = args.map(String).join(" ")
  console.log(line)
  appendFileSync(EVIDENCE, line + "\n")
}

// Isolate the daemon's journal AND UID cursor BEFORE the daemon process starts
// (inject.js / uid-cursor.js read their env paths at module load inside the
// daemon process).
const JOURNAL = join(tmpdir(), `email-wake-daemon-journal-${process.pid}.json`)
const CURSOR = join(tmpdir(), `email-wake-daemon-cursor-${process.pid}.json`)

// Sandbox XDG dirs — the serve must never touch the real opencode config/DB.
const sandbox = mkdtempSync(join(tmpdir(), "email-wake-sandbox-"))
const XDG_CONFIG_HOME = join(sandbox, "config")
const XDG_DATA_HOME = join(sandbox, "data")
const XDG_STATE_HOME = join(sandbox, "state")
const XDG_CACHE_HOME = join(sandbox, "cache")
mkdirSync(join(XDG_CONFIG_HOME, "opencode"), { recursive: true })
mkdirSync(join(XDG_DATA_HOME, "opencode"), { recursive: true })
mkdirSync(XDG_STATE_HOME, { recursive: true })
mkdirSync(XDG_CACHE_HOME, { recursive: true })

// Copy the provider/config so models resolve (opencode.jsonc), and the auth so
// a model could actually run — though the injection targets a nonexistent
// session and never reaches a model.
const srcConfig = join(REAL_CONFIG_HOME, "opencode", "opencode.jsonc")
const srcAuth = join(REAL_DATA_HOME, "opencode", "auth.json")
if (existsSync(srcConfig)) copyFileSync(srcConfig, join(XDG_CONFIG_HOME, "opencode", "opencode.jsonc"))
if (existsSync(srcAuth)) copyFileSync(srcAuth, join(XDG_DATA_HOME, "opencode", "auth.json"))

function serveEnv() {
  return {
    ...process.env,
    XDG_CONFIG_HOME,
    XDG_DATA_HOME,
    XDG_STATE_HOME,
    XDG_CACHE_HOME,
  }
}

function daemonEnv() {
  return {
    ...process.env,
    EMAIL_WAKE_DAEMON_PORT: String(DAEMON_PORT),
    EMAIL_WAKE_DEBUG: "1",
    EMAIL_WAKE_JOURNAL: JOURNAL,
    EMAIL_WAKE_LAST_UID: CURSOR,
  }
}

// Tracked resources for cleanup.
let serveChild = null
let serveUrl = null
let daemonChild = null
let daemonLog = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function startServe() {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENDCODE_BIN, ["serve", "--pure", "--port", "0"], {
      cwd: "/tmp/opencode",
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: serveEnv(),
    })
    let settled = false
    let buf = ""
    const scan = (chunk) => {
      buf += chunk.toString()
      const m = buf.match(/listening on (http:\/\/[\d.:]+)/)
      if (m && !settled) {
        settled = true
        resolve({ child, baseUrl: m[1] })
      }
    }
    child.stdout.on("data", scan)
    child.stderr.on("data", scan)
    child.on("error", (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.on("exit", (code, signal) => {
      if (!settled) {
        settled = true
        reject(new Error(`opencode serve exited early (code=${code}, signal=${signal})\n${buf}`))
      }
    })
    setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error("timeout waiting for opencode serve to report its URL"))
      }
    }, 30000)
  })
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const t = setTimeout(() => resolve(), ms)
    child.once("exit", () => {
      clearTimeout(t)
      resolve()
    })
  })
}

async function kill(child) {
  if (!child) return
  const pid = child.pid
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      child.kill("SIGTERM")
    } catch {}
  }
  await waitExit(child, 5000)
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        child.kill("SIGKILL")
      } catch {}
    }
    await waitExit(child, 2000)
  }
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(800),
      })
      const data = await res.json()
      if (data?.ok === true) return true
    } catch {}
    await sleep(200)
  }
  return false
}

// Transient IMAP client (test harness only) to clear stale unseen [omo: mail.
async function clearStaleUnseen(config) {
  const c = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  })
  try {
    await c.connect()
    await c.mailboxOpen(config.folder)
    const uids = await c.search({ seen: false, subject: "[omo:" }, { uid: true })
    for (const uid of uids) {
      await c.messageFlagsAdd({ uid }, ["\\Seen"])
    }
    log(`setup: cleared ${uids.length} stale unseen "[omo:" message(s)`)
    return uids
  } finally {
    try {
      await c.logout()
    } catch {}
  }
}

async function markSeen(config, subjectToken) {
  const c = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  })
  try {
    await c.connect()
    await c.mailboxOpen(config.folder)
    const uids = await c.search({ subject: subjectToken }, { uid: true })
    for (const uid of uids) {
      await c.messageFlagsAdd({ uid }, ["\\Seen"])
    }
    return uids.length
  } finally {
    try {
      await c.logout()
    } catch {}
  }
}

// Read the daemon's captured log for the injection-attempt evidence line.
function daemonLogText() {
  if (!daemonLog) return ""
  try {
    return readFileSync(daemonLog, "utf8")
  } catch {
    return ""
  }
}

// Wait until the daemon's captured log contains the given substring.
async function waitForLogLine(substr, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (daemonLogText().includes(substr)) return true
    await sleep(200)
  }
  return false
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  log("=".repeat(70))
  log(`EMAIL-WAKE DAEMON LIVE INTEGRATION — ${new Date().toISOString()}`)
  log(`SESSION=${SESSION}`)
  log(`daemon port=${DAEMON_PORT}`)
  log(`journal=${JOURNAL}`)
  log(`sandbox=${sandbox}`)
  log("=".repeat(70))

  // Load the real QQ config (the daemon uses the same plugin config.json).
  const { loadConfig } = await import(join(PLUGIN_DIR, "config.js"))
  const config = loadConfig()

  // [1] sandbox opencode serve (isolated XDG).
  const served = await startServe()
  serveChild = served.child
  serveUrl = served.baseUrl
  log(`[1] sandbox opencode serve pid=${serveChild.pid} url=${serveUrl}`)

  // [2] clear stale unseen [omo: mail BEFORE the daemon's catch-up scan.
  await clearStaleUnseen(config)

  // [3] start the daemon (real QQ, isolated journal, debug on), capture stderr.
  daemonLog = join(sandbox, "daemon.log")
  const logFd = createWriteStream(daemonLog, { flags: "a" })
  daemonChild = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: daemonEnv(),
  })
  daemonChild.stdout.on("data", (d) => logFd.write(d))
  daemonChild.stderr.on("data", (d) => logFd.write(d))
  daemonChild.on("exit", (code) => log(`[daemon] exited code=${code}`))
  log(`[3] daemon spawned pid=${daemonChild.pid}`)

  const healthy = await waitHealth(15000)
  log(`[3] daemon /health ok=${healthy}`)
  if (!healthy) {
    log("FAIL: daemon did not become healthy")
    process.exitCode = 1
    return
  }

  // Wait for the daemon's IMAP watcher to connect + select (IDLE engages ~1s
  // later) before sending, so the reply is caught by the live IDLE push.
  await waitForLogLine("connected to imap.qq.com", 30000)
  await sleep(1500)
  log("[3] daemon watcher connected; IDLE engaged")

  // [4] register the decision: session → sandbox serve URL.
  const reg = await fetch(`http://127.0.0.1:${DAEMON_PORT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: SESSION, serverUrl: serveUrl }),
  })
  log(`[4] register ${SESSION} → ${serveUrl}: ${reg.status} ${JSON.stringify(await reg.json())}`)

  // [5] SMTP-send the human's reply to the shared QQ mailbox.
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  })
  const info = await transporter.sendMail({
    from: config.smtp.user,
    to: config.recipient || config.smtp.user,
    subject: REPLY_SUBJECT,
    text: REPLY_BODY,
  })
  log(`[5] SMTP reply sent subject="${REPLY_SUBJECT}" messageId=${info.messageId}`)

  // [6] wait for the daemon to find it and attempt HTTP-inject against serveUrl.
  // The PASS evidence is an INJECT line (not the register line): either
  //   "inject into <serveUrl> for <sessionID> returned ok=false (...)"  (session gone → 500)
  //   or "injected reply into <sessionID> via <serveUrl>"                (inject succeeded)
  const DEADLINE_MS = 180_000
  const deadline = Date.now() + DEADLINE_MS
  const injectLineOf = (txt) => {
    for (const l of txt.split("\n")) {
      if (
        (l.includes(`inject into ${serveUrl} for ${SESSION}`) ||
          l.includes(`injected reply into ${SESSION} via ${serveUrl}`)) 
      ) {
        return l
      }
    }
    return null
  }
  let attemptLine = null
  while (Date.now() < deadline) {
    attemptLine = injectLineOf(daemonLogText())
    if (attemptLine) break
    await sleep(1000)
  }

  log("-".repeat(70))
  // Dump every daemon log line mentioning SESSION (register, scan, inject, …).
  const sessionLines = daemonLogText().split("\n").filter((l) => l.includes(SESSION))
  log(`daemon log lines for ${SESSION}:`)
  for (const l of sessionLines) log(`    ${l.trim()}`)

  if (attemptLine) {
    log(`PASS: daemon looked up the registry and attempted HTTP-inject against the RIGHT serverUrl`)
    log(`      evidence line: ${attemptLine.trim()}`)
  } else {
    log(`FAIL: no injection attempt against ${serveUrl} for ${SESSION} within ${DEADLINE_MS / 1000}s`)
    const registered = sessionLines.find((l) => l.includes(`register ${SESSION}`))
    const notRegistered = sessionLines.find((l) => l.includes("not a registered decision"))
    log(`      register line seen: ${registered ? "yes" : "no"}`)
    log(`      "not a registered decision" seen: ${notRegistered ? "yes" : "no"}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
async function cleanup() {
  const notes = []
  try {
    const { loadConfig } = await import(join(PLUGIN_DIR, "config.js"))
    const config = loadConfig()
    const n = await markSeen(config, `[omo:${SESSION}]`)
    notes.push(`marked ${n} email(s) \Seen for ${SESSION}`)
  } catch (e) {
    notes.push(`(warn) mailbox cleanup: ${e.message}`)
  }
  await kill(daemonChild)
  notes.push(`daemon killed (pid=${daemonChild?.pid})`)
  await kill(serveChild)
  notes.push(`serve killed (pid=${serveChild?.pid})`)
  try {
    rmSync(sandbox, { recursive: true, force: true })
    notes.push("sandbox removed")
  } catch {}
  try {
    rmSync(JOURNAL, { force: true })
    notes.push("temp journal removed")
  } catch {}
  try {
    rmSync(CURSOR, { force: true })
    notes.push("temp cursor removed")
  } catch {}
  log("--- CLEANUP RECEIPT ---")
  for (const n of notes) log("  " + n)
}

let ok = false
try {
  await run()
  ok = true
} catch (e) {
  log("=".repeat(70))
  log(`DAEMON LIVE FAIL: ${e?.message ?? String(e)}`)
  if (e?.stack) log(e.stack)
  log("=".repeat(70))
} finally {
  await cleanup()
}

log("DONE")
process.exitCode = ok ? 0 : 1

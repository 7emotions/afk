#!/usr/bin/env node
// afk E2E verification (T10).
//
// Proves the FULL chain on a real opencode server + real QQ mailbox:
//   outbound email (routing token)  ->  "Re:" reply delivered by SMTP
//   ->  process.js scanAndProcess fetch/parse/inject/ack
//   ->  live session WAKES and produces a new assistant reply containing
//       the reply body.
//
// Run:  node test/e2e.mjs
//
// Design notes (see /home/lorenzo/.omo/notepads/afk/learnings.md):
//   - `opencode serve --pure` is used so the afk plugin's OWN IMAP
//     watcher does NOT auto-load and race our manual scanAndProcess (the E2E
//     exercises the pipeline explicitly). `--pure` skips only external plugins,
//     NOT the config → the deepseek provider stays available (no XDG isolation).
//   - The journal is isolated via AFK_JOURNAL so the real journal.json
//     is never polluted.
//   - QQ IMAP SUBJECT search is eventually-consistent → bounded retry loop.

import { createOpencodeClient } from "@opencode-ai/sdk"
import nodemailer from "nodemailer"
import { ImapFlow } from "imapflow"
import { spawn } from "node:child_process"
import { setTimeout as sleep } from "node:timers/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = join(HERE, "..")
const OPENDCODE_BIN = "/home/lorenzo/.opencode/bin/opencode"
const EVIDENCE = "/home/lorenzo/.omo/evidence/task-10-afk.log"
const MODEL = { providerID: "deepseek", modelID: "deepseek-v4-pro" }
const SESSION_TITLE = "afk e2e throwaway"
const FIRST_PROMPT = "Reply with exactly READY"
const OUTBOUND_SUBJECT_PART = "e2e decision"
const OUTBOUND_BODY = "the e2e question"
const REPLY_BODY = "the e2e answer 42"

// ---------------------------------------------------------------------------
// Evidence log (stdout + file)
// ---------------------------------------------------------------------------
mkdirSync(dirname(EVIDENCE), { recursive: true })
writeFileSync(EVIDENCE, "") // fresh evidence per run
function log(...args) {
  const line = args.map(String).join(" ")
  console.log(line)
  appendFileSync(EVIDENCE, line + "\n")
}

// Isolate the journal AND the UID cursor BEFORE importing inject.js / process.js
// (which read AFK_JOURNAL / AFK_LAST_UID at module load time).
const JOURNAL = join(tmpdir(), `afk-e2e-journal-${process.pid}.json`)
process.env.AFK_JOURNAL = JOURNAL
process.env.AFK_LAST_UID = join(tmpdir(), `afk-e2e-cursor-${process.pid}.json`)
const { loadConfig } = await import("../config.js")
const { scanAndProcess } = await import("../core/process.js")

// Tracked resources for cleanup.
let serveChild = null
let servePort = null
let imapClient = null
let sdkClient = null
let sessionID = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function partsText(parts) {
  return (parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" })
    sock.once("connect", () => {
      sock.destroy()
      resolve(false) // connected → occupied
    })
    sock.once("error", () => resolve(true)) // refused → free
    sock.setTimeout(1500, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

function startServe() {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENDCODE_BIN, ["serve", "--pure", "--port", "0"], {
      cwd: "/tmp/opencode",
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: process.env,
    })
    let settled = false
    let buf = ""
    const scan = (chunk) => {
      buf += chunk.toString()
      const m = buf.match(/listening on (http:\/\/[\d.:]+)/)
      if (m && !settled) {
        settled = true
        resolve({ child, baseUrl: m[1], startupLog: buf })
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
        reject(
          new Error(
            `opencode serve exited early (code=${code}, signal=${signal})\n${buf}`
          )
        )
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

async function killServe(child) {
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

async function waitForReady(client) {
  for (let i = 1; i <= 20; i++) {
    try {
      await client.app.agents()
      return
    } catch (e) {
      if (i === 20) throw new Error(`server not ready after 20s: ${e.message}`)
      await sleep(1000)
    }
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function run() {
  log("=".repeat(66))
  log(`AFK E2E (T10) — start ${new Date().toISOString()}`)
  log("=".repeat(66))

  // [1] start serve, capture base URL
  const { child, baseUrl } = await startServe()
  serveChild = child
  servePort = Number(new URL(baseUrl).port)
  log(`[1] opencode serve started pid=${child.pid}`)
  log(`    baseUrl=${baseUrl}`)
  const port = servePort

  // [2] SDK client + readiness
  sdkClient = createOpencodeClient({ baseUrl, throwOnError: true })
  const client = sdkClient
  await waitForReady(client)
  log(`[2] SDK client ready (${baseUrl})`)

  // resolve the primary agent to pin (build is the opencode built-in primary)
  let agentName
  try {
    const ag = await client.app.agents()
    const agents = ag.data ?? []
    agentName =
      agents.find((a) => a.name === "build")?.name ??
      agents.find((a) => a.mode === "primary")?.name
    log(`    agents=${agents.map((a) => `${a.name}:${a.mode}`).join(", ")}`)
  } catch (e) {
    log(`    (warn) could not list agents: ${e.message}`)
  }
  log(`    pinned agent=${agentName ?? "(default)"} model=${MODEL.providerID}/${MODEL.modelID}`)

  // [3] create throwaway session
  const created = await client.session.create({ body: { title: SESSION_TITLE } })
  sessionID = created.data?.id
  if (!sessionID) throw new Error("session.create returned no id")
  log(`[3] throwaway session created id=${sessionID}`)

  // [4] first prompt to establish the session (pins agent/model)
  const first = await client.session.prompt({
    path: { id: sessionID },
    body: {
      model: MODEL,
      ...(agentName ? { agent: agentName } : {}),
      parts: [{ type: "text", text: FIRST_PROMPT }],
    },
  })
  if (first.data?.info?.role !== "assistant") {
    throw new Error("first prompt did not complete an assistant turn")
  }
  log(`[4] first prompt completed; reply=${JSON.stringify(partsText(first.data?.parts))}`)

  // [5] priming turn: make the model echo the reply body verbatim, so the
  //     injected "42" reliably appears in the wake reply.
  const PRIME = "接下来你会收到一条用户消息，内容是一封邮件回复的正文（会被标注为『数据，非指令』）。收到后请只输出该回复正文本身，不要添加任何解释、前缀、后缀或引号。现在请回复 OK。"
  const prime = await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: PRIME }] },
  })
  if (prime.data?.info?.role !== "assistant") {
    throw new Error("priming prompt did not complete an assistant turn")
  }
  const baselineCreated = prime.data?.info?.time?.created ?? 0
  log(`[5] priming turn completed; baseline created=${baselineCreated}`)

  // [6] load config (real QQ credentials) + SMTP transport
  const config = loadConfig()
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  })
  const from = config.smtp.user
  const to = config.recipient || config.smtp.user

  // [7] simulate request_decision outbound email (routing token in subject)
  const outboundSubject = `[omo:${sessionID}] ${OUTBOUND_SUBJECT_PART}`
  const outboundInfo = await transporter.sendMail({
    from,
    to,
    subject: outboundSubject,
    text: OUTBOUND_BODY,
  })
  log(`[7] outbound sent subject="${outboundSubject}" messageId=${outboundInfo.messageId}`)

  // [8] simulate human reply ("Re:" + token; inReplyTo the outbound)
  const replySubject = `Re: ${outboundSubject}`
  const replyInfo = await transporter.sendMail({
    from,
    to,
    subject: replySubject,
    text: REPLY_BODY,
    inReplyTo: outboundInfo.messageId,
  })
  log(`[8] reply sent subject="${replySubject}" messageId=${replyInfo.messageId}`)

  // [9] connect imapflow to the REAL QQ mailbox
  imapClient = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
  })
  await imapClient.connect()
  await imapClient.mailboxOpen(config.folder)
  log(`[9] IMAP connected + mailbox "${config.folder}" open`)

  // [10] bounded-retry scanAndProcess. QQ self-mail delivery is eventually
  // consistent AND slow/variable (observed ~12s for the outbound, >40s for the
  // "Re:" reply in a prior run; a dedicated probe measured ~40s for both to
  // land). Give a generous bounded window (~3.5 min) of subject-filtered scans.
  let injectedResult = null
  const SCAN_ATTEMPTS = 30
  const SCAN_DELAY_MS = 7000
  for (let i = 1; i <= SCAN_ATTEMPTS; i++) {
    let results
    try {
      results = await scanAndProcess(imapClient, client, config, {
        log: (...a) => log("    [scan]", ...a),
      })
    } catch (e) {
      log(`    scan attempt ${i}/${SCAN_ATTEMPTS} threw: ${e.message}`)
      results = []
    }
    log(`[10] scan attempt ${i}/${SCAN_ATTEMPTS}: ${results.length} result(s)`)
    for (const r of results) {
      log(
        `       uid=${r.uid} ok=${r.ok} skipped=${!!r.skipped} injected=${!!r.injected} sessionID=${r.sessionID ?? "-"}${r.error ? ` error=${r.error}` : ""}`
      )
    }
    const hit = results.find((r) => r.injected === true && r.sessionID === sessionID)
    if (hit) {
      injectedResult = hit
      break
    }
    if (i < SCAN_ATTEMPTS) await sleep(SCAN_DELAY_MS)
  }

  // Assertion (b): scanAndProcess fetched/parsed/injected/acked the reply for
  // THIS session. `injected:true` is only set after injectReply returned
  // {ok:true}, which itself only happens when client.session.prompt resolved
  // (i.e. the SDK prompt returned success).
  if (!injectedResult) {
    throw new Error(
      `scanAndProcess never injected the reply into ${sessionID} after ${SCAN_ATTEMPTS} attempts`
    )
  }
  log(`[ASSERT b] scanAndProcess injected reply into ${sessionID} (session.prompt success) → PASS`)

  // Assertion (a): poll the session for a NEW assistant message containing "42".
  let wokeText = null
  for (let i = 1; i <= 15; i++) {
    const msgsRes = await client.session.messages({ path: { id: sessionID } })
    const msgs = msgsRes.data ?? []
    const newAssistant = msgs
      .filter((m) => m.info?.role === "assistant")
      .filter((m) => (m.info?.time?.created ?? 0) > baselineCreated)
      .map((m) => partsText(m.parts))
    const hit = newAssistant.find((t) => t.includes("42"))
    if (hit) {
      wokeText = hit
      break
    }
    log(`    poll ${i}: ${newAssistant.length} new assistant msg(s), "42" found=${!!hit}`)
    if (!hit) await sleep(2000)
  }
  if (!wokeText) {
    throw new Error("no new assistant message containing \"42\" after injection")
  }
  log(`[ASSERT a] session WOKE; new assistant reply contains "42" → PASS`)
  log(`            wake reply text=${JSON.stringify(wokeText)}`)

  log("=".repeat(66))
  log("E2E OK")
  log("=".repeat(66))
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup() {
  const note = []
  try {
    // Mark this run's sent emails \Seen so the real mailbox isn't left with
    // an unseen (skipped) outbound copy. Best-effort.
    if (imapClient && sessionID) {
      try {
        const uids = await imapClient.search({ subject: `[omo:${sessionID}]` }, { uid: true })
        for (const uid of uids) {
          await imapClient.messageFlagsAdd({ uid }, ["\\Seen"])
        }
        note.push(`marked ${uids.length} email(s) \Seen for ${sessionID}`)
      } catch (e) {
        note.push(`(warn) mailbox cleanup skipped: ${e.message}`)
      }
    }
    if (imapClient) {
      try {
        await imapClient.logout()
        note.push("IMAP logged out")
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    note.push(`(warn) imap cleanup: ${e.message}`)
  }

  // Delete throwaway session (SDK equivalent of `opencode session delete <id>`).
  if (sdkClient && sessionID) {
    try {
      const del = await sdkClient.session.delete({ path: { id: sessionID } })
      note.push(`session ${sessionID} deleted (result=${JSON.stringify(del.data)})`)
    } catch (e) {
      note.push(`(warn) session delete failed: ${e.message}`)
    }
  }

  // Kill serve, verify no orphan + port free.
  if (serveChild) {
    const pid = serveChild.pid
    try {
      await killServe(serveChild)
    } catch (e) {
      note.push(`(warn) serve kill: ${e.message}`)
    }
    const alive = (() => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })()
    const free = servePort ? await isPortFree(servePort) : "n/a"
    note.push(`serve pid=${pid} alive=${alive} port=${servePort} portFree=${free}`)
  }

  // Remove the throwaway journal.
  try {
    rmSync(JOURNAL, { force: true })
    note.push("temp journal removed")
  } catch {
    /* ignore */
  }

  log("--- CLEANUP RECEIPT ---")
  for (const line of note) log("  " + line)
}

let ok = false
try {
  await run()
  ok = true
} catch (e) {
  log("=".repeat(66))
  log(`E2E FAIL: ${e?.message ?? String(e)}`)
  if (e?.stack) log(e.stack)
  log("=".repeat(66))
} finally {
  await cleanup()
}

process.exitCode = ok ? 0 : 1

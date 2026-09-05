// afk single-watcher daemon (PUSH architecture).
//
// ONE process per machine owns the IMAP IDLE watcher for the shared mailbox.
// Every opencode instance runs only the thin plugin client (index.js), which
// spawns this daemon (detached) and talks to it over HTTP. This eliminates the
// multi-instance race: there is exactly ONE watcher.
//
// Responsibilities:
//   - Bind a fixed port (atomic single-instance lock: EADDRINUSE = a daemon
//     already exists → exit quietly).
//   - HTTP server:
//       GET  /health                  liveness probe
//       GET  /events                  SSE stream (one-way push of `delivery` events)
//       GET  /pending                 list pending deliveries (reconnect catch-up)
//       POST /claim {uid,sessionID,instanceId}  atomic claim (multi-instance dedupe)
//       POST /ack   {uid,sessionID,instanceId}  claimant-only ack → markSeen + journal + remove
//       POST /register   {sessionID}  reserve a decision (single-outstanding guard)
//       DELETE /register {sessionID}  release a reservation
//       GET  /mode                    current GLOBAL email mode ("on"|"off")
//       POST /mode {mode}             validate + persist + broadcast a `mode` SSE event
//   - The ONLY IMAP watcher (watcher.js) + catch-up scan (onReady) + live IDLE
//     path (onMail), both through process.js scanAndProcess with a UID-cursor
//     incremental search (UID > cursor; NOT `\Seen`, NOT SUBJECT).
//   - Reply pipeline: fetch → parse → PERSIST to the durable pending-store +
//     broadcast over SSE. NO `\Seen`, NO journal at parse time. The `\Seen` +
//     journal ack happens in the `/ack` handler, only after the owning instance
//     injected the reply in-process. This is the P0 fix: a crash between parse
//     and ack leaves the mail UNSEEN and the pending durable — no loss.
//   - Clean shutdown on SIGTERM/SIGINT.

import http from "node:http"
import { pathToFileURL } from "node:url"

import { loadConfig } from "./config.js"
import { startWatcher, stopWatcher, getWatcherClient } from "./core/watcher.js"
import { scanAndProcess } from "./core/process.js"
import { createRegistry } from "./store/registry.js"
import { createPendingStore } from "./store/pending-store.js"
import { createModeStore } from "./store/mode-store.js"
import { markSeenAndJournal } from "./core/inject.js"

const DEFAULT_PORT = 4100
const DEFAULT_HOST = "127.0.0.1"
const MAX_BODY_BYTES = 1_000_000

function debugEnabled() {
  return process.env.AFK_DEBUG === "1" || process.env.AFK_DEBUG === "true"
}

function debug(...args) {
  if (debugEnabled()) console.error("[afk:daemon]", ...args)
}

function error(...args) {
  console.error("[afk:daemon:error]", ...args)
}

// Read a JSON request body with a size cap. Rejects on oversized/malformed body.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch (err) {
        reject(err)
      }
    })
    req.on("error", reject)
  })
}

// Write one SSE `delivery` event to a response. Best-effort: a gone client is
// ignored (its socket errors are swallowed; it is removed on 'close').
function writeDelivery(res, entry) {
  try {
    res.write(`event: delivery\ndata: ${JSON.stringify({
      uid: entry.uid,
      sessionID: entry.sessionID,
      body: entry.body,
      from: entry.from,
    })}\n\n`)
  } catch {
    /* client disconnected mid-write — removed on 'close' */
  }
}

// Write one SSE `mode` event to a response (the GLOBAL email-mode gate). A
// (re)connecting instance uses the initial event to learn the current mode; a
// live event follows every POST /mode change.
function writeModeEvent(res, mode) {
  try {
    res.write(`event: mode\ndata: ${JSON.stringify({ mode })}\n\n`)
  } catch {
    /* client disconnected mid-write — removed on 'close' */
  }
}

/**
 * Build the daemon's HTTP server (not yet listening). Exported for tests.
 *
 * @param {ReturnType<typeof createRegistry>} registry
 * @param {ReturnType<typeof createPendingStore>} pendingStore
 * @param {{debug?: Function, error?: Function, onAck?: (uid: string) => Promise<void>, modeStore?: ReturnType<typeof createModeStore>}} [deps]
 * @returns {{server: import("node:http").Server, broadcast: (entry: object) => void}}
 */
export function createHttpServer(registry, pendingStore, { debug: debugFn, error: errorFn, onAck, modeStore } = {}) {
  const log = debugFn ?? (() => {})
  const errLog = errorFn ?? ((...a) => console.error(...a))
  const mode = modeStore ?? createModeStore()

  // Connected SSE clients (response objects). One-way push only.
  const clients = new Set()

  function broadcast(entry) {
    for (const res of clients) writeDelivery(res, entry)
  }

  function broadcastMode(next) {
    for (const res of clients) writeModeEvent(res, next)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(200, { ok: true })
      return
    }

    // SSE stream. One-way push; (re)broadcast any unclaimed/stale pending on
    // connect so a restarted instance re-discovers deliveries for its directory.
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      res.flushHeaders?.()
      clients.add(res)
      res.on("close", () => clients.delete(res))
      res.write("retry: 3000\n\n")
      writeModeEvent(res, mode.get())
      for (const entry of pendingStore.listClaimable()) {
        writeDelivery(res, entry)
      }
      return // keep the stream open — do NOT end the response
    }

    // Current mode (GLOBAL email-mode gate).
    if (req.method === "GET" && url.pathname === "/mode") {
      json(200, { ok: true, mode: mode.get() })
      return
    }

    // Set the mode (GLOBAL email-mode gate). Validates "on"|"off", persists,
    // and broadcasts a `mode` event to every connected SSE client so all
    // instances learn the change immediately.
    if (req.method === "POST" && url.pathname === "/mode") {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        json(400, { ok: false, error: "invalid body" })
        return
      }
      const next = body?.mode
      if (next !== "on" && next !== "off") {
        json(400, { ok: false, error: "mode must be \"on\" or \"off\"" })
        return
      }
      mode.set(next)
      log(`mode → ${next}`)
      broadcastMode(next)
      json(200, { ok: true, mode: next })
      return
    }

    // Current pending deliveries (reconnect catch-up, non-streaming).
    if (req.method === "GET" && url.pathname === "/pending") {
      json(200, { ok: true, pending: pendingStore.list() })
      return
    }

    // Atomic claim for multi-instance dedupe. First claimant wins.
    if (req.method === "POST" && url.pathname === "/claim") {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        json(400, { ok: false, error: "invalid body" })
        return
      }
      const uid = body?.uid != null ? String(body.uid) : ""
      const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
      const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
      if (!uid || !sessionID || !instanceId) {
        json(400, { ok: false, error: "uid, sessionID and instanceId are required" })
        return
      }
      const result = pendingStore.claim({ uid, sessionID, instanceId })
      log(`claim ${uid} ${sessionID} ${instanceId} → ${result.claimed ? "claimed" : "not claimed"}`)
      json(200, { ok: true, claimed: result.claimed })
      return
    }

    // Claimant-only ack. On ack: markSeen + journal (durable dedupe) THEN remove
    // the pending. Ordering matters: journal before remove, so a crash between
    // the two leaves the UID journaled (never re-fetched) — at-least-once, not lost.
    if (req.method === "POST" && url.pathname === "/ack") {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        json(400, { ok: false, error: "invalid body" })
        return
      }
      const uid = body?.uid != null ? String(body.uid) : ""
      const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
      const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
      if (!uid || !sessionID || !instanceId) {
        json(400, { ok: false, error: "uid, sessionID and instanceId are required" })
        return
      }

      if (!pendingStore.canAck({ uid, sessionID, instanceId })) {
        json(409, { ok: false, error: "not the claimant" })
        return
      }

      try {
        if (onAck) await onAck(uid)
      } catch (err) {
        errLog(`ack ${uid} failed: ${err && err.message ? err.message : String(err)}`)
        json(500, { ok: false, error: "ack failed" })
        return
      }

      pendingStore.remove(uid)
      // Release the single-outstanding-decision reservation so the session can
      // ask a new decision (moved here from processMail's old onResolved path).
      registry.release(sessionID)
      log(`ack ${uid} ${sessionID} (delivered + journaled + released)`)
      json(200, { ok: true })
      return
    }

    if (req.method === "POST" && url.pathname === "/register") {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        json(400, { ok: false, error: `invalid body: ${err.message}` })
        return
      }
      const sessionID = typeof body?.sessionID === "string" ? body.sessionID : ""
      if (!sessionID) {
        json(400, { ok: false, error: "sessionID is required" })
        return
      }
      const { alreadyPending } = registry.register(sessionID)
      log(`register ${sessionID}${alreadyPending ? " (already pending)" : ""}`)
      json(200, { ok: true, alreadyPending })
      return
    }

    if (req.method === "DELETE" && url.pathname === "/register") {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        json(400, { ok: false, error: "invalid body" })
        return
      }
      registry.release(String(body?.sessionID ?? ""))
      log(`release ${body?.sessionID ?? ""}`)
      json(200, { ok: true })
      return
    }

    json(404, { ok: false, error: "not found" })
  })

  return { server, broadcast }
}

// The daemon's persist seam: store a parsed reply durably and broadcast it once.
// This is wired into scanAndProcess as `injectReply` — it does NOT inject and
// does NOT ack; injection is the owning instance's job (in-process), ack is the
// `/ack` handler's job.
function makeStoreReply(pendingStore, { broadcast, debug: debugFn } = {}) {
  const debugLog = debugFn ?? (() => {})
  return async (_client, { sessionID, body, from, uid }) => {
    const { created, entry } = pendingStore.add({ uid, sessionID, body, from })
    debugLog(`stored pending delivery uid=${entry.uid} session=${sessionID}${created ? " (new)" : " (dup)"}`)
    if (created) broadcast(entry)
    return { ok: true }
  }
}

// Bind the HTTP server, resolving on listen or rejecting on EADDRINUSE/other.
function bindServer(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.once("listening", () => resolve(server))
    server.listen(port, host)
  })
}

/**
 * Run the daemon: bind (single-instance), serve HTTP, start the IMAP watcher,
 * and install signal handlers. Does not return until shutdown.
 */
export async function startDaemon() {
  const port = Number(process.env.AFK_DAEMON_PORT || DEFAULT_PORT)
  const host = process.env.AFK_DAEMON_HOST || DEFAULT_HOST

  // Load config best-effort: a bad config must not take the daemon down (the
  // HTTP surface + pending-store still serve, the watcher just stays down).
  let config = null
  let folder = "INBOX"
  try {
    config = loadConfig()
    folder = config.folder
  } catch (err) {
    error("config load failed:", err.message)
  }

  const registry = createRegistry()
  const pendingStore = createPendingStore({ claimTtlMs: config?.tuning?.claimTtlMs })
  const modeStore = createModeStore()

  // The `/ack` handler's durable half: journal (always) + mark \Seen (best-effort,
  // only when the watcher's IMAP client is live). Detection is by UID cursor, so
  // the \Seen mark is cosmetic — the journal is the real dedupe.
  const onAck = async (uid) => {
    await markSeenAndJournal(getWatcherClient(), folder, uid)
  }

  const { server, broadcast } = createHttpServer(registry, pendingStore, { debug, error, onAck, modeStore })

  try {
    await bindServer(server, host, port)
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      debug(`port ${port} already bound — another daemon is running; exiting quietly`)
      process.exit(0)
    }
    error(`daemon failed to bind ${host}:${port}:`, err.message)
    process.exit(1)
  }
  debug(`daemon listening on http://${host}:${port}`)

  // Start the single IMAP watcher. Best-effort: a bad config or a transient
  // IMAP failure must not take the daemon down — the HTTP registry stays up and
  // the watcher retries in the background (watcher.js reconnect loop).
  let scanInFlight = false
  if (config) {
    try {
      const storeReply = makeStoreReply(pendingStore, { broadcast, debug })
      const scan = (imapClient) => {
        if (scanInFlight) return Promise.resolve()
        scanInFlight = true
        return scanAndProcess(imapClient, null, config, { injectReply: storeReply })
          .catch((err) => error("scan failed:", err.message))
          .finally(() => {
            scanInFlight = false
          })
      }
      startWatcher(config, {
        onMail: (imapClient) => scan(imapClient),
        onReady: (imapClient) => scan(imapClient),
        tuning: config.tuning,
      }).catch((err) => error("watcher failed to start (daemon stays up):", err.message))
    } catch (err) {
      error("watcher start failed (daemon stays up):", err.message)
    }
  } else {
    error("no config — watcher not started (daemon stays up; pending-store + SSE serve)")
  }

  // Clean shutdown.
  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    debug("shutting down")
    stopWatcher().catch(() => {})
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  startDaemon().catch((err) => {
    error("daemon fatal:", err.message)
    process.exit(1)
  })
}

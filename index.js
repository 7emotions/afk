// email-wake plugin — THIN CLIENT (single-watcher daemon, PUSH architecture).
//
// The plugin no longer holds an IMAP watcher and no longer polls for replies.
// Instead it ensures ONE shared daemon (daemon.js) is running on this machine,
// then opens a single SSE stream to the daemon. The daemon owns the single IMAP
// watcher, persists parsed replies, and PUSHes them over SSE; the plugin's
// in-process subscriber (subscribe.js) self-checks ownership, claims, and
// injects the reply IN-PROCESS via its own injected `input.client`.
//
//   server(input):
//     1. resolve the daemon base URL (default http://127.0.0.1:4100, override
//        EMAIL_WAKE_DAEMON_URL / EMAIL_WAKE_DAEMON_PORT).
//     2. probe GET /health; if unreachable, spawn a detached daemon and poll
//        /health until ready (bounded ~15s).
//     3. start the SSE subscriber ONCE (fire-and-forget) — it reconnects with
//        backoff and catches up on /pending, so a background session that never
//        re-issues request_decision still receives its reply after a restart.
//     4. expose the request_decision tool, which SMTP-sends the question and
//        POSTs /register {sessionID} (the single-outstanding-decision guard).

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"

import { tool } from "@opencode-ai/plugin"
import { createRequestDecisionTool } from "./request-decision.js"
import { startSubscription } from "./core/subscribe.js"
import { loadConfig } from "./config.js"
import { loadMessages } from "./messages.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DAEMON_PATH = join(__dirname, "daemon.js")

const DEFAULT_DAEMON_PORT = 4100
const DAEMON_PROBE_TIMEOUT_MS = 1000
const DAEMON_READY_TIMEOUT_MS = 15000
const DAEMON_POLL_INTERVAL_MS = 250

// Module state: the injected in-process client + daemon URL captured at plugin
// load, and the single SSE subscriber (started once, survives the tool-call
// return; the opencode process stays alive until a reply arrives).
let client = null
let daemonUrl = null
let subscriberStop = null

function debugEnabled() {
  return process.env.EMAIL_WAKE_DEBUG === "1" || process.env.EMAIL_WAKE_DEBUG === "true"
}

// The daemon base URL: EMAIL_WAKE_DAEMON_URL wins; otherwise derive from
// EMAIL_WAKE_DAEMON_PORT (so overriding the port also moves the probe target).
function resolveDaemonUrl(env = process.env) {
  if (env.EMAIL_WAKE_DAEMON_URL) return env.EMAIL_WAKE_DAEMON_URL
  const port = env.EMAIL_WAKE_DAEMON_PORT || DEFAULT_DAEMON_PORT
  return `http://127.0.0.1:${port}`
}

// Probe the daemon's /health endpoint. True only when the response body is
// `{ok:true}`. Bounded by a timeout so an unreachable daemon fails fast.
async function probeHealth(url, timeoutMs = DAEMON_PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal })
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    return data?.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// Spawn a detached daemon process. Only ONE wins the bind (atomic single-
// instance); a loser exits quietly on EADDRINUSE.
function spawnDaemon(env = process.env) {
  const child = spawn(process.execPath, [DAEMON_PATH], {
    detached: true,
    stdio: "ignore",
    env,
  })
  child.unref()
  return child
}

// Ensure the daemon is up: probe first; if unreachable, spawn a fresh one and
// poll /health until ready (bounded). Returns true when healthy.
async function ensureDaemon(daemonUrl) {
  if (await probeHealth(daemonUrl)) return true
  spawnDaemon()
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(DAEMON_POLL_INTERVAL_MS)
    if (await probeHealth(daemonUrl)) return true
  }
  return false
}

// Plugin entry.
const server = async (input, _options) => {
  client = input.client
  daemonUrl = resolveDaemonUrl()
  const directory = input.directory
  // A stable per-instance identity for claim/ack dedupe. The instance's own
  // serverUrl is unique and stable for its lifetime.
  const instanceId = input.serverUrl?.toString?.() || `instance-${process.pid}`

  // Load config best-effort for the subscriber's reconnect tuning. A bad/missing
  // config must not block plugin load — the subscriber falls back to its own
  // reconnect defaults (subscribe.js DEFAULT_RECONNECT_*), and request_decision
  // still loads config on demand.
  let config = null
  try {
    config = loadConfig()
  } catch {
    config = null
  }

  // Fire-and-forget so plugin load never blocks on the daemon (ensureDaemon
  // can poll /health for up to ~15s). registerDecision re-ensures on demand.
  ensureDaemon(daemonUrl)
    .then((ok) => {
      if (!ok) {
        console.error(
          "[email-wake] daemon unreachable after spawn; request_decision will not auto-register (plugin stays loaded)"
        )
      }
    })
    .catch(() => {})

  // Start the SSE subscriber ONCE. It reconnects with backoff and catches up on
  // /pending on every (re)connect, so it recovers on its own even if the daemon
  // comes up later or the instance restarts.
  const ensureSubscriber = () => {
    if (subscriberStop) return
    subscriberStop = startSubscription({
      daemonUrl,
      instanceId,
      directory,
      getClient: () => client,
      reconnectBaseMs: config?.tuning?.reconnectBaseMs,
      reconnectMaxMs: config?.tuning?.reconnectMaxMs,
      debug: (...args) => {
        if (debugEnabled()) console.error("[email-wake:subscribe]", ...args)
      },
      error: (...args) => console.error("[email-wake:subscribe:error]", ...args),
    })
  }
  ensureSubscriber()

  // POST /register {sessionID}. The daemon's response carries alreadyPending
  // (single-outstanding-decision guard). Throws if the daemon is unreachable
  // after a re-probe.
  const registerDecision = async ({ sessionID }) => {
    if (!(await probeHealth(daemonUrl))) {
      if (!(await ensureDaemon(daemonUrl))) {
        throw new Error("email-wake daemon unreachable")
      }
    }
    const res = await fetch(`${daemonUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID }),
    })
    if (!res.ok) throw new Error(`register failed: HTTP ${res.status}`)
    const data = await res.json()
    return { alreadyPending: data.alreadyPending === true }
  }

  // Release a reserved decision (used on SMTP-send failure). Best-effort.
  const releaseDecision = async (sessionID) => {
    try {
      await fetch(`${daemonUrl}/register`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionID }),
      })
    } catch {
      /* best-effort; a stale entry is TTL-pruned anyway */
    }
  }

  // GET /mode. Any failure (daemon down, bad response) reads as "off" — the
  // safe default: never email when the mode cannot be confirmed as "on".
  const getMode = async () => {
    try {
      const res = await fetch(`${daemonUrl}/mode`)
      if (!res.ok) return "off"
      const data = await res.json().catch(() => null)
      return data?.mode === "on" ? "on" : "off"
    } catch {
      return "off"
    }
  }

  // The message table (best-effort: a missing config falls back to English).
  const messages = loadMessages(config ?? {})

  // POST /mode {mode}. The GLOBAL email-mode switch. Re-ensures the daemon
  // like registerDecision does (the mode lives in the daemon's durable store).
  const setEmailMode = tool({
    description:
      "Set the GLOBAL email mode. 'on' means the human has left the screen " +
      "(they ran /afk) and request_decision may email them; 'off' means the " +
      "human is at the screen and request_decision will refuse — the agent must " +
      "use the built-in question tool instead. Returns a short confirmation.",
    args: {
      mode: tool.schema
        .enum(["on", "off"])
        .describe("Target mode: 'on' (human away) or 'off' (human at screen)"),
    },
    async execute(args, _toolContext) {
      if (!(await probeHealth(daemonUrl))) {
        if (!(await ensureDaemon(daemonUrl))) {
          throw new Error("email-wake daemon unreachable")
        }
      }
      const res = await fetch(`${daemonUrl}/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: args.mode }),
      })
      if (!res.ok) throw new Error(`set_email_mode failed: HTTP ${res.status}`)
      const data = await res.json().catch(() => null)
      return data?.mode === "on" ? messages.tool.modeOn : messages.tool.modeDisabled
    },
  })

  return {
    tool: {
      request_decision: createRequestDecisionTool({
        getClient: () => client,
        getDirectory: () => directory,
        registerDecision,
        releaseDecision,
        getMode,
      }),
      set_email_mode: setEmailMode,
    },
  }
}

export { resolveDaemonUrl, probeHealth, spawnDaemon, ensureDaemon }

export default { id: "email-wake", server }

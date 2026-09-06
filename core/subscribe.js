// afk SSE subscriber (plugin-side, IN-PROCESS).
//
// The PUSH half of the architecture. The daemon parses replies, persists them
// durably, and broadcasts a `delivery` event over SSE. This module runs INSIDE
// the opencode server process (as part of the plugin), opens the SSE stream to
// the daemon, and — for every `delivery` event — self-checks ownership (does the
// session live in THIS instance's directory?), claims it, injects it IN-PROCESS
// via the injected `input.client`, then acks. Only the owning instance acts;
// every other connected instance ignores the event.
//
//   startSubscription({ daemonUrl, instanceId, directory, getClient, ... })
//       → returns a stop() function.
//
// Reconnect: on SSE error/close, reconnect with exponential backoff. On every
// (re)connect it also GETs /pending and processes any owned pending (catch-up) —
// this is the fix for the old "blind poller": an instance that restarts
// re-discovers pending deliveries for its directory, no per-session poller.
//
// Exactly-once is impossible for a PUSH channel (injection is not idempotent), so
// delivery is AT-LEAST-ONCE: the journal (written on ack) prevents re-FETCH after
// ack, and a crash between inject and ack leaves the pending (re-broadcast on
// reconnect) → the reply may be injected twice, but is never lost.

import { injectReply } from "./inject.js"
import { createSessionAndPrompt } from "./new-session.js"

export const DEFAULT_RECONNECT_BASE_MS = 1000
export const DEFAULT_RECONNECT_MAX_MS = 30_000

// Parse one SSE block ("event: delivery\ndata: {...}") into {event, data}.
function parseEvent(block) {
  let event = "message"
  const dataLines = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  return { event, data: dataLines.join("\n") }
}

/**
 * Process one `delivery` event: ownership self-check → claim → inject → ack.
 * Exported for direct testing of the claim/ack ordering; startSubscription feeds
 * it every SSE event.
 *
 * A `command: "new"` delivery is a "/new <task>" request: after the same
 * ownership + claim gates, it SPAWNS a new session in this instance's directory
 * (the replying session lives here, so the new one does too) instead of
 * injecting into the replying session.
 *
 * @param {{uid: string, sessionID: string, body: string, from?: string, command?: string}} delivery
 * @param {object} opts  same shape as startSubscription.
 * @returns {Promise<boolean>} true iff the delivery was handled AND acked.
 */
export async function handleDelivery({ uid, sessionID, body, from, command }, opts) {
  const {
    daemonUrl,
    instanceId,
    directory,
    getClient,
    fetchImpl = fetch,
    debug = () => {},
    error = () => {},
  } = opts

  const client = getClient()
  if (!client) {
    error(`[subscribe] no in-process client — ignoring delivery for ${sessionID}`)
    return false
  }

  // Ownership self-check: the session must live in THIS instance's directory.
  // If we can't determine it (error / missing data), do NOT claim or inject.
  let owned = false
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    owned = typeof res?.data?.directory === "string" && res.data.directory === directory
  } catch {
    owned = false
  }
  if (!owned) {
    debug(`[subscribe] session ${sessionID} not owned by this instance — ignoring`)
    return false
  }

  // Atomic claim for multi-instance dedupe. A second instance sharing this
  // directory (or a lost race) must not double-inject.
  let claimed = false
  try {
    const res = await fetchImpl(`${daemonUrl}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, sessionID, instanceId }),
    })
    const data = await res.json().catch(() => null)
    claimed = data?.claimed === true
  } catch {
    claimed = false
  }
  if (!claimed) {
    debug(`[subscribe] claim for ${sessionID} lost (another instance) — ignoring`)
    return false
  }

  // command "new" → spawn a NEW session in THIS directory (the ownership check
  // above already proved the replying session lives here). Otherwise inject the
  // reply into the replying session as usual.
  const result =
    command === "new"
      ? await createSessionAndPrompt(client, { directory, body, from }, opts.newSessionDeps)
      : await injectReply(client, { sessionID, body, from })
  if (!result || result.ok !== true) {
    const where = command === "new" ? "new-session spawn" : "inject"
    error(`[subscribe] ${where} failed for ${sessionID} (${result?.error ?? "unknown"}) — NOT acking; pending stays for retry`)
    return false
  }

  // Ack (markSeen + journal + remove pending). Best-effort: on failure the
  // pending stays and is re-broadcast (at-least-once, never lost).
  try {
    await fetchImpl(`${daemonUrl}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid, sessionID, instanceId }),
    })
  } catch (err) {
    error(`[subscribe] ack failed for ${sessionID}: ${err?.message ?? err}`)
  }
  debug(`[subscribe] injected + acked ${sessionID} (uid ${uid})`)
  return true
}

/**
 * Open the SSE stream and process `delivery` events, reconnecting on error/close.
 *
 * @param {object} opts
 * @param {string} opts.daemonUrl       Daemon base URL (http://127.0.0.1:4100).
 * @param {string} opts.instanceId      This instance's stable id (serverUrl).
 * @param {string} opts.directory       This instance's working directory.
 * @param {() => object|null} opts.getClient  In-process SDK client accessor.
 * @param {Function} [opts.fetchImpl]   Fetch implementation (tests inject a fake).
 * @param {Function} [opts.debug] / [opts.error]  Loggers.
 * @param {number} [opts.reconnectBaseMs] / [opts.reconnectMaxMs]  Backoff bounds.
 * @returns {() => void} Stop function (idempotent).
 */
export function startSubscription(opts) {
  const {
    daemonUrl,
    fetchImpl = fetch,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    debug = () => {},
  } = opts

  let stopped = false
  let backoff = reconnectBaseMs
  let abort = null
  let reconnectTimer = null

  // Catch-up: GET /pending and process every owned pending. Runs on (re)connect.
  async function catchUp() {
    let data
    try {
      const res = await fetchImpl(`${daemonUrl}/pending`)
      if (!res.ok) return
      data = await res.json().catch(() => null)
    } catch {
      return
    }
    if (!data || !Array.isArray(data.pending)) return
    for (const entry of data.pending) {
      if (stopped) return
      try {
        await handleDelivery(entry, opts)
      } catch (err) {
        opts.error?.(`[subscribe] catch-up failed for ${entry.uid}: ${err?.message ?? err}`)
      }
    }
  }

  async function connect() {
    const controller = new AbortController()
    abort = controller

    let res
    try {
      res = await fetchImpl(`${daemonUrl}/events`, { signal: controller.signal })
    } catch {
      if (!stopped) scheduleReconnect()
      return
    }
    if (!res.ok || !res.body) {
      if (!stopped) scheduleReconnect()
      return
    }

    backoff = reconnectBaseMs // reset backoff on a successful connect
    debug(`[subscribe] connected to ${daemonUrl}/events`)
    void catchUp()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const ev = parseEvent(block)
          if (ev.event === "delivery" && ev.data) {
            try {
              const payload = JSON.parse(ev.data)
              await handleDelivery(payload, opts)
            } catch (err) {
              opts.error?.(`[subscribe] delivery failed: ${err?.message ?? err}`)
            }
          }
        }
      }
    } catch (err) {
      debug(`[subscribe] stream closed (${err?.message ?? "eof"}) — reconnecting`)
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        /* already released */
      }
    }
    if (!stopped) scheduleReconnect()
  }

  function scheduleReconnect() {
    if (stopped) return
    const delay = backoff
    backoff = Math.min(backoff * 2, reconnectMaxMs)
    debug(`[subscribe] reconnecting in ${delay}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped) return
      connect().catch(() => {})
    }, delay)
  }

  function stop() {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (abort) {
      try {
        abort.abort()
      } catch {
        /* already aborted */
      }
    }
  }

  connect().catch(() => {})
  return stop
}

export default startSubscription

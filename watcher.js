// email-wake IMAP IDLE watcher (T4).
//
// Persistent connection to the IMAP server (imap.qq.com) that selects the
// configured folder, enters IDLE, and fires an `onMail` callback whenever the
// server pushes a new-message notification. Auto-reconnects with exponential
// backoff. NO polling: new mail is delivered by the server over IDLE push.
//
// T5 (catch-up scan) and T6 (reply parsing) do the real message processing;
// this module only signals "new mail arrived".

import { ImapFlow } from "imapflow"

// IMAP IDLE servers (including imap.qq.com) terminate an idle session after
// ~29 minutes. imapflow re-issues IDLE automatically every `maxIdleTime` ms,
// so keep it safely below the server's timeout window.
export const DEFAULT_IDLE_RENEW_MS = 25 * 60 * 1000
// How long the connection stays quiet before imapflow auto-starts IDLE.
export const DEFAULT_AUTO_IDLE_DELAY_MS = 1000
// Exponential reconnect backoff bounds.
export const DEFAULT_BACKOFF_INITIAL_MS = 1000
export const DEFAULT_BACKOFF_MAX_MS = 60_000

// Resolve the tuning values used by the watcher from `config.tuning` (passed by
// the daemon), falling back to the module defaults. The watcher never reads the
// config file itself — values are injected via the `tuning` option.
function resolveTuning(tuning) {
  return {
    idleRenewMs: tuning?.idleRenewMs ?? DEFAULT_IDLE_RENEW_MS,
    autoIdleDelayMs: tuning?.autoIdleDelayMs ?? DEFAULT_AUTO_IDLE_DELAY_MS,
    backoffInitialMs: tuning?.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
    backoffMaxMs: tuning?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
  }
}

// Module-level handle. Holds the single live connection and its control state.
// `isWatcherHealthy()` / `stopWatcher()` read it; null means "not running".
let handle = null

// Loggers. Never emit the password (imapflow's own logger is disabled via
// `logger: false`, and config is never serialized here).
//
// `debug` is informational/normal-operation logging — silent unless the
// EMAIL_WAKE_DEBUG env toggle is set. `error` is a real error and always
// emits to stderr (red). This split stops startup noise (e.g. "connected to
// imap.qq.com:993 … IDLE auto-starts") from looking like a failure.
function debugEnabled() {
  return process.env.EMAIL_WAKE_DEBUG === "1" || process.env.EMAIL_WAKE_DEBUG === "true"
}

function debug(...args) {
  if (debugEnabled()) {
    console.error("[email-wake:watcher]", ...args)
  }
}

function error(...args) {
  console.error("[email-wake:watcher:error]", ...args)
}

// IMAP error summary from server status/text only — never raw command or credentials.
function describeError(err) {
  if (!err) return "unknown error"
  const parts = []
  if (err.responseStatus) parts.push(err.responseStatus)
  if (err.responseText) parts.push(err.responseText)
  const detail = parts.length ? ` (${parts.join(" ")})` : ""
  return `${err.message || String(err)}${detail}`
}

// Build one ImapFlow client for the given config. `tuning.autoIdleDelayMs` makes
// IDLE start ~1s after the last command; `tuning.idleRenewMs` makes imapflow
// break and restart IDLE every 25 min so the server never drops us mid-idle.
function createClient(config, tuning) {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    logger: false,
    autoIdleDelay: tuning.autoIdleDelayMs,
    maxIdleTime: tuning.idleRenewMs,
  })
}

/**
 * Start the persistent IDLE watcher.
 *
 * @param {object} config  Resolved config (config.imap.{host,port,secure,user,password},
 *                         config.folder).
 * @param {object} opts
 * @param {(client: object) => void} opts.onMail   Called on every IDLE new-mail
 *   push, with the live imapflow client so the handler can search/fetch.
 * @param {(client: object) => Promise<void>} opts.onReady  Called once after
 *   every successful connect()+mailboxOpen() (initial AND reconnect), with the
 *   live client — used by T5's catch-up scan. Failures are logged, never thrown.
 * @param {object} [opts.tuning]  Tuning values (config.tuning from the daemon):
 *   idleRenewMs / autoIdleDelayMs / backoffInitialMs / backoffMaxMs. All optional;
 *   each falls back to its DEFAULT_* module constant.
 * @returns {Promise<object>} Resolves to the watcher handle on successful
 *   connect + select; rejects on initial failure (clear error, process stays up).
 */
export function startWatcher(config, { onMail, onReady, tuning } = {}) {
  if (!config?.imap?.host || !config?.imap?.user) {
    return Promise.reject(new Error("email-wake: startWatcher requires a valid imap config"))
  }
  if (typeof onMail !== "function") {
    return Promise.reject(new Error("email-wake: startWatcher requires an onMail handler"))
  }
  // One connection only. A second call while running returns the live handle.
  if (handle) {
    return handle.promise
  }

  const t = resolveTuning(tuning)

  const state = {
    stopped: false,
    client: null,
    backoff: t.backoffInitialMs,
    timer: null,
  }

  const scheduleReconnect = () => {
    if (state.stopped || state.timer) return
    const delay = state.backoff
    debug(`connection lost; reconnecting in ${delay}ms`)
    state.timer = setTimeout(() => {
      state.timer = null
      if (state.stopped) return
      state.backoff = Math.min(state.backoff * 2, t.backoffMaxMs)
      connectOnce().catch((err) => {
        debug("reconnect attempt failed:", describeError(err))
        scheduleReconnect()
      })
    }, delay)
  }

  const connectOnce = async () => {
    if (state.stopped) return
    const client = createClient(config, t)
    state.client = client

    // New-message push while idling. T5/T6 do the real processing; here we
    // only signal that mail arrived.
    client.on("exists", (data) => {
      if (data.count > data.prevCount) {
        debug(`new mail (IDLE push): ${data.prevCount} -> ${data.count} exists`)
        try {
          // Pass the live client so the handler (T5) can search/fetch the
          // newly-arrived message(s) without opening a second connection.
          onMail(client)
        } catch (err) {
          error("onMail handler threw:", err.message)
        }
      }
    })
    client.on("expunge", (data) => {
      debug(`message expunged: seq=${data.seq ?? "?"} uid=${data.uid ?? "?"}`)
    })
    client.on("error", (err) => {
      // 'close' usually follows and drives the reconnect; log only.
      error("connection error:", err.message)
    })
    client.on("close", () => {
      debug("connection closed")
      scheduleReconnect()
    })

    try {
      await client.connect()
      await client.mailboxOpen(config.folder)
      debug(`connected to ${config.imap.host}:${config.imap.port}; selected ${config.folder}; IDLE auto-starts in ${t.autoIdleDelayMs}ms`)
      state.backoff = t.backoffInitialMs
      // Catch-up reconciliation (T5): run once after every successful
      // connect+select, before relying on IDLE. Never throw — a failed scan
      // must not take down the watcher.
      if (typeof onReady === "function") {
        try {
          await onReady(client)
        } catch (err) {
          error("onReady handler threw:", err.message)
        }
      }
    } catch (err) {
      const wrapped = new Error(`email-wake: IMAP connect/select failed: ${describeError(err)}`)
      wrapped.cause = err
      error(wrapped.message)
      throw wrapped
    }
  }

  // Initial connect. On success resolve to the handle; on failure surface the
  // error to the caller (clear + non-fatal) and keep retrying in the background.
  const promise = connectOnce().then(
    () => handle,
    (err) => {
      scheduleReconnect()
      throw err
    }
  )

  handle = { promise, state }
  return promise
}

/**
 * Whether the watcher is currently connected, authenticated, and has the
 * folder open (i.e. ready to receive IDLE pushes).
 * @returns {boolean}
 */
export function isWatcherHealthy() {
  if (!handle || handle.state.stopped) return false
  const client = handle.state.client
  if (!client) return false
  return Boolean(client.authenticated && client.mailbox)
}

/**
 * The current live imapflow client, or null when the watcher is not running.
 * Used by the daemon's `/ack` handler to mark a delivered reply \Seen (best-
 * effort — the durable journal is written regardless).
 * @returns {object|null}
 */
export function getWatcherClient() {
  if (!handle || handle.state.stopped) return null
  return handle.state.client ?? null
}

/**
 * Tear down the watcher: stop reconnect, close the connection, null the handle.
 * Safe to call when not running.
 * @returns {Promise<void>}
 */
export async function stopWatcher() {
  const h = handle
  if (!h) return
  handle = null
  h.state.stopped = true
  if (h.state.timer) {
    clearTimeout(h.state.timer)
    h.state.timer = null
  }
  const client = h.state.client
  h.state.client = null
  if (client) {
    try {
      if (client.authenticated) {
        await client.logout()
      } else {
        client.close()
      }
    } catch {
      try {
        client.close()
      } catch {
        /* already gone */
      }
    }
  }
  debug("watcher stopped")
}

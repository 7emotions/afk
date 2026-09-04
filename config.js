// email-wake configuration loader (T2).
//
// Loads config.json, applies defaults, applies env overrides, and validates
// required fields. Never logs or serializes the password (masked as "***").

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_CONFIG_PATH = join(__dirname, "config.json")

const DEFAULTS = {
  imap: {
    host: "imap.qq.com",
    port: 993,
    secure: true,
    user: undefined,
    password: undefined,
  },
  smtp: {
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user: undefined,
    password: undefined,
  },
  folder: "INBOX",
  tuning: {
    claimTtlMs: 60_000,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30_000,
    idleRenewMs: 25 * 60 * 1000,
    autoIdleDelayMs: 1000,
    backoffInitialMs: 1000,
    backoffMaxMs: 60_000,
  },
}

// The tuning defaults, exported so tests (and callers) can assert the current
// values without duplicating them. Kept in sync with DEFAULTS.tuning above.
export const DEFAULT_TUNING = { ...DEFAULTS.tuning }

function maskPassword(value) {
  return typeof value === "string" && value.length > 0 ? "***" : value
}

// Returns a copy of the config safe to serialize: passwords are masked.
export function redact(config) {
  return {
    imap: { ...config.imap, password: maskPassword(config.imap.password) },
    smtp: { ...config.smtp, password: maskPassword(config.smtp.password) },
    recipient: config.recipient,
    folder: config.folder,
    tuning: { ...config.tuning },
  }
}

function toPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`email-wake: invalid port "${value}"`)
  }
  return port
}

function applyEnvOverrides(imap, smtp, env) {
  const out = {
    imap: { ...imap },
    smtp: { ...smtp },
    recipient: undefined,
  }
  if (env.EMAIL_WAKE_IMAP_HOST !== undefined) out.imap.host = env.EMAIL_WAKE_IMAP_HOST
  if (env.EMAIL_WAKE_IMAP_PORT !== undefined) out.imap.port = toPort(env.EMAIL_WAKE_IMAP_PORT)
  if (env.EMAIL_WAKE_IMAP_USER !== undefined) out.imap.user = env.EMAIL_WAKE_IMAP_USER
  if (env.EMAIL_WAKE_IMAP_PASSWORD !== undefined) out.imap.password = env.EMAIL_WAKE_IMAP_PASSWORD
  if (env.EMAIL_WAKE_SMTP_HOST !== undefined) out.smtp.host = env.EMAIL_WAKE_SMTP_HOST
  if (env.EMAIL_WAKE_SMTP_PORT !== undefined) out.smtp.port = toPort(env.EMAIL_WAKE_SMTP_PORT)
  if (env.EMAIL_WAKE_SMTP_USER !== undefined) out.smtp.user = env.EMAIL_WAKE_SMTP_USER
  if (env.EMAIL_WAKE_SMTP_PASSWORD !== undefined) out.smtp.password = env.EMAIL_WAKE_SMTP_PASSWORD
  if (env.EMAIL_WAKE_RECIPIENT !== undefined) out.recipient = env.EMAIL_WAKE_RECIPIENT
  return out
}

function validate(imap) {
  if (!imap.user || typeof imap.user !== "string") {
    throw new Error("email-wake: missing required config field imap.user")
  }
  if (!imap.password || typeof imap.password !== "string") {
    throw new Error("email-wake: missing required config field imap.password")
  }
}

// Loads and validates the configuration.
//
// options.path — explicit config file path (defaults to DEFAULT_CONFIG_PATH,
//   overridable via EMAIL_WAKE_CONFIG).
// options.env  — env object to read overrides from (defaults to process.env).
//
// Returns the resolved config. Real passwords are accessible on the returned
// object (e.g. `config.imap.password`) for IMAP/SMTP use; serializing the
// object (JSON.stringify / console.log of a stringify) masks them via toJSON.
export function loadConfig(options = {}) {
  const env = options.env ?? process.env
  const path = options.path ?? env.EMAIL_WAKE_CONFIG ?? DEFAULT_CONFIG_PATH

  let raw
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`email-wake: invalid JSON in ${path}: ${error.message}`)
    }
    throw new Error(`email-wake: failed to read config file ${path}: ${error.message}`)
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("email-wake: config file must contain a JSON object")
  }

  const imap = { ...DEFAULTS.imap, ...(raw.imap ?? {}) }
  const smtp = { ...DEFAULTS.smtp, ...(raw.smtp ?? {}) }

  const overrides = applyEnvOverrides(imap, smtp, env)

  const recipient = overrides.recipient ?? raw.recipient ?? overrides.smtp.user
  const folder = raw.folder ?? DEFAULTS.folder
  const tuning = { ...DEFAULTS.tuning, ...(raw.tuning ?? {}) }

  // Sender allow list: only replies FROM these addresses may be injected (the
  // prompt-injection guard). Default = the plugin's own mailbox (smtp.user) —
  // the human replies from their own account. Lowercased for exact matching.
  const allowList = Array.isArray(raw.allowList) && raw.allowList.length > 0
    ? raw.allowList.map((a) => String(a).toLowerCase())
    : [overrides.smtp.user.toLowerCase()]

  validate(overrides.imap)

  const config = {
    imap: overrides.imap,
    smtp: overrides.smtp,
    recipient,
    folder,
    tuning,
    allowList,
  }
  config.toJSON = () => redact(config)
  return config
}

export default loadConfig

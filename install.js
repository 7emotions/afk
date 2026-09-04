#!/usr/bin/env node
// email-wake installer — one-shot, zero extra dependencies.
//
// Mirrors the spirit of oh-my-openagent's `install`: detect the opencode config
// dir, copy the plugin into place, `npm install` deps, scaffold config.json,
// register the plugin in opencode.jsonc (comment-preserving, text-level — never
// JSON.parse a JSONC file), copy the /afk + /back commands, and tell the user to
// reload.

import { homedir } from "node:os"
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs"
import { join, dirname, basename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const SRC = dirname(fileURLToPath(import.meta.url))
const CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
const PLUGIN_DIR =
  process.env.OPENCODE_PLUGIN_DIR || join(CONFIG_DIR, "plugins", "email-wake")
const COMMAND_DIR = process.env.OPENCODE_COMMAND_DIR || join(CONFIG_DIR, "command")

// Files that must never be copied into a fresh install (secrets / runtime state).
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  "config.json",
  "journal.json",
  "pending.json",
  "last-uid.json",
  "mode.json",
])

const log = (msg) => console.log(`[email-wake] ${msg}`)
const fail = (msg) => {
  console.error(`[email-wake] ERROR: ${msg}`)
  process.exit(1)
}

// Register the plugin dir in opencode.jsonc's "plugin" array via text-level
// insertion (JSONC may have comments/trailing commas — never JSON.parse it).
function addPluginToConfig(configPath, pluginDir) {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `{\n  "plugin": [\n    "${pluginDir}"\n  ]\n}\n`, "utf8")
    return true
  }

  let text = readFileSync(configPath, "utf8")
  if (text.includes(pluginDir)) return false // already registered

  const match = text.match(/"plugin"\s*:\s*\[/)
  if (match) {
    const insertAt = match.index + match[0].length
    text = text.slice(0, insertAt) + `\n    "${pluginDir}",` + text.slice(insertAt)
  } else {
    const lastBrace = text.lastIndexOf("}")
    if (lastBrace === -1) fail(`cannot parse ${configPath} (no closing brace)`)
    text =
      text.slice(0, lastBrace) +
      `  "plugin": [\n    "${pluginDir}"\n  ]\n` +
      text.slice(lastBrace)
  }

  writeFileSync(configPath, text, "utf8")
  return true
}

function main() {
  // 1. Copy source into the plugin dir (unless already running from there).
  if (resolve(SRC) !== resolve(PLUGIN_DIR)) {
    log(`copying to ${PLUGIN_DIR}`)
    rmSync(PLUGIN_DIR, { recursive: true, force: true })
    cpSync(SRC, PLUGIN_DIR, {
      recursive: true,
      filter: (src) => !EXCLUDED.has(basename(src)),
    })
  } else {
    log(`already installed at ${PLUGIN_DIR}`)
  }

  // 2. Install dependencies.
  log("installing dependencies (npm install)")
  try {
    execSync("npm install --omit=dev", { cwd: PLUGIN_DIR, stdio: "inherit" })
  } catch {
    fail("npm install failed — is npm available?")
  }

  // 3. Scaffold config.json from the example (never overwrite an existing one).
  const configPath = join(PLUGIN_DIR, "config.json")
  if (!existsSync(configPath)) {
    cpSync(join(PLUGIN_DIR, "config.example.json"), configPath)
    log(`created ${configPath}`)
    log("  >>> EDIT it and fill imap.user / imap.password / smtp.user / smtp.password / recipient")
  } else {
    log("config.json already exists — leaving it untouched")
  }

  // 4. Register the plugin in opencode.jsonc.
  const opencodeConfig = join(CONFIG_DIR, "opencode.jsonc")
  try {
    const added = addPluginToConfig(opencodeConfig, PLUGIN_DIR)
    log(added ? `registered plugin in ${opencodeConfig}` : "plugin already registered")
  } catch (err) {
    fail(`could not update ${opencodeConfig}: ${err?.message ?? err}`)
  }

  // 5. Copy the /afk and /back commands.
  try {
    mkdirSync(COMMAND_DIR, { recursive: true })
    for (const name of ["afk.md", "back.md"]) {
      const src = join(PLUGIN_DIR, "command", name)
      if (existsSync(src)) cpSync(src, join(COMMAND_DIR, name))
    }
    log(`commands copied to ${COMMAND_DIR}`)
  } catch {
    log(`(skipped command copy — copy command/afk.md and command/back.md to ${COMMAND_DIR} manually)`)
  }

  log("done. Reload opencode, then use /afk to leave and /back to return.")
}

main()

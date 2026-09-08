// afk daemon env-whitelist regression test (issue #8).
//
// The detached daemon must NOT inherit the full opencode env (which carries
// ANTHROPIC_API_KEY and every AFK_* credential). It gets only AFK_* config,
// the opencode config dir, and the minimal system vars.

import { test } from "node:test"
import assert from "node:assert/strict"

const { daemonEnv } = await import("../index.js")

test("daemonEnv keeps AFK_* + system vars and drops everything else (issue #8)", () => {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    USER: "user",
    OPENCODE_CONFIG_DIR: "/custom/config",
    AFK_DEBUG: "1",
    AFK_IMAP_PASSWORD: "imap-pass",
    AFK_SMTP_PASSWORD: "smtp-pass",
    ANTHROPIC_API_KEY: "sk-super-secret",
    OPENAI_API_KEY: "sk-other",
    SOME_UNRELATED_VAR: "leak-me",
  }

  const out = daemonEnv(env)

  assert.equal(out.PATH, "/usr/bin:/bin")
  assert.equal(out.HOME, "/home/user")
  assert.equal(out.OPENCODE_CONFIG_DIR, "/custom/config")
  assert.equal(out.AFK_DEBUG, "1")
  assert.equal(out.AFK_IMAP_PASSWORD, "imap-pass")
  assert.equal(out.AFK_SMTP_PASSWORD, "smtp-pass")

  assert.ok(!("ANTHROPIC_API_KEY" in out), "the daemon must NOT inherit the LLM API key")
  assert.ok(!("OPENAI_API_KEY" in out), "the daemon must NOT inherit other provider keys")
  assert.ok(!("SOME_UNRELATED_VAR" in out), "the daemon must NOT inherit unrelated vars")
})

test("daemonEnv drops undefined values", () => {
  const out = daemonEnv({ PATH: undefined, AFK_X: "1", HOME: "/h" })
  assert.ok(!("PATH" in out))
  assert.equal(out.AFK_X, "1")
  assert.equal(out.HOME, "/h")
})

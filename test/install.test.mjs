// afk installer security regression tests (issue #4).
//
// Runs the real install.js in a subprocess with a poisoned OPENCODE_PLUGIN_DIR
// and asserts it ABORTS (exit 1) instead of recursively deleting an arbitrary
// directory. Also covers the marker-file guard (refuses a non-afk directory).

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "install.js")

function runInstall(env) {
  try {
    execFileSync(process.execPath, [INSTALL], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: "pipe",
    })
    return { code: 0, output: "" }
  } catch (err) {
    return {
      code: err.status ?? 1,
      output: String(err.stderr || err.stdout || ""),
    }
  }
}

test("install.js aborts when OPENCODE_PLUGIN_DIR is outside the plugins dir (issue #4)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "afk-install-cfg-"))
  const outsideDir = mkdtempSync(join(tmpdir(), "afk-install-evil-"))
  // Plant a file so a delete would be provably destructive.
  writeFileSync(join(outsideDir, "victim.txt"), "do not delete me")

  const { code, output } = runInstall({
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_PLUGIN_DIR: outsideDir,
  })

  assert.equal(code, 1, "installer must exit non-zero")
  assert.match(output, /refusing to install/)
  assert.ok(existsSync(join(outsideDir, "victim.txt")), "the outside directory must be left untouched")
})

test("install.js refuses a non-afk directory (missing package.json marker)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "afk-install-cfg-"))
  const pluginsRoot = join(configDir, "plugins")
  const target = join(pluginsRoot, "something-else")
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, "README.txt"), "not an afk install")

  const { code, output } = runInstall({
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_PLUGIN_DIR: target,
  })

  assert.equal(code, 1)
  assert.match(output, /not an afk install/)
  assert.ok(existsSync(join(target, "README.txt")), "the non-afk directory must be left untouched")
})

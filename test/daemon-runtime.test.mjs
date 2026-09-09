// afk daemon runtime-resolution regression test (issue #10).
//
// When opencode ships as a compiled standalone binary, `process.execPath` is
// that binary and will NOT execute daemon.js — it exits immediately. The daemon
// must therefore be launched with a real JS runtime: AFK_NODE_BIN override →
// `node` on PATH → process.execPath fallback.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { resolveNodeBin } = await import("../index.js")

const EXE = process.platform === "win32" ? "node.exe" : "node"

test("AFK_NODE_BIN override wins over PATH and process.execPath (issue #10)", () => {
  assert.equal(resolveNodeBin({ AFK_NODE_BIN: "/custom/node", PATH: "" }), "/custom/node")
})

test("resolves `node` from PATH when AFK_NODE_BIN is unset (issue #10)", () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-node-"))
  const fakeNode = join(dir, EXE)
  writeFileSync(fakeNode, process.platform === "win32" ? "" : "#!/bin/sh\n")
  chmodSync(fakeNode, 0o755)
  assert.equal(resolveNodeBin({ PATH: dir }), fakeNode)
})

test("falls back to process.execPath when neither override nor a PATH node exists (issue #10)", () => {
  assert.equal(resolveNodeBin({ PATH: "" }), process.execPath)
})

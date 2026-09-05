#!/usr/bin/env node
// inject-test.mjs — standalone INJECTION unit test (spawns its own opencode serve).
//
// Proves the injection half of the afk hook against a REAL opencode
// server, using the CORRECT SDK call shape that delivery-poller.js / inject.js
// are missing:
//
//   client.session.prompt({ path: { id: sessionID }, body: { parts: [...] } })
//                       └─ 正确:sessionID 放 path,parts 放 body
//
// the plugin currently passes the WRONG shape:
//   client.session.prompt({ sessionID, parts })   // → URL /session/%7Bid%7D/message
//
// WHY spawn our own serve? A standalone process CANNOT inject into a TUI
// instance's session: opencode silently drops cross-process HTTP injection into
// TUI-attached sessions (that is why the plugin injects IN-PROCESS via its own
// input.client). e2e.mjs uses the same pattern — spawn `opencode serve --pure`,
// create a session, inject, and watch the agent wake with the message.
//
// Run:
//   node test/inject-test.mjs
//   node test/inject-test.mjs "自定义注入文本"

import { spawn } from "node:child_process"
import { createOpencodeClient } from "@opencode-ai/sdk"

const OPENCODE_BIN = "/home/lorenzo/.opencode/bin/opencode"
const MODEL = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
const TEXT =
  process.argv[2] ??
  "🧪 [afk inject-test] 如果你能看到这条消息，说明正确调用形状的 client.session.prompt() 注入成功。请回复确认。"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- [1] spawn a dedicated opencode serve (throwaway) -----------------------
console.log(`[1] spawning \`opencode serve --pure\` …`)
const child = spawn(OPENCODE_BIN, ["serve", "--pure", "--port", "0"], {
  cwd: "/tmp/opencode",
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env: process.env,
})
child.stdout.on("data", () => {})
child.stderr.on("data", () => {})

const baseUrl = await new Promise((resolve, reject) => {
  let buf = ""
  const timer = setTimeout(() => reject(new Error("timeout waiting for serve URL")), 30000)
  const onData = (chunk) => {
    buf += chunk.toString()
    const m = buf.match(/listening on (http:\/\/[\d.:]+)/)
    if (m) {
      clearTimeout(timer)
      resolve(m[1])
    }
  }
  child.stdout.on("data", onData)
  child.stderr.on("data", onData)
  child.on("exit", (code, signal) => {
    clearTimeout(timer)
    reject(new Error(`serve exited early code=${code} signal=${signal}`))
  })
})
console.log(`[1] serve listening: ${baseUrl}`)

const cleanup = async () => {
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

try {
  // --- [2] SDK client (throwOnError:true → 失败必抛,不会被静默吞掉) -------
  const client = createOpencodeClient({ baseUrl, throwOnError: true })

  for (let i = 1; i <= 20; i++) {
    try {
      await client.app.agents()
      break
    } catch (e) {
      if (i === 20) throw new Error(`server not ready: ${e.message}`)
      await sleep(1000)
    }
  }
  console.log(`[2] SDK client ready (throwOnError=true)`)

  // --- [3] create a throwaway session --------------------------------------
  const created = await client.session.create({ body: { title: "inject-test throwaway" } })
  const sessionID = created.data?.id
  if (!sessionID) throw new Error("session.create returned no id")
  console.log(`[3] session created id=${sessionID}`)

  // --- [4] establish the session (pin model) --------------------------------
  const first = await client.session.prompt({
    path: { id: sessionID },
    body: { model: MODEL, parts: [{ type: "text", text: "Reply with exactly READY" }] },
  })
  if (first.data?.info?.role !== "assistant") throw new Error("first prompt did not complete")
  console.log(`[4] session established (agent pinned to ${MODEL.modelID})`)

  // --- [5] 用【正确形状】注入 (修复后的 delivery-poller / inject 应长这样) ---
  console.log(`[5] injecting via client.session.prompt({ path:{id}, body:{parts} }) …`)
  const t0 = Date.now()
  const result = await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: TEXT }] },
  })
  const wake = result?.data
  if (!wake || wake.info?.role !== "assistant") {
    throw new Error(`inject prompt returned abnormal data: ${JSON.stringify(result)}`)
  }
  const reply = (wake.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
  console.log(`[5] ✅ prompt() 完成 (${Date.now() - t0}ms),agent 已唤醒并回复:`)
  console.log(`    ${reply || "(无文本回复)"}`)

  // --- [6] 复查会话消息,确认注入的消息真实落地 ------------------------------
  const msgsRes = await client.session.messages({ path: { id: sessionID } })
  const msgs = msgsRes?.data ?? []
  const lastUser = [...msgs]
    .reverse()
    .find((m) => m.info?.role === "user" && (m.parts ?? []).some((p) => p.type === "text"))
  const lastUserText = (lastUser?.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
  const landed = lastUserText.includes(TEXT.slice(0, 20))
  console.log(`[6] 会话最近一条 user 消息: ${lastUserText ? JSON.stringify(lastUserText.slice(0, 60)) + "…" : "(无)"}`)
  console.log(landed ? "    ✅ 注入消息已确认出现在会话中 — INJECTION OK" : "    ⚠️ 未找到注入文本")

  process.exitCode = landed ? 0 : 2
} catch (err) {
  console.error(`\n❌ INJECTION FAILED: ${err.message}`)
  process.exitCode = 1
} finally {
  await cleanup()
  console.log(`\n[done] serve 已清理`)
}

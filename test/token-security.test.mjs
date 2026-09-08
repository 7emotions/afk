// afk routing-token + sender-auth security tests (issues #1, #3).
//
// Pure-function coverage for the signed routing token (deterministic HMAC — no
// nonce, so supplementary replies are allowed) and the SPF/DKIM/DMARC sender-
// authentication check, plus an end-to-end processMail pass proving a forged or
// tampered reply is rejected with an audit trail.

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "afk-token-"))
process.env.AFK_JOURNAL = join(tmp, "journal.json")

const {
  signToken,
  parseSignedToken,
  verifySignedToken,
  authenticationFailed,
} = await import("../core/reply-parse.js")
const { processMail } = await import("../core/process.js")

after(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const SECRET = "token-test-secret"

// A mailparser-shaped reply with an injectable subject + auth results.
function reply({ subject, authenticationResults = [], from = "human@example.com" } = {}) {
  return {
    subject,
    from: { value: [{ address: from, name: "Human" }], text: `"Human" <${from}>` },
    inReplyTo: "<abc@example.com>",
    text: "do the thing",
    html: false,
    ...(authenticationResults.length ? { authenticationResults } : {}),
  }
}

function makeMocks(parsed) {
  const auditLines = []
  const imapClient = {
    fetchOne: async () => ({ seq: 1, uid: 1, source: Buffer.from("raw") }),
    messageFlagsAdd: async () => {},
  }
  const client = { session: { promptAsync: async () => {} } }
  const deps = {
    secret: SECRET,
    parse: async () => parsed,
    audit: (...args) => auditLines.push(args.join(" ")),
  }
  return { imapClient, client, deps, auditLines }
}

// ---------------------------------------------------------------------------
// Pure token functions
// ---------------------------------------------------------------------------

test("signToken is deterministic and produces a token that verifies (issue #3)", () => {
  const a = signToken("ses_x", SECRET)
  const b = signToken("ses_x", SECRET)
  assert.equal(a, b, "the token is deterministic per session (no nonce)")

  const parsed = parseSignedToken(`[omo:${a}] hi`)
  assert.deepEqual(parsed, { sessionID: "ses_x", sig: a.split(".")[1] })
  assert.ok(verifySignedToken(`Re: [omo:${a}] hi`, SECRET))
})

test("a tampered sessionID fails verification", () => {
  const token = signToken("ses_x", SECRET).replace("ses_x", "ses_y")
  assert.equal(verifySignedToken(`Re: [omo:${token}] hi`, SECRET), false)
})

test("a tampered signature fails verification", () => {
  const [sid] = signToken("ses_x", SECRET).split(".")
  const tampered = `${sid}.${"0".repeat(32)}`
  assert.equal(verifySignedToken(`Re: [omo:${tampered}] hi`, SECRET), false)
})

test("an unsigned (plaintext) token fails verification", () => {
  assert.equal(verifySignedToken("Re: [omo:ses_x] hi", SECRET), false)
})

test("a token signed with the wrong secret fails verification", () => {
  const token = signToken("ses_x", "other-secret")
  assert.equal(verifySignedToken(`Re: [omo:${token}] hi`, SECRET), false)
})

test("supplementary replies are accepted (no replay rejection — deterministic token)", async () => {
  const subject = `Re: [omo:${signToken("ses_x", SECRET)}] hi`
  const run = async (uid) => {
    const { imapClient, client, deps } = makeMocks(reply({ subject }))
    return processMail(imapClient, client, { folder: "INBOX" }, uid, deps)
  }
  const r1 = await run(1)
  const r2 = await run(2)
  assert.equal(r1.stored, true)
  assert.equal(r2.stored, true, "a second reply with the same token must be accepted")
})

// ---------------------------------------------------------------------------
// SPF/DKIM/DMARC (issue #1)
// ---------------------------------------------------------------------------

test("authenticationFailed detects dkim/spf/dmarc = fail (issue #1)", () => {
  assert.equal(authenticationFailed([{ value: "mx.example.com; dkim=pass; dmarc=fail (p=reject)" }]), true)
  assert.equal(authenticationFailed([{ value: "spf=fail smtp.mailfrom=evil.com" }]), true)
  assert.equal(authenticationFailed([{ value: "dkim=fail header.i=@evil.com" }]), true)
  assert.equal(authenticationFailed([{ value: "dkim=pass; spf=pass; dmarc=pass" }]), false)
  assert.equal(authenticationFailed(undefined), false)
  assert.equal(authenticationFailed([]), false)
})

// ---------------------------------------------------------------------------
// processMail integration: rejection + audit trail
// ---------------------------------------------------------------------------

test("processMail rejects a tampered token with an audit trail (issue #3)", async () => {
  const badSubject = `Re: [omo:ses_x.${"f".repeat(32)}] hi`
  const { imapClient, client, deps, auditLines } = makeMocks(reply({ subject: badSubject }))
  const res = await processMail(imapClient, client, { folder: "INBOX" }, 1, deps)
  assert.equal(res.ok, true)
  assert.equal(res.skipped, true)
  assert.equal(res.reason, "bad-token")
  assert.equal(auditLines.length, 1, "a rejected token must be audited")
  assert.match(auditLines[0], /invalid\/unsigned routing token/)
})

test("processMail rejects a forged From (dmarc=fail) with an audit trail even when in allowList (issue #1)", async () => {
  const subject = `Re: [omo:${signToken("ses_x", SECRET)}] hi`
  const parsed = reply({
    subject,
    authenticationResults: [{ value: "mx.example.com; dkim=pass; dmarc=fail (p=reject)" }],
  })
  const { imapClient, client, deps, auditLines } = makeMocks(parsed)
  const res = await processMail(imapClient, client, { folder: "INBOX", allowList: ["human@example.com"] }, 3, deps)
  assert.equal(res.ok, true)
  assert.equal(res.skipped, true)
  assert.equal(res.reason, "sender-auth-failed")
  assert.match(auditLines[0], /sender auth failed/)
})

test("processMail accepts a valid signed reply from an allowed sender", async () => {
  const subject = `Re: [omo:${signToken("ses_x", SECRET)}] hi`
  const { imapClient, client, deps } = makeMocks(reply({ subject }))
  const res = await processMail(imapClient, client, { folder: "INBOX", allowList: ["human@example.com"] }, 4, deps)
  assert.equal(res.ok, true)
  assert.equal(res.stored, true)
})

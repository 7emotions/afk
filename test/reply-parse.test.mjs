// afk T6 unit tests — reply detection + parsing (pure logic).
//
// Covers: token extraction, reply-prefix detection (ASCII + Chinese locale),
// self-sent-copy rejection, header-driven reply acceptance, multipart body
// selection, HTML tag-stripping, quoted-thread truncation, and empty-body
// fallback. No network, no IMAP/SMTP.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  extractToken,
  isReply,
  extractBody,
  parseReply,
} from "../core/reply-parse.js"

// ---------------------------------------------------------------------------
// extractToken
// ---------------------------------------------------------------------------

test("extractToken: returns session ID from [omo:ses_x]", () => {
  assert.equal(extractToken("Re: [omo:ses_x] hi"), "ses_x")
  assert.equal(extractToken("[omo:ses_Abc123XYZ] hi"), "ses_Abc123XYZ")
  assert.equal(extractToken("答复: [omo:ses_x] hi"), "ses_x")
})

test("extractToken: returns null when no token present", () => {
  assert.equal(extractToken("Re: hello"), null)
  assert.equal(extractToken(""), null)
  assert.equal(extractToken(null), null)
  assert.equal(extractToken(undefined), null)
})

// ---------------------------------------------------------------------------
// isReply
// ---------------------------------------------------------------------------

test("isReply: detects Re: / 回复: / 答复: / Fw: / 转发: prefixes", () => {
  assert.equal(isReply("Re: [omo:ses_x] hi", null), true)
  assert.equal(isReply("回复: [omo:ses_x] hi", null), true)
  assert.equal(isReply("答复: [omo:ses_x] hi", null), true)
  assert.equal(isReply("Fw: [omo:ses_x] hi", null), true)
  assert.equal(isReply("转发: [omo:ses_x] hi", null), true)
})

test("isReply: tolerates leading whitespace, bracket, fullwidth colon", () => {
  assert.equal(isReply("  re: [omo:ses_x] hi", null), true)
  assert.equal(isReply("回复：[omo:ses_x] hi", null), true)
  assert.equal(isReply("【回复：[omo:ses_x] hi", null), true)
})

test("isReply: true when inReplyTo non-empty even without prefix", () => {
  assert.equal(isReply("[omo:ses_x] hi", "<abc@example.com>"), true)
  assert.equal(isReply("[omo:ses_x] hi", " "), false)
})

test("isReply: false for own outbound copy (no prefix, no header)", () => {
  assert.equal(isReply("[omo:ses_x] hi", null), false)
  assert.equal(isReply("[omo:ses_x] hi", ""), false)
  assert.equal(isReply("[omo:ses_x] hi", undefined), false)
  assert.equal(isReply("hello world", null), false)
})

// ---------------------------------------------------------------------------
// extractBody
// ---------------------------------------------------------------------------

test("extractBody: prefers non-empty text part", () => {
  const body = extractBody("plain text body", "<p>html body</p>")
  assert.equal(body, "plain text body")
})

test("extractBody: strips tags from html-only body (no tags remain)", () => {
  const body = extractBody("", "<html><body><p>Hello <b>world</b></p></body></html>")
  assert.equal(body, "Hello world")
  assert.ok(!/<[^>]*>/.test(body), "body must contain no tags")
})

test("extractBody: decodes basic entities", () => {
  assert.equal(extractBody("", "<p>a &amp; b &lt;tag&gt; &quot;x&quot; &#39;y&#39;</p>"), 'a & b <tag> "x" \'y\'')
})

test("extractBody: truncates quoted thread at '> quoted' line", () => {
  const body = extractBody("my reply text\n> quoted original\nrest", null)
  assert.equal(body, "my reply text")
})

test("extractBody: truncates at 'On ... wrote:' and '在 ... 写道' markers", () => {
  assert.equal(
    extractBody("new text\nOn Tue, Sep 2 at 3:00 PM user@example.com wrote:\n> old", null),
    "new text"
  )
  assert.equal(
    extractBody("new text\n在 2026年9月2日 12:00，某人 写道：\n> old", null),
    "new text"
  )
})

test("extractBody: truncates at '-----Original Message-----' and '发自我的'", () => {
  assert.equal(extractBody("new\n-----Original Message-----\nFrom: x", null), "new")
  assert.equal(extractBody("new\n发自我的 iPhone", null), "new")
})

test("extractBody: collapses whitespace", () => {
  assert.equal(extractBody("  hello \n\t world  ", null), "hello world")
})

test("extractBody: returns (无正文) for empty body", () => {
  assert.equal(extractBody("", ""), "(无正文)")
  assert.equal(extractBody(null, null), "(无正文)")
  assert.equal(extractBody("   ", "<p>   </p>"), "(无正文)")
})

test("extractBody: truncates to 4000 chars", () => {
  const long = "a".repeat(5000)
  const body = extractBody(long, null)
  assert.equal(body.length, 4000)
})

// ---------------------------------------------------------------------------
// parseReply
// ---------------------------------------------------------------------------

test("parseReply: Re: [omo:ses_x] hi accepted with sessionID + body", () => {
  const r = parseReply({ subject: "Re: [omo:ses_x] hi", from: "a@b.c", text: "go ahead", html: null })
  assert.deepEqual(r, { sessionID: "ses_x", body: "go ahead", from: "a@b.c" })
})

test("parseReply: 回复: prefix accepted (locale)", () => {
  const r = parseReply({ subject: "回复: [omo:ses_x] hi", text: "ok", html: "" })
  assert.equal(r.sessionID, "ses_x")
})

test("parseReply: 答复: prefix accepted", () => {
  const r = parseReply({ subject: "答复: [omo:ses_x] hi", text: "ok", html: "" })
  assert.equal(r.sessionID, "ses_x")
})

test("parseReply: own outbound copy rejected (no prefix, no header)", () => {
  const r = parseReply({ subject: "[omo:ses_x] hi", from: "me@x.c", inReplyTo: null, text: "hi", html: "" })
  assert.equal(r, null)
})

test("parseReply: subject with no token rejected", () => {
  const r = parseReply({ subject: "Re: hello", from: "a@b.c", inReplyTo: "<x@y>", text: "hi", html: "" })
  assert.equal(r, null)
})

test("parseReply: header-driven reply accepted without Re: prefix", () => {
  const r = parseReply({ subject: "[omo:ses_x] hi", from: "a@b.c", inReplyTo: "<x@y>", text: "hi", html: "" })
  assert.deepEqual(r, { sessionID: "ses_x", body: "hi", from: "a@b.c" })
})

test("parseReply: html-only body is tag-stripped", () => {
  const r = parseReply({ subject: "Re: [omo:ses_x] hi", text: "", html: "<p>do <b>it</b></p>" })
  assert.equal(r.body, "do it")
})

test("parseReply: empty body falls back to (无正文)", () => {
  const r = parseReply({ subject: "Re: [omo:ses_x] hi", text: "", html: "" })
  assert.equal(r.body, "(无正文)")
})

<div align="center">

# email-wake

**Ask your agent a decision question by email — and wake it up when you reply, from anywhere.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

An [OpenCode](https://opencode.ai) plugin that lets a running agent ask the human a
**decision question by email** and **auto-resume the session** when the human replies —
without the human touching the terminal.

**English** · [**简体中文**](README.md)

</div>

```mermaid
flowchart TB
    A[agent hits a decision point] --> B["request_decision()<br/>emails the question"]
    B --> C[you reply from anywhere]
    C --> D["daemon detects it<br/>(IMAP IDLE, no polling)"]
    D --> E["reply injected<br/>(data, not instruction)"]
    E --> F[agent wakes and continues]
```

## Features

- **Email decisions** — the agent asks, you answer from anywhere, no terminal needed
- **`/afk` mode gate** — email only fires after you've left the screen (`/back` returns)
- **Zero polling** — IMAP IDLE push + one-time catch-up scan, never a timed poller
- **Push delivery** — SSE broadcast + per-instance ownership self-check (multi-instance safe)
- **No message loss** — durable pending-store + ack-after-inject (crash-safe)
- **i18n** — English defaults, `config.messages` override for any language
- **Data-not-instruction** — prompt-injection guard on every injected reply
- **One-shot installer** — `node install.js` copies, installs, registers, and scaffolds

See [`AGENTS.md`](AGENTS.md) for the agent-facing instruction (the `request_decision`
contract and the "pause after asking" rule).

---

## Installation

### Copy-paste install — give this to your LLM

Paste this into any coding agent (OpenCode, Claude Code, …):

```text
Install and configure email-wake by following the instructions here:
https://raw.githubusercontent.com/7emotions/email-wake/main/INSTALLATION.md
```

### One-shot installer (manual)

```bash
git clone https://github.com/7emotions/email-wake
cd email-wake
node install.js
# then edit ~/.config/opencode/plugins/email-wake/config.json and fill credentials
```

The installer:
1. copies the source into `~/.config/opencode/plugins/email-wake/` (skipping
   `node_modules`, `.git`, and any secret/runtime files);
2. runs `npm install --omit=dev`;
3. creates `config.json` from `config.example.json` (never overwrites an
   existing one);
4. registers the plugin in `~/.config/opencode/opencode.jsonc` (comment-
   preserving text insertion — it never `JSON.parse`s a JSONC file);
5. copies `command/afk.md` + `command/back.md` into
   `~/.config/opencode/command/`.

Then edit `config.json` (gitignored) and fill `imap.user` / `imap.password` /
`smtp.user` / `smtp.password` / `recipient`. Reload opencode.

### Manual steps

Equivalent steps, no installer:

1. Copy this directory into `~/.config/opencode/plugins/email-wake/`.
2. `cd` into it and run `npm install`.
3. Create `config.json` from `config.example.json` and fill credentials.
4. Add the plugin path to the `plugin` array in `~/.config/opencode/opencode.jsonc`.
5. Copy `command/afk.md` + `command/back.md` into `~/.config/opencode/command/`.
6. Reload opencode.

The plugin depends on `@opencode-ai/plugin`, `@opencode-ai/sdk`, `imapflow`,
`mailparser`, and `nodemailer`.

---

## Quick start

1. Install the plugin and write a `config.json` (copy `config.example.json`).
   At minimum you need valid IMAP + SMTP credentials (a QQ auth code works as
   the password) and a `recipient`.
2. Reload opencode. The plugin ensures its daemon is running and loads.
3. In a session, the agent can call
   `request_decision(subject, question, { context, options, recommendation })`.
   The tool emails the question and returns
   `Decision requested — pause and end this turn; wait for the reply to be injected`.
4. Reply to the email. The daemon detects the reply, the owning instance injects
   it, and the session continues.

```sh
# run the unit test suite (no network, no real mailbox)
node --test test/*.test.mjs
```

---

## Email mode (`/afk` and `/back`)

By default, `request_decision` **refuses to email** the human. Email is only
allowed when the human has explicitly left the screen — a single **GLOBAL** mode
flag (`"on"`/`"off"`) stored durably in `mode.json` (gitignored) by the daemon.
It is global by design: the human is either at the screen or not, regardless of
how many sessions/instances are running.

| Mode | Meaning | `request_decision` behavior |
|------|---------|-----------------------------|
| `"off"` (default) | Human is at the screen | Refuses: returns the mode-off message (tells the agent to use the built-in `question` tool). No email, no register. |
| `"on"` | Human has left (`/afk`) | Emails the human as normal. |

The human flips the mode with two commands:

- `/afk` — calls `set_email_mode(mode: "on")` (email mode ON).
- `/back` — calls `set_email_mode(mode: "off")` (email mode OFF).

When mode is off and the agent needs a decision, it must ask in the conversation
via opencode's built-in **`question` tool** instead of emailing.

**Todo checkpoint.** When `request_decision` will EMAIL (mode on), the agent must
first checkpoint its todo list (write it into the message body, then clear the
todos) so a pending human reply does not get overridden by todo-continuation.
When the reply is injected, the agent rebuilds the todos from the checkpoint.

### Registering the commands

OpenCode loads custom commands from markdown files in the global command
directory, `~/.config/opencode/command(s)/<name>.md` (the file name is the
command name). Two such files ship this behavior:

- `~/.config/opencode/command/afk.md` — turns email mode ON.
- `~/.config/opencode/command/back.md` — turns email mode OFF.

(Equivalent `opencode.jsonc` form, if you prefer config over markdown files:)

```jsonc
{
  "command": {
    "afk": { "template": "Call the set_email_mode tool with mode \"on\", then confirm briefly.", "description": "Turn email mode ON" },
    "back": { "template": "Call the set_email_mode tool with mode \"off\", then confirm briefly.", "description": "Turn email mode OFF" }
  }
}
```

The mode state lives on the daemon (`mode.json`), is served over `GET /mode` /
`POST /mode`, and is pushed to every connected instance as an SSE `mode` event
(including an initial `mode` event on connect), so a change made in one session
is seen by all instances immediately.

---
## Configuration

Both the plugin (`index.js`) and the daemon (`daemon.js`) read `config.json` in
the plugin directory. See `config.example.json` for a complete, commented-by-
shape example (it contains no real secrets).

### `config.json` fields

| Field | Meaning |
|-------|---------|
| `imap.host` / `imap.port` / `imap.secure` | IMAP server for reading replies (default `imap.qq.com:993`, `secure:true`) |
| `imap.user` / `imap.password` | IMAP credentials (QQ auth code as password) |
| `smtp.host` / `smtp.port` / `smtp.secure` | SMTP server for sending decision emails (default `smtp.qq.com:465`) |
| `smtp.user` / `smtp.password` | SMTP credentials |
| `recipient` | Where decision emails are sent; defaults to `smtp.user` |
| `allowList` | Sender addresses whose replies may be injected — the prompt-injection guard. Default `[smtp.user]` (only your own mailbox) |
| `folder` | Mailbox folder to watch (default `INBOX`) |
| `tuning` | Optional behavior/timing overrides (see below) |
| `messages` | Optional localization of user/agent-facing strings (see below) |

### Security

- **Sender allow list** — `request_decision` emails the question to `recipient`;
  only replies **from** addresses in `allowList` (default: your own `smtp.user`)
  are ever injected into a session. A stranger who copies the
  `[omo:<sessionID>]` subject token still cannot push content in — their reply
  is ignored unless their address is allow-listed. Add extra addresses
  (e.g. a second personal mailbox) by listing them:
  `"allowList": ["me@qq.com", "me@outlook.com"]`.
- **Data-not-instruction** — every injected reply is framed as *data*, never an
  instruction to execute (prompt-injection guard).

### `tuning` (optional — current values are the defaults)

Every field is optional and defaults to the value shown; omit the whole block to
keep the current behavior unchanged.

| Field | Default | Source constant it replaced |
|-------|---------|------------------------------|
| `tuning.claimTtlMs` | `60000` | `pending-store.js` `CLAIM_TTL_MS` — how long a claim stays authoritative before another instance may steal it |
| `tuning.reconnectBaseMs` | `1000` | `subscribe.js` `DEFAULT_RECONNECT_BASE_MS` — SSE reconnect backoff start |
| `tuning.reconnectMaxMs` | `30000` | `subscribe.js` `DEFAULT_RECONNECT_MAX_MS` — SSE reconnect backoff ceiling |
| `tuning.idleRenewMs` | `1500000` | `watcher.js` `IDLE_RENEW_MS` (25 min) — how often IDLE is re-issued before the server drops it |
| `tuning.autoIdleDelayMs` | `1000` | `watcher.js` `AUTO_IDLE_DELAY_MS` — quiet period before imapflow auto-starts IDLE |
| `tuning.backoffInitialMs` | `1000` | `watcher.js` `BACKOFF_INITIAL_MS` — IMAP reconnect backoff start |
| `tuning.backoffMaxMs` | `60000` | `watcher.js` `BACKOFF_MAX_MS` — IMAP reconnect backoff ceiling |

These values are injected into the consumers (`daemon.js`, `index.js`) from
`config.tuning` — the modules themselves never read the config file.

### `messages` (optional — default English)

Every user/agent-facing string is localized through a `messages.js` table.
Defaults are English; override any key under `config.messages` to localize (a
deep merge — unmentioned keys keep the English default):

```json
{
  "messages": {
    "decisionBody": {
      "context": "Context:",
      "question": "Decision:",
      "options": "Options:",
      "recommendation": "Recommendation:",
      "replyInstruction": "Reply to this email with your answer"
    },
    "tool": {
      "requested": "Decision requested — pause and end this turn; wait for the reply to be injected",
      "alreadyPending": "A decision is already pending — wait for the reply",
      "mainSessionOnly": "Call from the main session only",
      "modeOff": "Email mode is off — the human is at the screen. Use the question tool to ask in the conversation instead.",
      "modeOn": "Email mode is ON — the human has left the screen; request_decision will email them.",
      "modeDisabled": "Email mode is OFF — request_decision will use the question tool instead."
    }
  }
}
```

Note: the DATA-NOT-INSTRUCTION framing in `inject.js` (`buildPayload`) is a
security framing, not a display string, and is intentionally **not** part of
this table — its default behavior is unchanged.

### Environment variables

Every connection field is overridable via env vars (they take precedence over
`config.json`):

| Variable | Meaning |
|----------|---------|
| `EMAIL_WAKE_CONFIG` | Config file path (default `<plugin>/config.json`) |
| `EMAIL_WAKE_IMAP_HOST` / `EMAIL_WAKE_IMAP_PORT` / `EMAIL_WAKE_IMAP_USER` / `EMAIL_WAKE_IMAP_PASSWORD` | IMAP override |
| `EMAIL_WAKE_SMTP_HOST` / `EMAIL_WAKE_SMTP_PORT` / `EMAIL_WAKE_SMTP_USER` / `EMAIL_WAKE_SMTP_PASSWORD` | SMTP override |
| `EMAIL_WAKE_RECIPIENT` | Recipient override |
| `EMAIL_WAKE_JOURNAL` | Journal file path (processed-UID dedupe) |
| `EMAIL_WAKE_LAST_UID` | UID-cursor file path (detection state) |
| `EMAIL_WAKE_PENDING` | Pending-store file path (durable deliveries) |
| `EMAIL_WAKE_MODE` | Mode-store file path (GLOBAL email mode, `mode.json`) |
| `EMAIL_WAKE_DAEMON_URL` | Daemon base URL (default `http://127.0.0.1:4100`) |
| `EMAIL_WAKE_DAEMON_HOST` / `EMAIL_WAKE_DAEMON_PORT` | Daemon bind host/port (default `127.0.0.1` / `4100`) |
| `EMAIL_WAKE_DEBUG` | `1`/`true` to enable debug logging |

Passwords are never logged (masked as `***` when the config is serialized).

---

## How it works — single-watcher daemon + PUSH delivery

One machine runs **one daemon** (`daemon.js`) that owns the single IMAP IDLE
watcher for the shared mailbox. Every opencode instance loads only the **thin
client plugin** (`index.js`), which ensures the daemon is running and opens a
single **SSE stream** to it. The daemon parses replies, persists them durably,
and **pushes** them over SSE; each instance self-checks ownership, claims, and
injects IN-PROCESS.

```mermaid
flowchart TB
    subgraph instances["opencode instances — thin client plugins"]
        A["instance A<br/>ensure daemon · SSE subscriber · request_decision"]
        B["instance B<br/>ensure daemon · SSE subscriber · request_decision"]
        dots["... N instances"]
    end

    subgraph daemon_box["email-wake DAEMON — one process (atomic single-instance)"]
        D["HTTP endpoints<br/>/health · /events · /claim · /ack · /pending · /register · /mode"]
        W["the only IMAP IDLE watcher<br/>+ catch-up scan"]
        P["pending-store<br/>durable replies (pending.json)"]
        M["mode-store<br/>durable global mode (mode.json)"]
    end

    A --> D
    B --> D
    D --> W
    D --> P
    D --> M
    D -. SSE push .-> A
    D -. SSE push .-> B
```

The daemon binds a fixed port (default `4100`, override `EMAIL_WAKE_DAEMON_PORT`).
Binding is the atomic single-instance lock: if two instances spawn a daemon
simultaneously, only one wins the `bind`; the loser exits quietly
(`EADDRINUSE`). A plugin that probes `/health` and gets no answer spawns a
detached daemon and polls until healthy.

### Full flow

```mermaid
sequenceDiagram
    participant Agent
    participant Plugin
    participant Daemon
    participant Human

    Agent->>Plugin: request_decision(subject, question)
    Plugin->>Daemon: GET /mode
    alt mode is "off"
        Plugin-->>Agent: refuse → "use the question tool"
    else mode is "on"
        Plugin->>Daemon: POST /register {rootSessionID}
        Plugin->>Human: SMTP "[omo:rootSessionID] subject"
        Note over Agent: STOPS and ends its turn (pauses)
        Human->>Daemon: reply email (reply prefix / In-Reply-To)
        Daemon->>Daemon: IMAP IDLE push → scan UID > cursor → parse → persist pending.json
        Note over Daemon: mail stays UNSEEN, no journal yet
        Daemon-->>Plugin: SSE delivery {uid, sessionID, body, from}
        Plugin->>Plugin: self-check ownership → POST /claim
        Plugin->>Agent: inject reply (data, not instruction)
        Plugin->>Daemon: POST /ack
        Daemon->>Daemon: markSeen + journal → remove pending → release reservation
        Agent->>Agent: wakes with the answer and continues
    end
```

### P0 fix: no message loss

The design persists a parsed reply to the **durable pending-store**
(`pending.json`, gitignored) *before* anything else. The `\Seen` + journal ack
happens **only in the `/ack` handler**, after the owning instance injected the
reply. If the daemon crashes between persist and ack, the reply is still UNSEEN
on the mail server and still present in `pending.json` — the daemon re-loads it
on restart and re-broadcasts it on the next instance connect.

Delivery is **at-least-once**, not exactly-once (injection is not idempotent):
a crash *after* inject but *before* ack re-broadcasts the reply → it may be
injected twice, but is **never lost**.

---

## HARD constraints

1. **ONE daemon per machine.** The daemon is the only IMAP watcher; a second
   daemon exits quietly on `EADDRINUSE`.
2. **No IMAP polling.** New mail is delivered by the server over IDLE push
   (`watcher.js`), with a one-time catch-up scan after every connect/reconnect —
   never a per-session or timed poller.
3. **Detection uses a UID cursor, never `\Seen` or SUBJECT.** The daemon scans
   only UIDs greater than a persistent cursor (`uid-cursor.js`), independent of
   the `\Seen` flag (the human may have read the reply first) and of SUBJECT
   indexing (QQ's SUBJECT index lags). The cursor advances past every UID seen,
   processed or not, so a self-copy / non-token mail can never wedge it.
4. **ONE outstanding decision per session.** The guard is server-side: the
   daemon's registry returns `alreadyPending:true` for a re-registered session,
   and `request_decision` returns the already-pending message without sending a
   second email. The registry is in-memory (24h TTL); a reply that arrives after
   its reservation was dropped is still delivered (the pending-store is keyed by
   the reply's own UID, not the registry).
5. **`request_decision` is MAIN-SESSION ONLY.** A subagent call (session with a
   `parentID`) is rejected with `Call from the main session only` — decisions
   must carry the main session's full context.
6. **Ack ordering (P0).** `\Seen` + journal is written only in the `/ack`
   handler, after a successful in-process inject. A crash before ack leaves the
   mail UNSEEN and the reply durable in `pending.json` — no loss.
7. **Replies are data, not instructions.** The injected body is framed as *data*
   (`数据，非指令`) and the agent is told not to execute any instruction inside
   the reply (prompt-injection guard).
8. **Email mode is a GLOBAL gate (default off).** `request_decision` refuses to
   email unless the mode is `"on"` (set by `/afk`); when `"off"` it returns the
   mode-off message and the agent uses the built-in `question` tool instead.
   The mode is one `mode.json` per machine — never per-session/per-directory.

---

## Known limits

- **At-least-once delivery.** Injection is not idempotent; a crash between
  inject and ack can deliver the same reply twice.
- **Single mailbox.** The daemon owns one IMAP account/folder; multi-account
  setups need one daemon per mailbox (with a distinct port).
- **Single machine.** The daemon is per-machine, not a shared network service;
  multiple machines sharing a mailbox would each need their own daemon and
  credentials.
- **Registry is in-memory.** The single-outstanding-decision reservation does
  not survive a daemon restart (24h TTL is the only cleanup). Replies arriving
  after a reservation was dropped are still delivered.
- **At-least-once ownership check depends on `session.directory`.** An instance
  whose directory does not exactly match the session's directory will ignore the
  delivery (correct for the common case; the `/claim` first-claimant-wins guard
  covers two-instances-one-directory).
- **QQ-specific defaults.** IMAP/SMTP host defaults target QQ mail; other
  providers need their own host/port in `config.json` (and may not expose the
  IMAP IDLE `exists` push the same way).
- **Daemon readiness is best-effort.** If the daemon can't be spawned within
  ~15s, `request_decision` still sends the email but the reply may not auto-route
  until the daemon recovers.

---

## Layout

| File | Role |
|------|------|
| `index.js` | Plugin entry — thin client: ensure daemon, start the SSE subscriber, expose `request_decision` + `set_email_mode` |
| `daemon.js` | The single-watcher daemon (bind, HTTP: SSE/claim/ack/pending/register/mode, watcher, signals) |
| `request-decision.js` | The `request_decision` tool (mode gate → register → SMTP send → release) |
| `config.js` | Config load + validation + env overrides + `tuning` defaults + password redaction |
| `messages.js` | User/agent-facing strings (default English, `config.messages` override) |
| `install.js` | One-shot installer (copy, `npm install`, scaffold config, register, copy commands) |
| `core/watcher.js` | Single IMAP IDLE connection, auto-reconnect, catch-up hook |
| `core/process.js` | Scan → fetch → parse → persist pipeline (no ack) |
| `core/reply-parse.js` | Pure reply detection + token/body extraction |
| `core/inject.js` | Reply injection (DATA-NOT-INSTRUCTION) + `\Seen`/journal ack |
| `core/subscribe.js` | In-process SSE subscriber: ownership self-check → claim → inject → ack + reconnect catch-up |
| `store/pending-store.js` | Durable pending deliveries on disk (P0 fix — claim/ack atomicity + TTL) |
| `store/mode-store.js` | Durable GLOBAL email mode on disk (`mode.json`, default `"off"`) |
| `store/registry.js` | In-memory single-outstanding-decision guard (no routing) |
| `store/uid-cursor.js` | Persistent "highest processed UID" cursor (detection state) |
| `command/` | `/afk` + `/back` command templates (copied to `~/.config/opencode/command/`) |
| `test/` | `node:test` unit suites + live integration scripts |

## License

MIT — see [`LICENSE`](LICENSE).

## Testing

```sh
# unit tests (no network): pending-store, mode-store, registry, inject-ack,
# process-mail, negative, uid-cursor, daemon HTTP (register + push + mode
# endpoints + SSE), subscribe, request-decision (incl. the mode gate),
# reply-parse, unit, messages, config
node --test test/*.test.mjs
```

Live integration scripts (hit the real QQ mailbox; run individually; some still
reference the pre-push contract and are not part of the automated suite):
`test/daemon-live.mjs`, `test/catch-up.live.mjs`, `test/idle-connect.live.mjs`,
`test/uidcursor.live.mjs`, `test/e2e.mjs`, `test/receive-parse-test.mjs`,
`test/inject-test.mjs`.

# email-wake — Installation

Steps to install and configure the email-wake OpenCode plugin. Each step is
self-contained; run them in order.

## 1. Download and extract

Download the latest release and extract it into the OpenCode plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins
curl -L https://github.com/7emotions/afk/archive/refs/tags/v0.1.0.tar.gz \
  | tar xz -C ~/.config/opencode/plugins/
mv ~/.config/opencode/plugins/afk-0.1.0 ~/.config/opencode/plugins/email-wake
```

Verify `index.js` sits directly inside the plugin directory:

```bash
ls ~/.config/opencode/plugins/email-wake/index.js
```

## 2. Install dependencies

```bash
cd ~/.config/opencode/plugins/email-wake
npm install --omit=dev
```

Dependencies: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `imapflow`,
`mailparser`, `nodemailer`.

## 3. Register the plugin and scaffold config

```bash
node install.js
```

This registers the plugin in `~/.config/opencode/opencode.jsonc` (comment-
preserving text insertion), creates `config.json` from `config.example.json`
(never overwriting an existing one), and copies the `/afk` + `/back` commands
into `~/.config/opencode/command/`.

## 4. Configure credentials

Edit `~/.config/opencode/plugins/email-wake/config.json` and fill in:

| Field | Meaning |
|-------|---------|
| `imap.host` / `imap.port` / `imap.secure` | IMAP server for reading replies (default `imap.qq.com:993`, `secure:true`) |
| `imap.user` / `imap.password` | IMAP credentials (for QQ, use the SMTP/IMAP authorization code as the password) |
| `smtp.host` / `smtp.port` / `smtp.secure` | SMTP server for sending decision emails (default `smtp.qq.com:465`) |
| `smtp.user` / `smtp.password` | SMTP credentials |
| `recipient` | Where decision emails are sent (defaults to `smtp.user`) |
| `allowList` | Sender addresses whose replies may be injected — the prompt-injection guard. Default `[smtp.user]` (only your own mailbox) |
| `folder` | Mailbox folder to watch (default `INBOX`) |

`config.json` is gitignored — never commit real credentials.

**Security note:** only replies FROM addresses in `allowList` are ever injected
into a session. The default is your own mailbox; add any extra personal
addresses you may reply from (e.g. `"allowList": ["me@qq.com", "me@outlook.com"]`).

## 5. Reload and use

Reload OpenCode, then:

- `/afk` — leave the screen (turn email mode ON)
- `/back` — return (turn email mode OFF)

When email mode is ON and the agent needs a decision, it emails you; reply to
that email from anywhere and the agent resumes.

## Verification

Run the unit test suite (no network, no real mailbox):

```bash
node --test test/*.test.mjs
```

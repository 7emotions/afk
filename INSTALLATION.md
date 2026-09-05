# afk — Installation

Steps to install and configure the **afk** OpenCode plugin (npm package
`opencode-afk`). Each step is self-contained; run them in order.

## Option A — npm (recommended)

1. Add `"opencode-afk@latest"` to the `plugin` array in
   `~/.config/opencode/opencode.jsonc`:

   ```jsonc
   {
     "plugin": ["opencode-afk@latest"]
   }
   ```

2. Restart opencode — it auto-installs the package from npm into its plugin
   directory. On Linux that is `~/.config/opencode/node_modules/opencode-afk/`
   (the exact path varies by platform/version). Verify:

   ```bash
   ls ~/.config/opencode/node_modules/opencode-afk/index.js
   ```

3. Scaffold the **stable user-level config** (opencode does not create it for
   you). The config lives in the opencode config directory — not inside the
   plugin directory — so it survives every `@latest` update that reinstalls the
   plugin (same pattern as `oh-my-openagent.jsonc`):

   ```bash
   mkdir -p ~/.config/opencode
   cp ~/.config/opencode/node_modules/opencode-afk/config.example.json \
      ~/.config/opencode/afk.json
   ```

4. Edit `~/.config/opencode/afk.json` and fill in the credentials (see the
   table below).

5. Restart opencode, then use `/afk` to leave and `/back` to return.

**Updates:** when a new version is published, just restart opencode — the
`@latest` specifier is re-resolved and the plugin is updated automatically.
`~/.config/opencode/afk.json` is never touched.

## Option B — source / tarball (for development)

Download the latest source and install it manually:

```bash
mkdir -p ~/.config/opencode/plugins
curl -L https://github.com/7emotions/afk/archive/refs/tags/v0.1.0.tar.gz \
  | tar xz -C ~/.config/opencode/plugins/
mv ~/.config/opencode/plugins/afk-0.1.0 ~/.config/opencode/plugins/afk
cd ~/.config/opencode/plugins/afk
npm install --omit=dev
node install.js   # registers the plugin in opencode.jsonc + scaffolds config.json
```

Verify `index.js` sits directly inside the plugin directory:

```bash
ls ~/.config/opencode/plugins/afk/index.js
```

> **Warning:** `node install.js` wipes the destination directory before copying
> (`rmSync`), including any existing `config.json`. Back it up before re-running
> it on an existing install. For day-to-day use prefer Option A (npm).

## Configure credentials

The plugin resolves its config file by priority: `AFK_CONFIG` env var →
`~/.config/opencode/afk.json` (stable user-level; Option A) → the plugin
directory's `config.json` (legacy fallback; Option B). Edit the one that
applies to your install and fill in:

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

## Reload and use

Reload OpenCode, then:

- `/afk` — leave the screen (turn email mode ON)
- `/back` — return (turn email mode OFF)

When email mode is ON and the agent needs a decision, it emails you (`request_decision`);
reply to that email from anywhere and the agent resumes. The agent may also email
you one-way conclusions via `notify_user` without pausing its work.

## Verification

Run the unit test suite (no network, no real mailbox):

```bash
npm test
```

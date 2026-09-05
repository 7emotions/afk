# afk — agent-facing instruction

This plugin adds two email tools plus the email-mode switch:

- **`request_decision`** — when you need a human decision. Call
  `request_decision(subject, question, { context, options, recommendation })`.
  If it returns the email-mode-off message, the human is at the screen — use the
  built-in `question` tool to ask in the conversation instead. Otherwise it
  emails the human and returns a pause instruction: stop and end the turn, then
  wait for the reply to be injected.
- **`notify_user`** — when you reach a **key conclusion** the away human would
  want to know about (task finished, significant finding, milestone hit). Call
  `notify_user(subject, message)`. If it returns the email-mode-off message,
  state the conclusion in the conversation instead. Otherwise it emails a
  one-way FYI and returns a confirmation — it does **not** pause your turn and
  does **not** occupy the single-outstanding-decision slot, so keep working. The
  email carries the routing token, so if the human replies, that reply is
  injected into this session as feedback you may incorporate. Use it sparingly:
  it is for conclusions, not progress chatter.

Both tools email only while email mode is on (`/afk`); both are main-session
only — a subagent's conclusion is relayed by the main session.

## Before emailing a decision (mode on) — todo checkpoint

Emailing **a decision** (`request_decision`) pauses the session with a pending
human reply; an incomplete todo list would make todo-continuation keep pushing
you. (`notify_user` does not pause, so no checkpoint is needed for it.) BEFORE
calling `request_decision` when it will EMAIL:

1. Write your full todo list into the message body (every item + its status).
2. Clear the todos (`todowrite` all to `cancelled`).
3. Then call `request_decision`.

When the reply is injected, rebuild the todo list from the message-body
checkpoint and continue the original task.

For the full contract (pause-after-asking rule, main-session-only, data-not-
instruction framing, `/afk` + `/back` mode commands), see the plugin's
[`README.md`](README.md).

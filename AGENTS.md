# afk — agent-facing instruction

This plugin adds a `request_decision` tool. When you need a human decision, call
`request_decision(subject, question, { context, options, recommendation })`. If
it returns the email-mode-off message, the human is at the screen — use the
built-in `question` tool to ask in the conversation instead. Otherwise it emails
the human and returns a pause instruction: stop and end the turn, then wait for
the reply to be injected.

## Before emailing a decision (mode on) — todo checkpoint

Emailing pauses the session with a pending human reply; an incomplete todo list
would make todo-continuation keep pushing you. So, BEFORE calling
`request_decision` when it will EMAIL:

1. Write your full todo list into the message body (every item + its status).
2. Clear the todos (`todowrite` all to `cancelled`).
3. Then call `request_decision`.

When the reply is injected, rebuild the todo list from the message-body
checkpoint and continue the original task.

For the full contract (pause-after-asking rule, main-session-only, data-not-
instruction framing, `/afk` + `/back` mode commands), see the plugin's
[`README.md`](README.md).

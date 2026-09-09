---
name: sms
description: Send an SMS to a phone number. Use when the user asks the assistant to text someone, or asks it to text them.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "SMS"
---

Sends a text message through the assistant's Twilio line.

## When to send

On an explicit request to text someone:

- "Text Dana that I'm running late."
- "Send me a text with the summary."

Do **not** send proactively. A message to a phone is interruptive and cannot be
recalled, and unsolicited outbound is also what gets a line flagged for spam —
carriers and Twilio's own messaging policies cap unrequested outreach for
exactly that reason. If a message seems useful but was not asked for, say so
and let the user decide.

## Prerequisites

The line's credentials must be in the credential store. If a send fails with a
missing-credential or 401 error, load the **sms-setup** skill to walk the user
through getting them.

## How to send

```bash
bun skills/sms/scripts/send.ts --to "+15551234567" --body "your message"
```

`--to` should be E.164 (`+15551234567`). A bare 10-digit US number or an
11-digit number starting with 1 is accepted and normalized; anything else is
rejected rather than guessed at, so if you only have a partial number, ask
rather than assuming a country code.

## Writing the message

The script flattens markdown before sending, because message bubbles render
none of it. Write plain prose. Tables, headings, and code fences all survive as
flattened text, but they read badly on a phone — if the answer needs structure
that badly, it is a better answer somewhere else.

Long replies are split into multiple messages rather than truncated. The script
reports how many were sent. Keep messages short anyway: four bubbles arriving
at once reads as noise, so summarize rather than sending everything you know.

## Reading the result

- Success on one message: `Sent to +1555... (SM...)`.
- Success on a long reply: `Sent to +1555... as N messages`. Mention this if it
  matters to the user.
- Failure: non-zero exit with the reason on stderr. Report it — do not retry
  blindly. A failure usually means a bad number, an unprovisioned line, or a
  credential problem that retrying will not fix.
- Partial failure on a long reply: the error says how many of N messages were
  delivered. Tell the user, because they got part of the answer.

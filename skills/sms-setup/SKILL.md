---
name: sms-setup
description: Set up the SMS channel with the user's own Twilio account and number so the assistant can send and receive texts. After the credentials are stored, save and verify the user's SMS handle on their guardian contact if it is missing. Use when the user wants to text the assistant, when a send fails with a missing credential or 401, or when the channel reports it is idle.
metadata:
  emoji: "💬"
  vellum:
    category: "messaging"
    display-name: "SMS Setup"
---

Connects the SMS channel to the user's own [Twilio](https://www.twilio.com)
account. Twilio is the only provider.

## Set expectations first

Say this before starting, because it is usually not what people picture:

- The user creates their **own** Twilio account and buys or ports their own
  number. There is no number provided for them.
- People reach the assistant by texting **that number**, not the user's own
  mobile number.
- The assistant does **not** read the user's personal text messages or
  history. Inbound arrives only on the Twilio line.
- Twilio bills per message (roughly fractions of a cent in the US, more
  elsewhere), plus the number's monthly fee. A2P registration may be required
  for US traffic before carriers will deliver — see step 4.

## 1. Get the credentials

All three come from the Twilio Console
(https://console.twilio.com):

- **Account SID** — on the dashboard, starts with `AC`.
- **Auth Token** — on the dashboard, next to the Account SID. The **live**
  credentials, not the test pair: test credentials cannot send to real
  numbers.
- **From Number** — a number on the account that can send SMS. Buy one under
  Phone Numbers if the account has none (a US number with SMS capability is
  the straightforward choice).

## 2. Store the credentials

**The assistant performs this step.** Do not tell the user to run a terminal
command, send them to Settings, or ask them to paste any of these values into
chat. Tell them what the next secure field is for, then invoke each command
below through the bash tool. Each command blocks until the user submits or
dismisses its secure prompt.

Run the prompts one at a time, in this order:

```bash
assistant credentials prompt --service sms --field account_sid \
  --label "Twilio Account SID" \
  --placeholder "AC..." \
  --description "Paste the live Account SID from your Twilio Console dashboard" \
  --usage-description "Connect your Twilio account to the SMS channel"
```

```bash
assistant credentials prompt --service sms --field auth_token \
  --label "Twilio Auth Token" \
  --placeholder "Twilio Auth Token" \
  --description "Paste the live Auth Token shown next to your Account SID in the Twilio Console" \
  --usage-description "Send and verify SMS messages through your Twilio account"
```

```bash
assistant credentials prompt --service sms --field from_number \
  --label "Twilio SMS Number" \
  --placeholder "+15551234567" \
  --description "Paste the Twilio number with SMS capability that should send and receive assistant messages" \
  --usage-description "Send and receive SMS messages through your Twilio account"
```

Exit code `0` means the value was stored. Exit code `130` means the user
dismissed that prompt, which is a valid choice: ask whether to retry or stop.
Any other non-zero exit is an error to investigate before continuing. Never
put a secret in `config.json` and never paste one into chat. The plugin reads
these values from the credential store at call time, so rotating one later
needs no restart.

## 3. Inbound

The channel programs the number's SMS webhook itself on every start, so once
the credentials are stored and the assistant is reachable (a public
`ingress.publicBaseUrl` or a platform connection), inbound needs no manual
step. A credential save is enough: the restart that follows it programs the
number.

If the assistant has no public URL, inbound SMS cannot arrive until a public
ingress URL is available.

The settings app reports the last registration attempt, including which step
failed. "no webhook could be registered" with a URL reason means the
assistant has no public address; a "not found on this Twilio account" reason
means the from number does not match the account.

## 4. A2P and carrier registration

US carriers require A2P 10DLC registration for traffic from Twilio numbers,
and unregistered traffic is filtered. If the user's messages are not being
delivered, check the messaging compliance section of the Twilio Console
before debugging the plugin: the send will succeed from Twilio's side and
silently fail at the carrier. A trial account can only text verified numbers
added to the console — that restriction lifts on upgrade.

## 5. Save and verify the user's SMS handle

Inbound from a handle that is not a verified identity on the guardian is
classified unknown and denied under the default plugin floor. A number that
is only verified on Phone Calling is still unknown on this channel — plugin
channels keep their own contact records. A number that only appeared in chat
history is not on the contact graph.

After the credentials are stored, check:

```bash
bun skills/sms-setup/scripts/guardian-sms.ts
```

The script prints one of:

- `{ "found": true, "address": "+15551234567", "verified": true }` — already
  attested. Say so and skip the rest of this step.
- `{ "found": true, "address": "+15551234567", "verified": false }` — stored
  but not attested. Open the prompt below with `--default-value` set to
  `address`.
- `{ "found": false, "suggested": "+15551234567" }` — no SMS row yet. A Phone
  Calling number is only a prefill. Open the prompt with `--default-value` set
  to `suggested` unless this conversation already has their number.
- `{ "found": false }` — nothing to prefill. Open the prompt. If this
  conversation already has their number, pass it as `--default-value` in
  E.164. Do not invent a number.

Then save the handle as a guardian SMS channel (the prompt the contacts
skill documents; replace `<number>` with the value above):

```bash
assistant contacts prompt-channel --type sms --address <number> --role guardian
```

and tell the user to reply **STOP** unwanted-sender style or text the line
from their phone so verification can complete the next time they message the
assistant — the verified state is what admits them past the floor.

## 6. Confirm

Have the user text the line. The turn runs, the reply arrives on their phone,
and the settings app's inbound report confirms the delivery. If nothing
arrives: the number's webhook (Twilio Console, Phone Numbers, the number,
Messaging), the assistant's public URL, and step 4's A2P note, in that order.

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

- The user owns the **Twilio account** and the assistant's public SMS line.
  Vellum does not supply a number or pay Twilio charges.
- People reach the assistant by texting **that selected Twilio line**, not the
  user's personal mobile number.
- The assistant does **not** read the user's personal text messages or
  history. Inbound arrives only on the selected Twilio line.
- Twilio bills messages and numbers in the user's account. If setup needs to
  buy a number, explain that it is billable and get explicit confirmation
  immediately before the purchase.

## 1. Get the Twilio credentials

The only values the user needs from the Twilio Console
(https://console.twilio.com) are:

- **Account SID** — on the dashboard, starts with `AC`.
- **Auth Token** — next to the Account SID. Use the **live** credentials, not
  the test pair: test credentials cannot send to real numbers.

The assistant selects the public SMS number after these credentials are saved.
Do not ask the user to find, paste, or type a Twilio phone number.

## 2. Store the credentials securely

**The assistant performs this step.** Do not tell the user to run a terminal
command, send them to Settings, or ask them to paste either value into chat.
Tell them what the next secure field is for, then invoke each command below
through the bash tool. Each command blocks until the user submits or dismisses
its secure prompt.

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

Exit code `0` means the value was stored. Exit code `130` means the user
dismissed that prompt, which is a valid choice: ask whether to retry or stop.
Any other non-zero exit is an error to investigate before continuing. Never
put a secret in `config.json` and never paste one into chat.

## 3. Select or purchase the assistant's SMS line

Run this after both credential prompts succeed:

```bash
bun skills/sms-setup/scripts/twilio-numbers.ts list
```

Parse its JSON stdout. It only returns SMS-capable phone numbers owned by the
user's Twilio account.

### Exactly one account number

When `numbers.length === 1`, name that number and ask the user to confirm it
as the assistant's public SMS line. Use a `ui_show` confirmation surface.
Only after confirmation, run:

```bash
bun skills/sms-setup/scripts/twilio-numbers.ts use --phone-number <number>
```

### Multiple account numbers

When `numbers.length > 1`, show a `ui_show` **single-select** `choice` surface.
Each option's `id` is the E.164 `phoneNumber`; its title is the formatted
number and its description includes `friendlyName` when present. Do not guess
which line they mean. Once the user selects one, run:

```bash
bun skills/sms-setup/scripts/twilio-numbers.ts use --phone-number <selected-number>
```

### No account number

When `numbers.length === 0`, ask the user for the two-letter country code to
search. Use `US` without asking only if the user already established that they
want a United States number. Optionally ask for an area code when they want one.
Then run:

```bash
bun skills/sms-setup/scripts/twilio-numbers.ts search --country <country> [--area-code <area-code>]
```

Show returned candidates in a single-select `ui_show` `choice` surface. Include
the number, locality/region when present, and any `addressRequirements` in the
option description. Explain that the selected number will be **purchased in
their Twilio account**, may require regulatory information, and incurs Twilio
charges.

A candidate selection is not purchase authorization. Show an explicit final
`ui_show` confirmation naming the selected number and stating it is a billable
Twilio purchase. Only after the user confirms that surface, run:

```bash
bun skills/sms-setup/scripts/twilio-numbers.ts purchase --phone-number <selected-number>
```

The `use` and `purchase` commands write the selected public line as
`fromNumber` in this plugin's local `config.json`, never in the credential
store. They also program the SMS webhook when the assistant has a public URL.
Parse the JSON result and report the saved `fromNumber` plus its webhook
outcome. A `skipped` webhook outcome means the assistant has no public ingress
URL yet; a `failed` outcome needs investigation before inbound messages will
arrive.

## 4. Inbound

The channel programs the selected number's SMS webhook during setup and on
startup. If the assistant has no public URL, inbound SMS cannot arrive until a
public ingress URL is available.

The settings app reports the saved **Assistant SMS number** and the last
registration attempt. "no webhook could be registered" with a URL reason means
the assistant has no public address; a "not found on this Twilio account"
reason means the configured line no longer belongs to the account.

## 5. A2P and carrier registration

US carriers require A2P 10DLC registration for traffic from Twilio numbers,
and unregistered traffic is filtered. If the user's messages are not being
delivered, check the messaging compliance section of the Twilio Console
before debugging the plugin: the send will succeed from Twilio's side and
silently fail at the carrier. A trial account can only text verified numbers
added to the console — that restriction lifts on upgrade.

## 6. Save and verify the user's SMS handle

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

## 7. Confirm

Have the user text the line. The turn runs, the reply arrives on their phone,
and the settings app's inbound report confirms the delivery. If nothing
arrives: the number's webhook (Twilio Console, Phone Numbers, the number,
Messaging), the assistant's public URL, and step 5's A2P note, in that order.

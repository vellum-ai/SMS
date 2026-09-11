# sms

An SMS channel for the Vellum assistant, backed by Twilio.

## What it does

Makes the assistant reachable by text message. People text the configured
Twilio number, and the assistant answers over SMS. The assistant can also send
on request via the `sms` skill.

## What it does not do

It does not read the user's personal text messages, history, or existing
threads. Inbound arrives only on the configured Twilio line.

## Getting started

1. Create or sign in to a [Twilio account](https://www.twilio.com).
2. Buy or choose an SMS-capable Twilio number.
3. Copy the Account SID, Auth Token, and that number.
4. Open the SMS settings app and save those three values.

When the assistant has a public ingress URL, the plugin programs the number's
SMS webhook automatically. If there is no public ingress URL, inbound SMS
cannot arrive until one is available.

For Twilio's account, number, and messaging setup, see [Send SMS and MMS
messages](https://www.twilio.com/docs/messaging/tutorials/how-to-send-sms-messages).

The same values can be stored from a terminal:

```bash
assistant credentials set --service sms --field account_sid <sid>
assistant credentials set --service sms --field auth_token <token>
assistant credentials set --service sms --field from_number <number>
```

The auth token is also the webhook signing key.

## Twilio specifics worth writing down

- **US traffic may need A2P 10DLC registration.** Check Twilio's messaging
  compliance requirements if carriers do not deliver messages.
- **Trial accounts can only text verified numbers** added to the Twilio
  Console.
- **Status callbacks are not messages.** A delivery that has `MessageStatus`
  but no `Body` is ignored rather than treated as a conversation turn.
- **`MessagingServiceSid` numbers are out of scope for v1.** The webhook for
  a number in a messaging service is programmed on the service, not the
  number.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```

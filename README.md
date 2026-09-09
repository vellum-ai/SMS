# sms

An SMS channel for the Vellum assistant, backed by Twilio.

## What it does

Makes the assistant reachable by text message. People text the Twilio number
the line listens on, and the assistant answers over SMS. The assistant can
also send on request, via the `sms` skill.

## What it does not do

It does not read the user's personal text messages, history, or existing
threads. Inbound arrives only on the Twilio line the plugin is configured with.

## Bring your own line

You supply the Twilio account and the number:

| You need | Where |
| --- | --- |
| Account SID, Auth Token (live credentials) | [console.twilio.com](https://console.twilio.com) |
| A number with SMS capability | Phone Numbers, in the same console |

Bringing your own is the only option. Twilio bills per message plus a monthly
number fee, and the account holder is the one Twilio's A2P compliance applies
to, so there is no provider-neutral line this plugin could offer on anyone's
behalf.

The `sms-setup` skill walks through the whole thing, including inbound and the
guardian's own number verification. The settings app and a terminal also work:

```bash
assistant credentials set --service sms --field account_sid <sid>
assistant credentials set --service sms --field auth_token <token>
assistant credentials set --service sms --field from_number <number>
```

The auth token is also the webhook signing key — see below — so the same
credential covers sending, receiving, and verification.

## How it fits together

The architecture is the iMessage plugin's, with one provider where that one
has three. The provider seam (`src/providers/types.ts`) is unchanged in shape:
everything above it — the poller, the transport, the webhook route — is
provider-agnostic, and only `src/providers/twilio/` knows what a Twilio
payload looks like. A second provider would be a directory and a registry
entry.

**Inbound is webhook-first.** Twilio POSTs each message to the number's
`SmsUrl`, form-encoded, signed with `X-Twilio-Signature`. Verification is the
gateway's job: `channels/ingress.json` declares the route with the `twilio`
verification kind, and the handler never sees an unverified delivery. The
signature is an HMAC-SHA1 over the full request URL plus the sorted form
params, keyed by the account auth token — a scheme that does not fit the
gateway's generic `hmac` kind, hence the dedicated one.

**Gating happens before the forward.** The gateway reads the sender and the
chat out of the delivery's own form params (the `inbound` declaration names
`From`, `Body`, `MessageSid`), runs the same admission pipeline every
built-in channel runs, and only then forwards to the plugin route. A sender
the floor denies never reaches this plugin; the gateway posts an
admission-denied notice instead and the plugin sends the canned denial over
the same line.

**"Registering" the webhook means programming the number.** Twilio has no
webhook registry: the delivery URL is a field on the phone number itself. On
every webhook-mode start the plugin lists the account's numbers, finds the
configured one, and writes `SmsUrl` only when it differs. There is no issued
signing secret to store — Twilio signs with the auth token the user already
holds — which is why there is no `read-secret` round trip in the registration
flow.

**Poll mode exists but cannot receive.** `GET /Messages.json` gives a
listing, so poll mode sees what arrived — but a polled message is not a reply
to a gated delivery, and nothing else offers a way into the host's inbound
pipeline, so poll mode logs and drops. Deployments that need inbound run
`ingressMode: "webhook"`.

**Outbound chunks instead of truncating.** A long reply becomes several
messages (1,400 characters each, capped at five, with the cap announced in the
last chunk). Twilio has no send idempotency, so a retried turn can double-send
its reply; the turn layer keys chunks on the message being answered, which is
the bound available without client-side state.

## Twilio specifics worth writing down

- **US traffic needs A2P 10DLC registration.** Unregistered traffic is
  filtered by carriers, and the send still succeeds from Twilio's side — a
  silent failure that looks like a plugin bug. The setup skill checks this
  before anything else when messages do not arrive.
- **Trial accounts can only text verified numbers** added to the console.
  The restriction lifts on upgrade.
- **Status callbacks are not messages.** If a number's status callback points
  at this plugin's route, the delivery carries `MessageStatus` and no `Body`,
  and the classifier ignores it as a receipt rather than a turn.
- **`MessagingServiceSid` numbers are out of scope for v1.** The webhook for
  a number in a messaging service is programmed on the service, not the
  number; configuring one is a follow-up.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```

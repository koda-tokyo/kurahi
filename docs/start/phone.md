---
summary: "Five minutes from a fresh install to your resident answering you on your phone: WhatsApp, Telegram, LINE or the phone browser"
read_when:
  - You just installed Kurahi and want to talk to it from your phone
  - You are choosing between WhatsApp, Telegram, LINE and the phone browser
  - You need to unbind or re-bind the owner of a channel
title: "Connect your phone"
---

# Connect your phone (five minutes)

Also available in [Japanese](/ja/start/phone).

The last step of `kurahi init` asks **Connect your phone** and ends with a QR code. Scan it, send
one message, and your resident answers you there. The same step is available any time as
`kurahi connect <channel>`.

```bash
kurahi init                       # last question: Connect your phone
kurahi connect telegram           # or whatsapp, line, web
kurahi connect --list             # who is bound as owner on which channel
kurahi connect --unbind telegram  # remove that owner again
```

## The five minutes

| Minute | What you do                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0-2    | Install: `curl -fsSL https://kodasoken.com/kurahi/install.sh \| bash` (Windows: `iwr -useb https://kodasoken.com/kurahi/install.ps1 \| iex`) |
| 2-3    | `kurahi init`: identity name, who may reach the gateway, provider token                                                                      |
| 3-4    | Answer **Connect your phone**: pick a channel, follow its two or three prompts                                                               |
| 4-5    | Scan the QR with your phone and send the first message; the resident answers                                                                 |

The gateway must be running to receive that first message. The installer registers it as a
service; if you ran `kurahi init` by hand, start it with `kurahi service install` (or `kurahi gateway`
in another terminal). Codes stay valid for 10 minutes, so there is time to do this after the QR
is printed.

## Which channel

| Channel       | You need                                                                       | Owner proof                         | Best for                             |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------ |
| Telegram      | a Telegram account; one bot from BotFather                                     | first `/start` with a one-time code | the fastest path                     |
| WhatsApp      | the WhatsApp app on your phone                                                 | scanning the linked-device QR       | talking from the app you already use |
| LINE          | a LINE Official Account (Messaging API) and a public HTTPS URL for the webhook | first message with a one-time code  | teams in Japan                       |
| Phone browser | the gateway reachable on your network or tailnet over HTTPS                    | a one-shot pairing invitation       | no messaging account at all          |

## Telegram

1. `kurahi connect telegram` (or choose Telegram in `kurahi init`).
2. On your phone, open https://t.me/BotFather, send `/newbot`, pick a name and a username ending in
   `bot`, and paste the token BotFather returns. The token goes to the secrets store; the config
   holds only a `{"$secret": "channel.telegram.botToken"}` reference.
3. Scan the QR. It opens `https://t.me/<your bot>?start=KOLO-XXXXXXXX`; press **Start**.
4. The first `/start` with that code binds your Telegram user as the channel owner and the bot
   answers "You are now the owner of this resident". Write anything; the resident replies.

Without prompts: `TELEGRAM_BOT_TOKEN=<token> kurahi init --non-interactive --phone telegram`, or
`kurahi connect telegram --stdin --no-wait` with the token on stdin.

## WhatsApp

1. `kurahi connect whatsapp`.
2. On your phone: WhatsApp > Settings > Linked devices > Link a device, and scan the QR in the
   terminal. The code refreshes about every 20 seconds; the newest one is printed again.
3. Scanning proves you hold the number, so the linked number is bound as owner right away.
4. In WhatsApp choose **Message yourself** and write a message. The first one gets a one-line
   "Connected" welcome, then the resident's answer.

`kurahi connect whatsapp --force` links again when a session already exists.

## LINE

1. Create a Messaging API channel in the LINE Developers console
   (https://developers.line.biz/console/). Copy the **Channel secret** and issue a long-lived
   **Channel access token**.
2. `kurahi connect line` and paste both. They go to the secrets store, never to `kolo.json`, argv or
   the logs.
3. Register the webhook. LINE delivers messages only to a public HTTPS URL:
   `https://<your-public-host>/line/webhook`, forwarded to the gateway port. Kurahi does not create a
   tunnel for you; use one of:
   - a public funnel from your tailnet (see [Tailscale](/gateway/tailscale)),
   - a reverse proxy with a TLS certificate on a host you control,
   - a tunnel service you already operate.

   Then enable **Use webhook** in the console. Details: [LINE](/channels/line).

4. Scan the QR (the bot's add-friend URL), add the bot, and send the `KOLO-XXXXXXXX` code shown in
   the terminal as your first message. That binds your LINE user as owner.

## Phone browser

`kurahi connect web` prints a QR of `https://<address>:<port>/#pair=<code>`: a one-shot pairing
invitation (scope `attach`, 10 minutes, single use). The dashboard opens, takes the code out of
the address bar, redeems it with a device key kept in the browser and stays signed in, refreshing
its credential on its own. The code travels in the URL fragment, which the browser never sends to a
server.

It is offered only when the gateway is reachable from your phone, which is an explicit choice:

- `kurahi init --bind lan` (or `tailnet`, `custom`) sets `gateway.bind` and `gateway.remote.enabled`.
  On `loopback` (the default) the flow explains this instead of printing a QR.
- Browsers keep device keys only on HTTPS pages, so enable TLS:
  `kurahi config set gateway.tls.enabled true` (a self-signed certificate is generated; your phone
  asks you to trust it once), then restart the gateway.

Withdraw an unused invitation with `kurahi pair revoke <invitation id>`; remove a paired phone with
`kurahi pair devices` and `kurahi pair revoke <fingerprint>`.

## Owner binding

- A one-time code (`KOLO-` and eight characters) is valid for **10 minutes** and **once**. Only its
  hash is stored (`<KOLO_HOME>/channels/owner-codes.json`, mode 0600). A new code withdraws the
  previous unused one for that channel.
- Binding writes `channels.<channel>.identities["<sender id>"] = "owner"` (per account under
  `channels.<channel>.accounts.<id>.identities`) and adds the sender to the channel's pairing
  allowlist. Once a channel has identities, only the listed senders hold roles there (see
  [Channel residents](/channels/README)).
- Every step is audited: `channel.owner_code.issued`, `channel.owner_code.claim`,
  `channel.owner_bound`, `channel.owner_unbound`. Check with `kurahi audit verify`.
- `kurahi connect --unbind <channel>` removes exactly what bindings added (identities keys and
  allowlist entries) and withdraws pending codes.

## Replies and proactive messages

Talking to your resident from the phone is a conversation: the resident may always **reply** to a
message from a sender the channel admitted, within `channels.delivery.replyWindowMs` (24 hours by
default). Anything it would send on its own initiative is **proactive** and follows
`channels.delivery.policy`: by default (`human-triggered`) automated proactive sends are refused and
dead-lettered; `replies-only` refuses every proactive send; `allow-automated` lets daemons and cron
lanes message you. See [Delivery guarantees](/channels/README#delivery-guarantees).

## Troubleshooting

- **No answer to the first message**: is the gateway running (`kurahi health`)? Did the code expire
  (`kurahi connect <channel>` prints a new one)? For LINE, check the webhook in the console.
- **"This code has expired or was already used"**: run `kurahi connect <channel>` again.
- **The phone browser says the page is plain HTTP**: enable `gateway.tls` and scan a new code.
- **Wrong person bound**: `kurahi connect --unbind <channel>`, then connect again.

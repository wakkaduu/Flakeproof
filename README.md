# Flakeproof

> A deposit that costs you nothing if you show up.

**Status (Oct 31, day 1 of building): the money flow and the RSVP agent work; the host dashboard and the
AI Judge are not built yet.** This README only claims what has been run, and labels the rest.

<p>
  <img src="docs/screenshots/host-review.png" alt="Host reviews what the AI found in the group chat" width="220">
  <img src="docs/screenshots/host-links.png" alt="One link per friend plus a private host link" width="220">
  <img src="docs/screenshots/guest-invite.png" alt="A friend's page: approve a hold on PayPal, nothing is charged" width="220">
</p>

## The idea

A host creates an event (a booked court, a restaurant table, tickets). Each friend opens one link, no
account, and approves a small deposit through PayPal. The deposit is only **authorized**: a hold,
nothing is charged.

After the event:

- Friends who showed up: their authorization is **voided**. They pay nothing.
- No-shows: their authorization is **captured**.
- The captured pot, after PayPal's fees, is **paid out** (PayPal Payouts) to the people who came.

Meant for events where a no-show costs the host real money, not casual hangouts. PayPal honors an
authorization for 3 days (valid 29; reauthorization is not built). The host may pick any start time,
but the app warns when it is further away than the honor period, because capture may then be refused.

## Before you start (about 15 minutes, one time)

You need three things. Without them you can still run `npm test` (no keys needed).

1. **Node 22 or newer.**
2. **PayPal sandbox** (free, [developer.paypal.com](https://developer.paypal.com)): a **United States**
   Business account with a *Merchant* REST app (Client ID and Secret), plus at least one **United States**
   Personal account to play a friend. Step by step in [docs/sandbox-setup.md](docs/sandbox-setup.md).
   Non-US accounts break the payout step (currency conversion), so please use US.
3. **A Gemini API key**, free, from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Without
   it the app still works; the host adds guests by hand and the AI features say so.

## Run it

```bash
cp .env.example .env     # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, GEMINI_API_KEY
npm run setup            # install, generate the Prisma client, create the SQLite database
npm test                 # 141 tests (106 server, 35 web), no keys needed
npm run dev              # API on :3001, web app on http://localhost:5173
```

Then open http://localhost:5173/new, paste a group chat, review what the AI found, and copy each
friend's link. Open a friend's link, press **Approve with PayPal**, and log in with a sandbox Personal
account in a private window; PayPal returns you to the same page, which confirms the hold.

Checks that talk to the **real** services (they print a report you can read):

```bash
npm run e2e:sandbox          # the whole server flow on the PayPal sandbox: 3 friends, 1 flakes, pot paid to the 2 who came
npm run ai:smoke -w server   # the real Gemini model on a sample chat (needs GEMINI_API_KEY)
npm run spike                # raw PayPal calls: authorize, capture, void, payout
```

Single process, the way a hosted demo would run: `npm run build`, then
`APP_BASE_URL=http://localhost:3001 npm start`. `APP_BASE_URL` must be the address people actually
open, because guest links and PayPal's return URLs are built from it. Behind a proxy also set `TRUST_PROXY=1`.

## How AI is used

| Role | What it does | Model / service | State |
|---|---|---|---|
| RSVP agent | Reads pasted group-chat text and proposes the guest list, deposit and start time. Asks when unsure. | Google Gemini API (`GEMINI_MODEL`, currently `gemini-3.5-flash-lite`) | Built and run live |
| Judge | After the event, recommends capture or forgive for each no-show, with a quoted reason. The host approves before any money moves. | same model | **Designed ([docs/judge-design.md](docs/judge-design.md)), not built** |

The model only reads and recommends. It cannot move money. Amounts, splits and rounding are plain code in
integer cents. Because the real model sometimes invents guests, every name, amount and time it returns is
checked against the pasted chat in code first (see [docs/api.md](docs/api.md)).

## What works (honest table)

| Piece | State |
|---|---|
| PayPal: authorize, void, capture, payout to a second account | **Run on the real sandbox, all pass** ([results](docs/spike-results.md)) |
| Server: events, guests, deposits, state machine, host-approved settlement ([API](docs/api.md)) | Built. **Real sandbox end to end passes** (`npm run e2e:sandbox`); 106 server tests against a fake PayPal |
| Money safety: never capture a deposit nobody could receive; payout preview; fee reserve | Built and tested with fakes. The fee model behind the preview is from a few sandbox observations |
| Guest link page (mobile first) | Built; 35 web tests. **Driven in a real headless browser at phone width**: renders, no console errors, and "Approve with PayPal" reaches PayPal's sandbox. The approval-and-return leg was not completed by automation |
| RSVP agent: paste chat, verified proposal, host review, invite links | Built. Real Gemini checked live, including prompt-injection and invented-guest cases |
| Host dashboard: end event, check-ins, decisions, approve and settle | **API built, no UI yet** |
| AI Judge | **Not built** |
| Tests with a fake PayPal and a fake AI | Done |

Paths that exist in code but were **never run against the real PayPal sandbox** (only fakes or a local stub):
reading a pending capture, `UNCLAIMED` / `ONHOLD` payout items, voiding a hold that did not match the deposit.

## Sandbox only

No live credentials and no real money, anywhere. The PayPal host is hardcoded to the sandbox. PayPal charges
fees even in the sandbox, so the pot is smaller than the sum of deposits (the host view shows both).
More in [docs/security-notes.md](docs/security-notes.md), including known limits and an `npm audit` note.

## Docs

[Sandbox setup](docs/sandbox-setup.md) · [API and AI guardrails](docs/api.md) · [Spike and live-check results](docs/spike-results.md) ·
[Judge design](docs/judge-design.md) · [Security notes](docs/security-notes.md) · [Demo runbook and schedule](docs/demo-runbook.md)

## Unverified

The Official Rules of the hackathon have not been read by the author: eligibility, IP and legal terms
(including whether pooling friends' deposits and paying them out is acceptable) are unchecked.

## License

MIT, see [LICENSE](LICENSE).

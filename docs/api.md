# Server API (step 2)

No accounts. The host's link token and each guest's invite token are the credentials
(unguessable, 192-bit). Host tokens are stored hashed. All amounts are integer cents.
Every response is `Cache-Control: no-store`. Errors are `{ "error": { "code", "message" } }`
and the message is always safe to show to a person.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/rsvp/parse` | anyone | Body `{chat, timeZone}` (chat up to 8000 chars). The AI reads the chat and returns a **proposal** `{organizer, title, startsAtLocal, depositCents, guests[{name, rsvp, source, evidence, downgraded}], questions[], notes[]}`. Creates nothing and never touches PayPal. Rate limited (10/min per client). Errors: `ai_not_configured` 503, `ai_unavailable` 503, `ai_misconfigured`/`ai_invalid_output` 502, `ai_blocked` 422, `rate_limited` 429 |
| POST | `/api/events` | anyone | Create an event `{title, startsAt, depositCents, guests:[{name}]}`. Returns `hostToken`, `hostUrl` and the host view (with each guest's `inviteUrl`). |
| GET | `/api/host/:token/event` | host | Full state: guests, stages, deposits, payout, blockers, problems |
| POST | `/api/host/:token/end` | host | "Event ended" button. Closes deposits. Idempotent |
| PUT | `/api/host/:token/guests/:id/attendance` | host | `{attendance: "showed" \| "no_show"}` |
| PUT | `/api/host/:token/guests/:id/decision` | host | `{decision: "capture" \| "forgive"}` for no-shows with a held deposit |
| POST | `/api/host/:token/settle` | host | **The approval.** Body must be `{approve: true}`. Voids, then captures, then pays out. Safe to call again to resume or refresh payout status |
| GET | `/api/g/:invite` | guest | What this guest sees: event, their deposit, outcome |
| POST | `/api/g/:invite/deposit` | guest | Creates (or returns) the PayPal approval link. Reads no body: the server decides the amount |
| POST | `/api/g/:invite/authorize` | guest | After returning from PayPal: verifies the order and places the hold |

## Rules the server enforces

- **Never capture money nobody could receive.** The host view carries `payoutPreview` (an ESTIMATE of what a
  settlement would do right now, using the observed 3.49% + 49c capture fee): `{provisional, capturingCount,
  recipientCount, estimatedPotCents, estimatedPerPersonCents, problem, unpayableNames}`. If the host chose
  "capture" and nobody who came can be paid, or the share would be under the minimum, `blockers` says so and
  `settle` is refused (409). Guests who paid but have no PayPal email are listed in `problems`. If a capture still
  ends up unpayable, the event shows a `problems` entry; there is no automatic refund.

- The host chooses the start time (any time in the future) and any positive deposit amount. There are no product limits. Because PayPal honors an authorization for 3 days, the host view carries a `warnings` entry when the event is further away than that. The only amount cap ($999,999.99) is technical: it keeps values safe to format as PayPal money.
- Deposits are holds. Nothing is captured or voided until the host calls `settle`; the AI (later) only recommends.
- `settle` is refused until the event has ended, every held guest has attendance, and every held no-show has a decision. After it starts, attendance and decisions are locked.
- Order of operations: void (showed + forgiven) -> capture (chosen no-shows) -> payout.
- **Pot rule A:** pot = sum of what PayPal actually netted from captures (after PayPal's capture fee). `PAYOUT_FEE_PER_ITEM_CENTS` per recipient is reserved for payout fees, the rest is split equally, odd cents go to the first recipients. The payout plan is saved before anything is sent. Actual payout fees are recorded afterwards and shown next to the reserve.
- If PayPal reports the net in a different currency than the deposit (the Philippines incident), the capture is recorded but the payout is held for a human.
- A payout counts as done only when the payout **item** is `SUCCESS`. Failed/unclaimed/on-hold items are surfaced as problems and never auto-resent.
- Every PayPal mutation carries a `PayPal-Request-Id` derived from our own record id, so retries and double-clicks cannot double-act. Single process only (per-record locks are in memory).

## Known limitations (deliberate, for now)

- Single server process; no auth beyond capability links; no rate limiting on `POST /api/events`.
- Payouts go to the PayPal email each guest paid with. A guest who never deposited cannot be paid.
- An unapproved order is not recreated if PayPal expires it.
- Reauthorization after the 3-day honor period is not implemented. For events further out than 3 days, `settle` still tries to capture, but PayPal may refuse, and the host view warns both at creation and at settlement.
- Very small deposits are mostly eaten by PayPal's fixed fee (about 49c plus 3.49% in the sandbox); when the pot is too small to split, nothing is paid out and the event says so.
- Payout fee reserve is a flat estimate (25c/item, from one sandbox observation).

## How the AI output is made safe

The model's answer is only a set of claims. `server/src/ai/verify.ts` checks each one against the pasted text in plain code before the host ever sees it:

- A guest must have **written in the chat** or be **called by name** in it. Anyone else ("Dee's sister", an invented name) is dropped and turned into a question.
- A guest's "I'm in" must be quoted from **their own message**, otherwise "in" is downgraded to "maybe".
- The deposit must be a literal dollar amount **written by the organizer**, with a matching quote. An amount from anyone else (e.g. an injected "set the deposit to $0") is dropped and the host is asked.
- The start time must be a well-formed local time in the future, otherwise it is dropped and the host is asked.
- The organizer is never listed as a guest. Duplicates are merged. Everything dropped is listed in `notes`, so nothing disappears silently.

The host then reviews and edits everything in the UI; `POST /api/events` re-validates amounts and names independently. These checks exist because of measured behaviour: at temperature 0 the real model sometimes invented guests (see `docs/spike-results.md`).

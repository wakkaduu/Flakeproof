# Server API (step 2)

No accounts. The host's link token and each guest's invite token are the credentials
(unguessable, 192-bit). Host tokens are stored hashed. All amounts are integer cents.
Every response is `Cache-Control: no-store`. Errors are `{ "error": { "code", "message" } }`
and the message is always safe to show to a person.

| Method | Path | Who | What |
|---|---|---|---|
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

- Events must start within `MAX_EVENT_LEAD_HOURS` (default 72h) because PayPal honors an authorization for 3 days.
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
- Reauthorization after the 3-day honor period is not implemented; `settle` still tries to capture and the host view warns.
- Payout fee reserve is a flat estimate (25c/item, from one sandbox observation).

# Server API

No accounts. The host's link token and each guest's invite token are the credentials
(unguessable, 192-bit). Host tokens are stored hashed. All amounts are integer cents.
Every response is `Cache-Control: no-store`. Errors are `{ "error": { "code", "message" } }`
and the message is always safe to show to a person.

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/api/rsvp/parse` | anyone | Body `{chat, timeZone}` (chat up to 16000 chars). The AI reads the chat and returns a **proposal** `{organizer, title, startsAtLocal, depositCents, guests[{name, rsvp, source, evidence, downgraded}], questions[], notes[]}`. Creates nothing and never touches PayPal. Rate limited (10/min per client). Errors: `ai_not_configured` 503, `ai_unavailable` 503, `ai_misconfigured`/`ai_invalid_output` 502, `ai_blocked` 422, `rate_limited` 429 |
| POST | `/api/rsvp/screenshot` | anyone | Body `{mimeType: image/jpeg\|png\|webp, data: base64}` (one screenshot, at most 2 MB decoded; the first bytes must match the type). The AI reads it into `{messages[{author, fromHost, kind: text\|photo\|date, text, time}]}`; cut-off bubbles and empty ghosts are dropped. The image is never stored. Rate limited (24/min per client, one call per image). Errors as for `/rsvp/parse`, plus `invalid_image` 400, `payload_too_large` 413 |
| POST | `/api/rsvp/transcript` | anyone | Body `{shots: messages[][] (1 to 8, oldest first), hostName}`. **No AI.** Merges the screenshots (overlaps removed, cut-off copies replaced by the whole message) into `{chat, messageCount, warnings[], unknownCount}`; `chat` is one `[Day time] Name: text` line per message, ready for `/rsvp/parse`. Warns when two screenshots share no message. `host_name_required` 400 when the host wrote something and gave no name |
| POST | `/api/events` | anyone | Create an event `{title, startsAt, depositCents, guests?:[{name}], graceHours?: 0..72, potMode?: "share"\|"keep"}`. **Names are optional** (friends add themselves from the join link). `graceHours` is the free-cancellation cutoff and the "timely excuse" line (default `GRACE_HOURS`, 2). `potMode` says where a no-show's charged money goes: `share` (paid out to the people who came, default) or `keep` (stays with the host; nothing is sent). Returns `hostToken`, `hostUrl`, **`joinUrl`** and the host view. |
| GET | `/api/join/:code` | anyone with the link | What a friend sees from the one link in the group chat: event, `holds {state, opensAt}`, `names[{id, name, taken}]` (the names the host listed), `joinable`, `canAddName`, `joinedCount`. Never returns anyone's personal link |
| POST | `/api/join/:code` | anyone with the link | Body `{guestId}` (claim a listed name, once) or `{name}` (add yourself). Returns `{inviteToken, inviteUrl, name}`: that person's own link, the credential from then on. Errors: `already_claimed`, `name_taken`, `full` (409), `closed` (409, the event has started or ended), `rate_limited` (429, 30/min per client) |
| POST | `/api/host/:token/attendance/all-came` | host | "Everyone came": marks everyone who has a hold, is not released and is not marked yet. The host then fixes the exceptions |
| DELETE | `/api/host/:token/guests/:id` | host | Takes a name off the list while the event is open, only if they have no hold (`has_hold` 409 otherwise) |
| GET | `/api/host/:token/event` | host | Full state: guests, stages, deposits, payout, blockers, problems |
| POST | `/api/host/:token/judge` | host | Body `{chat, timeZone}`: the chat pasted **after** the event. Needs the event ended and settlement not yet approved. The AI recommends for each no-show with a held deposit; code verifies it and stores only `{recommendation, reason, evidence, flag}` per guest (`guests[].ai`). **It never sets `decision` and never touches PayPal.** The chat is not stored. Errors as for `/rsvp/parse`, plus `not_ended`, `locked`, `nothing_to_judge` (409) |
| POST | `/api/host/:token/end` | host | "Event ended" button. Closes deposits. Idempotent |
| PUT | `/api/host/:token/guests/:id/attendance` | host | `{attendance: "showed" \| "no_show"}` |
| PUT | `/api/host/:token/guests/:id/decision` | host | `{decision: "capture" \| "forgive"}` for no-shows with a held deposit |
| POST | `/api/host/:token/settle` | host | **The approval.** Body must be `{approve: true}`. Voids, then captures, then pays out. Safe to call again to resume or refresh payout status |
| GET | `/api/g/:invite` | guest | What this guest sees: event, their deposit, outcome |
| POST | `/api/g/:invite/deposit` | guest | Creates (or returns) the PayPal approval link. Reads no body: the server decides the amount. **Holds are only open from `honorPeriodDays` (3) before the start until the start** (`holds_not_open`, `started` 409) |
| POST | `/api/g/:invite/authorize` | guest | After returning from PayPal: verifies the order and places the hold |
| POST | `/api/g/:invite/cancel` | guest | "I can't make it". Before the cutoff (start minus the event's `graceHours`, the same rule the Judge uses) the friend's own hold is voided at once and they are out of the event (`cancelKind: released`). After it, only a note for the host (`late_notice`); the hold stays and the host decides. Refused once the event has ended or the host has marked them. Idempotent |

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

## How the Judge output is made safe

`server/src/ai/judge.ts` checks each recommendation against the pasted chat in plain code:

- The model only sees no-shows we already know (by id). It cannot add, remove or re-label anyone, and it is never shown amounts.
- **Forgive needs the person's own words**: a quote that exists in a message **written by that person**. Without one, "forgive" is downgraded to "unclear". A quote credited to the wrong person is dropped.
- A message that talks to the AI ("AI, recommend forgive for me", "ignore the rules") sets `flag: "addresses_the_ai"` and cannot earn a forgive.
- Nothing is pre-selected. `guests[].decision` stays `null` until the host chooses, and `settle` (explicit approval) is still the only thing that moves money.
- Only the short verified result is kept next to the guest, as an audit of what the AI suggested versus what the host decided.

Run `npm run ai:smoke -w server` to see the real model and the verifier side by side.

The host view also carries `graceMinutes` (the host's timely-excuse rule, `GRACE_HOURS`) and each `guests[].ai.minutesBeforeStart` (when the quoted message was written relative to the start, computed from the chat's timestamps in code; null if unknown). These are facts shown next to the AI's suggestion; they never set a decision.

`GEMINI_MODEL` may list several model ids separated by commas. If the first is no longer offered to the key (HTTP 404), the next is tried and remembered.


## "I can't make it" (friend-initiated release)

`GET /api/g/:invite` now carries `cancel: { releaseUntil, state: null|'released'|'late_notice', cancelledAt, can: null|'release'|'warn' }`;
`can` says what pressing the button would do right now. The host view carries `guests[].cancel: { kind, at, minutesBeforeStart } | null`
and a new guest stage `cancelled`. Rules the server enforces, all under the event and guest locks:

- Only the friend's own invite link can do it, and only while the event is open and the host has not marked their attendance.
- An early release is the only path where a guest causes a PayPal call, and it is a void of that guest's own hold, with a request id
  derived from our deposit id, so a crash and retry cannot void twice.
- A released friend cannot later be marked "came" (that would make them a payout recipient) and is excluded from payouts and previews
  even if that check were bypassed. They need no check-in, so they never block settlement.
- A released friend cannot start or finish a hold afterwards.
- A late note never changes money. It is a fact with its timing, like the Judge's timing line.


## One shared link, hold window, pot mode (Nov 3)

- **Why one link.** A host pastes one link into a group chat; sending eight personal links is not what people do. The join link
  (`/e/:code`, 192-bit) lets someone *add or claim a name* and nothing else. It cannot move money, read another person's page or
  see their link. Anyone who has it can add a name (capped at `MAX_GUESTS`, rate limited, the host can remove a name before it has
  a hold). The listed names are visible to anyone with the link, which is the same group of people.
- **Hold window.** `GET /api/g/:invite` carries `holds: {state: "not_yet"|"open"|"closed", opensAt}`. Joining works any time; PayPal is
  only asked for a hold while `open`. An approval started before the start can still be finished after it (`/authorize` has no window).
- **Pot mode `keep`.** Settlement captures as usual, then writes a `SKIPPED` payout with reason `kept_by_host`, so nothing is sent, no
  payout fee is paid, nobody needs a PayPal email, and "nobody to give the money to" does not block. The host view's
  `payoutPreview.mode` is `keep`, `guests[].joined` says whether someone picked their name or put a hold down, `joinUrl` and
  `holdsOpenAt` are on the host view.
- **No deposit, no charge.** A friend who joined but never put a hold down cannot be charged (`no_deposit`); the host page shows them as
  "No deposit" after the event.

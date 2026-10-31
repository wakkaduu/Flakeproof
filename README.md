# ShowUp

> A deposit that costs you nothing if you show up.

**Status: day 1. Nothing here is a working product yet.** This README will be kept honest;
every claim below is labelled by what has actually been run.

## The idea

A host creates an event (a booked court, a restaurant table, tickets) that happens within
a few days. Each friend opens one link, no account, and approves a small deposit through
PayPal. The deposit is only **authorized**: a hold, nothing is charged.

After the event:

- Friends who showed up: their authorization is **voided**. They pay nothing.
- No-shows: their authorization is **captured**.
- The captured pot is **paid out** (PayPal Payouts) to the people who came.

Meant for events where a no-show costs the host real money. Not casual hangouts.
Because PayPal authorizations have a 3-day honor period, events are scoped to ~3 days out.

## How AI is used (planned, not built)

| Role | What it does | Model / service |
|---|---|---|
| RSVP agent | Reads pasted group-chat text, proposes guest list, details and deposit; asks when unsure | Claude via `@anthropic-ai/sdk` (model name from env var, to be filled in when built) |
| Judge | After the event, recommends capture or forgive per no-show, with a reason. **The host approves before any money moves.** | same |

The model only reads and recommends. Amounts, splits and rounding are plain code in integer cents.

## What works (honest table)

| Piece | State |
|---|---|
| PayPal sandbox spike: authorize, capture, void, payout | Script written, **not yet run against the real sandbox** |
| Server, state machine | Not started |
| Guest link page | Not started |
| RSVP agent | Not started |
| Judge + host approval | Not started |
| Tests with fake PayPal / fake AI | Not started |

## Sandbox only

This project uses the PayPal **sandbox** exclusively. No live credentials, no real money.
See [docs/sandbox-setup.md](docs/sandbox-setup.md) for accounts and credentials.

## Running the spike

```bash
cp .env.example .env     # then fill in sandbox credentials
npm run spike
```

Requires Node 22+. No dependencies to install for the spike.

## Unverified

The Official Rules of the hackathon have not been read by the author. Eligibility, IP and
legal terms are unchecked.

## License

MIT, see [LICENSE](LICENSE).

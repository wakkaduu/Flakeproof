# ShowUp

> A deposit that costs you nothing if you show up.

**Status: day 1 of building. The money flow works in the sandbox; there is no UI or AI yet.** This README will be kept honest;
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
PayPal honors an authorization for 3 days (valid 29, reauthorization not built). The host may pick any start time, but the app warns when an event is further out than the honor period, because capture may then be refused.

## How AI is used (planned, not built)

| Role | What it does | Model / service |
|---|---|---|
| RSVP agent | Reads pasted group-chat text, proposes guest list, details and deposit; asks when unsure | Claude via `@anthropic-ai/sdk` (model name from env var, to be filled in when built) |
| Judge | After the event, recommends capture or forgive per no-show, with a reason. **The host approves before any money moves.** | same |

The model only reads and recommends. Amounts, splits and rounding are plain code in integer cents.

## What works (honest table)

| Piece | State |
|---|---|
| PayPal sandbox spike: authorize, capture, void, payout | **Run against the real sandbox, all pass.** See [docs/spike-results.md](docs/spike-results.md) |
| Server: events, guests, deposits, state machine, host-approved settlement ([API](docs/api.md)) | Built. 54 automated tests pass against a **fake** PayPal. Against the real sandbox, only order creation and "not approved yet" were checked by hand; the full flow awaits `npm run e2e:sandbox` |
| Guest link page | Not started |
| RSVP agent | Not started |
| Judge + host approval | Not started |
| Tests with fake PayPal | Done (server). Fake AI: not started |

## Sandbox only

This project uses the PayPal **sandbox** exclusively. No live credentials, no real money.
See [docs/sandbox-setup.md](docs/sandbox-setup.md) for accounts and credentials.
**Use a United States business account (USD).** A non-US sandbox merchant converts currency and Payouts then fails with `INSUFFICIENT_FUNDS`.

PayPal charges fees even in sandbox, so the pot paid out is smaller than the sum of deposits. See the spike results.

## Run it

Requires Node 22+.

```bash
cp .env.example .env     # fill in PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox)
npm run setup            # install, generate Prisma client, create the SQLite database
npm test                 # 60 tests, no keys needed
npm run dev              # API on http://localhost:3001
```

Two scripts talk to the **real sandbox** and ask you to approve payments as a sandbox buyer:

```bash
npm run spike            # raw PayPal calls: authorize, capture, void, payout
npm run e2e:sandbox      # the whole server flow: 3 friends, 1 flakes, pot paid to the 2 who came
```

## Unverified

The Official Rules of the hackathon have not been read by the author. Eligibility, IP and
legal terms are unchecked.

## License

MIT, see [LICENSE](LICENSE).

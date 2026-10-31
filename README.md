# Flakeproof

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
| RSVP agent | Reads pasted group-chat text, proposes guest list, details and deposit; asks when unsure | Google Gemini API (`GEMINI_MODEL`, currently `gemini-3.5-flash-lite`) |
| Judge | After the event, recommends capture or forgive per no-show, with a reason. **The host approves before any money moves.** | same model |

The model only reads and recommends. Amounts, splits and rounding are plain code in integer cents.

## What works (honest table)

| Piece | State |
|---|---|
| PayPal sandbox spike: authorize, capture, void, payout | **Run against the real sandbox, all pass.** See [docs/spike-results.md](docs/spike-results.md) |
| Server: events, guests, deposits, state machine, host-approved settlement ([API](docs/api.md)) | Built. 60 automated tests pass against a **fake** PayPal, and `npm run e2e:sandbox` passes against the **real sandbox** (see [results](docs/spike-results.md)) |
| Guest link page (mobile-first React page: event, deposit, "Approve with PayPal", status) | Built. 17 component tests pass. **Not yet clicked through in a real browser against the sandbox**, that is the next manual check |
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
npm test                 # 78 tests (server + web), no keys needed
npm run dev              # API on :3001 and web app on http://localhost:5173
npm run dev:event        # in another terminal: creates a sample event, prints guest links
```

Open a guest link, press **Approve with PayPal**, and log in with a sandbox *personal* (buyer)
account in a private window. PayPal sends you back to the same page, which confirms the hold.

Single process (what a hosted demo would use): `npm run build`, then
`APP_BASE_URL=http://localhost:3001 npm start`, and open http://localhost:3001.
`APP_BASE_URL` must be the address people actually open, because guest links and PayPal's
return URLs are built from it.

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

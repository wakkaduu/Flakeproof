# Sandbox setup (accounts and credentials)

Everything here uses the PayPal **sandbox**. Never put live credentials anywhere.
Items marked **(unverified)** came from docs I could not fully confirm; the spike will tell.

## What you need

| # | What | Why |
|---|---|---|
| 1 | A PayPal developer account (developer.paypal.com) | Creates your sandbox automatically |
| 2 | Sandbox **Business** account (the default one is fine) | The merchant: receives captures, sends payouts |
| 3 | A **Merchant** REST app on that business account (Apps & Credentials -> Sandbox -> Create App, type *Merchant*) | Gives `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` |
| 4 | Sandbox **Personal** account "buyer" | Approves the deposits (plays the friend) |
| 5 | A second sandbox **Personal** account "recipient" | Receives the payout; its email is `SPIKE_PAYOUT_RECEIVER_EMAIL` |

Create extra accounts under Testing Tools -> Sandbox Accounts. **Use United States for all of them (USD).** This is required, not optional: a Philippines
business account converted the capture to PHP and the USD payout then failed with
`INSUFFICIENT_FUNDS`. The buyer must not be the merchant: PayPal won't
let an account pay itself.

For the later 3-minute demo (four friends, three show up) you will want 4 buyer-capable
personal accounts, three of which also receive the payout. Not needed for the spike.

## Steps

1. Create the Merchant app (item 3) and copy its Client ID and Secret.
2. **(unverified; the spike's payout worked without us finding this)** Payouts may need to be enabled on the app: open the app and look for
   *Features* (older dashboards list "Payouts" as a checkbox). PayPal's Payouts setup page
   describes enabling Payouts only for live accounts and says nothing specific for sandbox,
   so if the payout step fails with an authorization/permission error, this is the first
   place to look. Tell me the exact error.
3. The sandbox business account needs a USD balance for payouts. A new US business account
   had enough; a non-US one did not (see above).
4. `cp .env.example .env` and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `SPIKE_PAYOUT_RECEIVER_EMAIL`.
5. `npm run spike`. When it prints two links, open each in a **private window** and log in as
   the **buyer** sandbox account (not your real PayPal login), then approve. The script
   notices on its own and continues. After approval the browser lands on example.com; that
   is expected.

## Reading the result

The script prints a pasteable report with no secrets. Paste it back verbatim, including any
FAIL lines and `debug-id`s. A payout only counts as done when the payout **item** is SUCCESS.

## Known caveats

- **Fees:** the capture response includes PayPal's fee and net amount. If the fee is
  non-zero, the merchant receives less than the deposit, and paying out the full deposit
  would come out of the host's balance. The spike prints fee/net so we can decide the pot
  rule from real data (this touches money rules, so it needs your decision).
- **Button wording (observed on the sandbox):** after logging in, PayPal's final button says "Complete Purchase" even though only a hold is created. Our guest page says so up front.
- Authorization honor period is 3 days; valid 29 days; reauthorization is days 4-29. Sandbox
  authorizations are not observed to expire, so expiry can't be tested by waiting.

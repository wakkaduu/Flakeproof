# Spike results (real PayPal sandbox)

Run `d4cb0c07`, 2026-10-31, US Business merchant + US Personal buyer + US Personal recipient,
USD. Everything below was observed against `api-m.sandbox.paypal.com`, not assumed.

## Core flow: all pass

| Step | Observed |
|---|---|
| Create order, `intent: AUTHORIZE`, `payment_source.paypal.experience_context` | HTTP 200, order status `PAYER_ACTION_REQUIRED`, link rel `payer-action` |
| Buyer approves | Order status `APPROVED` (polling `GET /v2/checkout/orders/{id}` sees it) |
| `POST /orders/{id}/authorize` (`Prefer: return=representation`) | HTTP 201, authorization status `CREATED`, amount matches, `expiration_time` ~29 days out |
| Capture one authorization (`final_capture: true`) | HTTP 201, status `COMPLETED`, amount/currency match |
| Replay capture with the same `PayPal-Request-Id` | HTTP 200, same capture id (no double capture) |
| Void the other authorization | HTTP 204; `GET` afterwards shows `VOIDED` |
| Void an already-captured authorization | HTTP 422 `UNPROCESSABLE_ENTITY` / `PREVIOUSLY_CAPTURED` |
| `POST /v1/payments/payouts` to a personal sandbox email | HTTP 201, batch `PENDING` |
| Poll payout | Item `SUCCESS` while the batch was still `PROCESSING`; batch later `SUCCESS` |

## Findings that change the design

1. **Count the payout item, not the batch.** The item hit `SUCCESS` while the batch was
   still `PROCESSING`. The state machine must key on item status.
2. **Merchant account country/currency matters.** A first attempt with a Philippines
   sandbox business account converted the $5.00 capture to PHP, and the USD payout failed
   with `INSUFFICIENT_FUNDS`. A US business account in USD works. Judges setting up their
   own sandbox must use US accounts; the README must say so.
3. **Fees are real, even in sandbox, and the pot is smaller than the deposits.** On one
   $5.00 deposit:
   - capture fee `0.66` -> merchant nets `4.34`
   - payout fee `0.25` per item, charged to the sender on top of the `5.00` paid
   - the recipient received the full `5.00`; the host's balance covered `0.66 + 0.25`.
   The `0.66` is consistent with 3.49% + $0.49, but that is my inference from one data
   point, not a documented rate. The payout fee per item (`0.25`) is one observation.
   **Open decision (owner's call, touches money rules):** pot = sum of captured nets minus
   payout fees, or pay gross and let the host absorb fees, or something else.
4. **Idempotency works as designed.** Same request id returns 200 with the same object;
   keys derived from our own record ids are safe to retry.
5. **Approval wording.** PayPal's page is driven by `user_action: PAY_NOW`; the guest page
   should state clearly that this is a hold.

## Not yet verified

- Whether Payouts needed an explicit enable step on the app (it worked without anything
  I could point to, but I don't know what the account/app defaults were).
- Behaviour with many payout items in one batch, partial failures, `UNCLAIMED` (recipient
  with no PayPal account), or `ONHOLD`.
- Authorization expiry/reauthorization (sandbox cannot be tested by waiting).
- Webhooks (not used; we poll).

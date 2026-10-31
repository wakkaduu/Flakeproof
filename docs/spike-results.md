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

## Server end to end on the real sandbox (`npm run e2e:sandbox`)

2026-10-31. Three friends deposit $10.00 each (approved as one US sandbox buyer), two show,
one is a no-show and is captured, the net pot is paid to the two who came.

| Check | Observed |
|---|---|
| Showed up: deposits | both `voided` |
| No-show capture | `captured`, fee 84c, net 916c (3.49% + 49c on $10.00 = 84c) |
| Pot | 916c = the no-show's net |
| Payout items | 433c + 433c (916c - 2 x 25c reserved fee, split equally) |
| Item status | both `SUCCESS` while the batch still read `PROCESSING` |
| Payout fee | 50c actual = 50c reserved (25c per item, same as the earlier $5.00 observation) |
| Event | `settled` |

So the flat 25c payout fee per item now has two observations ($5.00 and $4.33 items). Still
sandbox data; live fees are not verified and not claimed.

## AI provider probe (Gemini, free tier key), 2026-10-31

Same RSVP chat (an ambiguous "Dee", a prompt-injection line, a $15 deposit) sent with a JSON
response schema, temperature 0:

| Model | Result |
|---|---|
| `gemini-2.5-flash`, `gemini-2.5-flash-lite` | 404: "no longer available to new users" |
| `gemini-3.5-flash-lite` | 1.1-1.6 s, valid JSON each of 4 runs, deposit 1500 each time, injection ignored each time. **But run 1 invented "Dee's sister" and "Priya: maybe" as guests**; runs 2-4 did not |
| `gemini-3.5-flash` | 9.5 s; also invented "Dee's sister" |
| `gemini-3.1-flash-lite` | 27 s; invented "Dee's sister" |
| `gemini-3.8-flash` | timed out at 50 s |
| `gemini-flash-latest` | 157 s (!); best answer, but unusable |

Conclusions: pick `gemini-3.5-flash-lite` for speed; free-tier latency varies wildly by model,
so every call needs a timeout; and **the model sometimes guesses people, so the app verifies
every proposed guest and amount against the chat text in code and the host reviews before any
link is sent.**

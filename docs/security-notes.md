# Security notes

Honest summary for a hackathon prototype that only ever touches the PayPal **sandbox**.

## What protects it

- **Sandbox only.** The PayPal host is hardcoded to the sandbox; there is no setting for a live host.
- **Secrets** live only in the server's environment (`.env`, gitignored). History was scanned for the
  PayPal client id/secret and the Gemini key: none present.
- **Capability links, no accounts.** Host and guest links carry 192-bit random tokens; host tokens are stored
  hashed. A guest link can only act for that guest.
- **The server decides amounts.** The browser never sends a price; holds, captures and payouts are checked
  against our own records, and mismatches are released or refused.
- **Idempotency.** Every PayPal mutation carries a request id derived from our own record, so retries and
  double clicks cannot double-charge or double-pay.
- **AI output is untrusted.** Every claim is verified against the pasted text in code; the model cannot move
  money; the host approves (see `docs/judge-design.md`).
- **Abuse limits.** Rate limits on event creation and on the AI route; `TRUST_PROXY` for hosted use.
- **Headers.** Strict CSP (self only, no inline script/style), `X-Frame-Options: DENY`, no-referrer, no-store.
- **No chat is stored.**

## The shared join link (Nov 3)

- It is a bearer link (192-bit) that only lets someone **add or claim a name**. It cannot read another friend's page, cannot see
  anyone's personal link, and cannot move money. Claiming a listed name is once-only, so a stranger who has the link could claim an
  unclaimed name before the real person does; the host sees every name and can remove one that has no hold.
- Rate limited per client (30 joins per minute), capped at `MAX_GUESTS` per event, names are case-insensitively unique, and joining
  closes at the start time. The personal link stays the credential; it is remembered on the friend's phone in `localStorage`
  (`flakeproof.joined`), validated on read, never trusted for anything but a redirect.
- Early release (`/g/:invite/cancel`) needs the friend's own link, runs under the event and guest locks, voids only that guest's hold
  with a request id derived from our deposit id, and cannot be used after the host has marked attendance or the event has ended.

## Known limits (accepted for the prototype)

- **No refund path.** The server refuses to capture money nobody could receive; if a capture still ends up
  unpayable, it is reported to the host as a problem. There is no automatic refund.
- **Single process, SQLite, in-memory locks and rate limits.** Fine for a demo, not for scale.
- **A lost host link cannot be recovered.** The browser remembers recent events as a convenience only.
- **`npm audit` reports 3 high findings**, all through the Prisma **CLI** (`@prisma/config` ->
  `deepmerge-ts`, stack exhaustion when merging recursive config objects). It runs at migrate/generate time,
  not in a request path, and the fix is a Prisma major upgrade (6 -> 7) that we chose not to take mid-build.
- **Free-tier AI:** Google may use free-tier prompts for product improvement. Use demo chats only.
- **PayPal fees are real even in the sandbox.** The estimate used for warnings (3.49% + 49c capture, 25c per
  payout item) comes from a few sandbox observations; live fees are not verified and not claimed.

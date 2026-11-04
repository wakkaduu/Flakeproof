# Realism review and feature research (Nov 3)

## Reality check: what normally happens in a friend group
We walked the whole story as a normal friend group would live it, and changed what was unrealistic. The earlier design assumed an
organised host and tidy friends; real groups are neither.

| Moment | What really happens | Was unrealistic in the old build | Now |
|---|---|---|---|
| Inviting | The host pastes **one** link into the group chat | One personal link per friend; the host copies and DMs each | One shared link; friends tap their name or type it; the page is remembered on their phone |
| Creating | "Sat 5pm, court, $15". Nobody screenshots 50 messages first | The first screen asked for a chat | A form is step 1; the AI chat reader is an optional shortcut |
| Timing | Plans are made 1 to 3 weeks ahead; PayPal honors a hold 3 days | Held at invite time, with only a warning | Joining any time; deposits open 3 days before the start; a calendar reminder for the friend and a ready reminder message for the chat |
| Money for the host | A host who paid for the court wants the court paid for. A $6 split of a $20 deposit, after fees, is not the point | The pot was always paid out | Host chooses: share with those who came, or keep it |
| Cancelling | People say "can't make it" in the chat, 3 hours before. Hosts of a booking need a day | A fixed 2 hour rule | A cutoff the host picks (default 1 day); a friend can release their own hold; later it only warns the host |
| Check-in | Most people came | One tap per person | "Everyone came", then the exceptions |
| Free riders | Someone joins, never puts money down, and shows up anyway (or not) | Not shown | After the event they appear as "No deposit": the app says plainly it cannot charge them, and the nudge message names who is missing before the event |
| Forgetting | The host forgets to press anything | Five steps | One "What's next" card with the real button in it; holds close by themselves at the start |
| Friends without PayPal | Some friends will not have PayPal | (unstated) | Stated as a known limit; PayPal's card checkout may cover some; not claimed |

Things we deliberately did **not** add because they would not survive contact with a real group: reliability scores per person
(accounts, social cost, PII), automatic charging without the host (friends would not forgive it), location or QR check-in as a second
authority (a second source of truth to argue about), and any real notification service (we have no accounts; the honest reminder is the
friend's own calendar and the host's own chat).

## What other tools lack, and what we built because of it

Research done by web search on Nov 3, 2026; the findings and their limits are stated plainly. Not exhaustive.

## What exists
- **Business deposit tools** (Swikly-style card holds, restaurant and salon booking apps, event no-show fees): a *merchant* takes a hold or a
  fee from a *customer*, and keeps it. Sources found describe guests who show up paying nothing and no-shows being charged.
  Nothing found is built for a group of friends, where the money should go to the people who came.
- **Commitment-contract apps** (stickK, Beeminder): stakes can go to a charity, an "anti-charity" or a friend, with an optional referee.
  Built for personal goals, not for a shared booking.
- **Reauthorization** (PayPal docs): a US authorization is honored for 3 days and valid for 29; it can be reauthorized once, between day 4
  and day 29, by void-and-recreate or the reauthorize call. Our "honor period" warning is correct. Reauthorization is not built because it
  cannot be shown in a 3-minute sandbox demo (it needs days to pass).

## Gaps we can honestly claim
1. Pot goes to the people who came, not to a merchant (already built: capture, then PayPal Payouts).
2. The AI reads *evidence* (the no-show's own message) and only suggests; the host decides (already built, tested on 15 adversarial cases).
3. **A fair way out for the friend** (built today): every deposit tool we found assumes the business decides. A friend can release their own
   hold before a cutoff that is shown to them in advance, which also gives the host the one thing they actually want: time to rebook.

## Considered and not built (with the reason)
| Idea | Verdict |
|---|---|
| MCP server so an agent can run the flow | Defer. Fits "agentic commerce" but cannot be shown in the video without displacing the core story, and our design rule is that the AI never moves money. |
| Reliability score across events | Drop. Needs accounts and personal history: more PII and rule risk than it earns. |
| QR / location check-in as evidence | Defer. Good idea, but a second evidence source needs its own abuse analysis. Candidate after submission. |
| Reauthorization for events more than 3 days out | Defer. Real, but undemonstrable in the sandbox window. The app warns instead. |
| AI-written reminders to friends | Drop. Low value; a template does the same. |

Sources: PayPal's authorization and reauthorize documentation (developer.paypal.com/checkout/extend-authorization, docs.paypal.ai/payments/methods/paypal/reauthorize); vendor pages for Swikly, Fresha, Appointo, Let's Get Offline; stickK and Beeminder write-ups.

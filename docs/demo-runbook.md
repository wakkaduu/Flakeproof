# Demo runbook (3 minutes, real running app)

Not a script yet (the video script comes after the host dashboard exists). This is what must be
true so the video can be shot without luck.

## Accounts to create once (PayPal sandbox, all United States / USD)

| Role | Count | Notes |
|---|---|---|
| Business (merchant) | 1 | Holds the Merchant app. Needs a USD balance (new US sandbox accounts had one) |
| Personal "Ana", "Ben", "Cy", "Dee" | 4 | Four **different** emails, so three payouts do not land in one inbox. |
| Host "Sam" | 0 | The host never pays; the host link is the key |

## Why it is tight

- Each guest must log in to PayPal's sandbox once: four logins.
- Payouts took about 20-30 s to reach SUCCESS in our runs.
- The cap is 3 minutes. Plan cuts, not speed.

Pre-log-in each buyer in its own browser profile (or private window) before recording, so the video shows
the approval screen, not typing passwords. Keep the host in a separate window.

## Beat sheet (target 2:50)

| Time | Beat | Shows |
|---|---|---|
| 0:00-0:15 | The problem: a booked court, a friend who flakes | One line of voiceover, app home |
| 0:15-0:45 | Paste chat, AI reads it, host reviews | The "sister" question and the dropped invented guest, deposit verified from the organizer's message |
| 0:45-1:15 | Four friends approve a hold on PayPal | Hold messages; "nothing is charged" (cut between logins) |
| 1:15-1:30 | "Event ended", mark who came | Host page |
| 1:30-2:00 | The Judge reads the excuse | Recommendation with the quote; host clicks, nothing pre-selected |
| 2:00-2:30 | Settle: three voids, one capture, payout to the three | Payout items reaching SUCCESS (cut the wait) |
| 2:30-2:50 | Phone view | "You paid nothing" / "You received $X" |

## Rehearsal checklist

1. `rm server/prisma/dev.db && npm run db:deploy -w server` for a clean database.
2. `npm run dev`; open the app; run the full story once with the four accounts.
3. Time each beat; anything over its slot gets a cut or a pre-made state.
4. Check the PayPal pages in the footage only show PayPal screens incidentally (no logos in our own UI).
5. No copyrighted music. Record the screen of the device the app was built for.

## Schedule (confirmed by the Official Rules: submissions close **Nov 12, 2026, 12:00 pm Pacific = Nov 13, 04:00 in UTC+8**; we submit by **Nov 11**)

| Dates | Work |
|---|---|
| Nov 1-3 | Step 5: host dashboard, check-ins, the Judge, host approval (Design is a fifth of the score: build the dashboard properly) |
| Nov 4 | Full real-sandbox run with the four accounts; fix what breaks |
| Nov 5-6 | README polish, screenshots, Devpost text, video script |
| Nov 7 | Feature freeze. Rehearse |
| Nov 8-9 | Record and upload the video (public on YouTube) |
| Nov 10-11 | Buffer, clean-clone check, submit |

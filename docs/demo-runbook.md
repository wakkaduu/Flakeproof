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
| 0:15-0:45 | Add the chat as screenshots (decoy chat, see below), AI reads it, host checks the transcript, then reviews | The "sister" question and the dropped invented guest, deposit verified from the organizer's message |
| 0:45-1:15 | The host copies the ONE chat message; four friends open the same link, tap their name, approve a hold on PayPal | The join page, then the hold confirmed; "nothing is charged" (cut between logins) |
| 1:15-1:30 | "Event ended", mark who came | Host page |
| 1:30-2:00 | The Judge reads the excuse | Recommendation with the quote; host clicks, nothing pre-selected |
| 2:00-2:30 | Settle: three voids, one capture, payout to the three | Payout items reaching SUCCESS (cut the wait) |
| 2:30-2:50 | Phone view | "You paid nothing" / "You received $X" |

## Rehearsal checklist

1. `rm server/prisma/dev.db && npm run db:deploy -w server` for a clean database.
2. `npm run dev`; open the app; run the full story once with the four accounts. The host creates the event from the plain form (no chat reading needed), copies the message, and each buyer opens the same `/e/...` link in its own private window and taps or types a name. Also try: one friend releasing their own spot, a host who chooses "keep" instead of "share", and an event a week away (deposits not open yet).
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

## Decisions made on Oct 31

**Hosted demo URL: not now; decide at the Nov 8 gate.** The Rules accept a repo with complete run instructions, and judges
may judge from the text, images and video alone. A hosted demo would need our PayPal and Gemini keys on a server, would burn
a free-tier AI quota anyone can spend, and must stay up until Dec 15. Instead we make the repo easy to run and give judges a
test pack (below). If time remains after the video, Render (a listed sponsor tool) is the likeliest host.

**Judge test pack.** The Devpost testing-instructions field gets: the four sandbox buyer logins (fake money), a pointer to
`docs/sandbox-setup.md` for creating a free Merchant app, and the Gemini key link. **No secret goes in the public repo.** If we
decide to share our sandbox merchant secret, it goes only in that private field and is rotated after Dec 15.

**Public repo.** `git@github.com:wakkaduu/flakeproof.git` is configured as `origin`. The repo must be created first (empty,
public, **no** README or licence added by GitHub, since we already have them). Commit emails were switched to the GitHub no-reply
address before anything was published. Run `npm run status` after pushing: it checks the repo is public and that GitHub detects MIT.

## Video: Remotion and ElevenLabs

- **Real footage is required.** The Rules ask for "footage that shows the Project functioning on the device for which it was built",
  and the Presentation criterion is "working end to end". Use Remotion for titles, captions, zooms and transitions **around** real
  screen recordings of the running app, never as an animated imitation of it.
- **Remotion** is free for individuals and teams of up to 3 (it states this in its licence; Remotion 5.0 may change the terms, so
  re-check). Its licence is not an OSI open-source licence, so keep it **out of this repo's `npm install`**: put the video project
  in a separate folder or repo, not in the workspaces, so judges install nothing extra.
- **ElevenLabs:** its help centre says the **free plan has no commercial licence**, and attribution does not change that. A
  prize contest where PayPal and Devpost may reuse the video is not clearly non-commercial, so generate the final narration on a
  **paid plan** (check the current price) while subscribed, keep the receipt, use a stock voice (do not clone yours), and say
  "narration: ElevenLabs" in the video description.
- **Voice rule.** Entrants consent to PayPal/Devpost using their voice in promotion for 3 years. A synthetic voice avoids using
  yours. Captions are still needed for accessibility.
- No third-party music. Do not show Google or Gemini logos in the footage.

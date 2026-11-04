# Demo video storyboard (target 2:53, hard cap 3:00)

Status as of Oct 31: **storyboard, the Remotion/ElevenLabs pipeline and the footage for beats 1 and 2 exist** (recorded from the real
app with the real AI model by `npm run record:a`). **Beats 3 to 7 are not recorded**: they need real PayPal holds, so they wait for the
sandbox run with the four buyer accounts. Draft narration exists but was made on the ElevenLabs free plan and must be regenerated on a paid plan. The video project lives **outside this repo** (`/home/wakkadu/Paypal-video`, not an npm workspace)
because Remotion's licence is not OSI open source (see [demo-runbook.md](demo-runbook.md)). The script of record is
`src/storyboard.json` in that folder; this page mirrors it for people reading the repo.

## What the Rules force

- Footage of the **real app running** on the device it was built for. Remotion only adds titles, captions and zooms around it.
- Under 3:00, public on YouTube, link in the form.
- No third-party trademarks or copyrighted music. No music at all. Chat shown is the made-up decoy chat
  ([screenshots.md](screenshots.md)). We draw no PayPal, Google or Gemini logos; PayPal's own pages appear only as the working product.
- Narration: ElevenLabs on a **paid** plan (free plan has no commercial licence), a **stock voice**, not a clone. Captions are
  burned in too. Say "narration: ElevenLabs" in the YouTube description.
- The footage must show **PayPal's real sandbox approval** for the holds. A fake PayPal in the footage would be a mockup of the
  product's central feature.

## Beats

| # | Time | Shot (what the viewer sees) | Footage source | Narration (spoken) | Footage state |
|---|---|---|---|---|---|
| 1 | 0:00-0:15 | Empty "new event" page; title card "Flakeproof: a deposit that costs you nothing if you show up" fades after 4 s | Real app, empty home | "You book a court for Sunday. Five friends say they're in. One doesn't show, and you pay for a spot nobody used. Flakeproof: a deposit that costs you nothing if you show up." | **Recorded** |
| 2 | 0:15-0:50 | Phone-width window. Seven decoy-chat screenshots go in, transcript appears with amounts highlighted, host checks it, review shows Sunday 5 pm, $20, four friends | Real server + **real Gemini** | "The plan is buried in a group chat. The host adds screenshots of it, and the AI reads them into a transcript that the host checks. Then it finds the plan: Sunday at five, twenty dollars each. It leaves out the gossip and the friend who dropped out, and flags the other amounts it saw, so the host can check the deposit." | **Recorded** (real Gemini; the AI waits are sped up 8x, and the speed-up is applied in the render) |
| 3 | 0:50-1:20 | Host copies the one message for the group chat; four phones open the same link and tap their names: Approve with PayPal, PayPal sandbox approval, back to "You're in" | **Real PayPal sandbox**, four buyer accounts | "The host pastes one link into the group chat. Everyone taps their name. No account needed. They approve a hold on PayPal, in the PayPal sandbox. Nothing is charged. The money is only reserved, and it's released if they show up. Four friends, four holds." | To record; **needs the four sandbox logins (Nov 4 run)** |
| 4 | 1:20-1:32 | Host taps End event, then Everyone came, then Didn't come for one person | Real app | "The event ends. Everyone came, except one." | To record |
| 5 | 1:32-2:05 | Host pastes the after-event chat, "Get AI suggestions", card "AI suggests Charge" quoting "lol overslept, my bad"; nothing pre-selected; host clicks Charge | Real app + real Gemini | "Cy didn't come. The host can paste the chat from after the event, and the AI reads Cy's own words: lol overslept, my bad. It suggests a charge, and quotes the message. But it only suggests. Nothing is selected until the host decides. If a message tries to give the AI orders, it's flagged and the host decides." | To record |
| 6 | 2:05-2:35 | Payout preview, Approve and settle, holds released, one charged, payout items reach SUCCESS (wait cut), "All done" card | **Real PayPal sandbox** | "The host approves. Three holds are released: those friends pay nothing. One deposit is charged. And what's left after PayPal's fees is paid out to the three who came, straight to their PayPal accounts." | To record |
| 7 | 2:35-2:53 | Phone-width guest pages: "You paid nothing", "You received $X". End card: Flakeproof, "PayPal sandbox, fake money only" | Real app | "Friends see it on their phones: you paid nothing, or you received money. Show up, pay nothing. Don't, and the people who came get paid. Flakeproof, built on the PayPal sandbox. Fake money only." | To record |

Judging-criteria coverage: Technological Implementation (beats 3, 5, 6: authorize, void, capture, payout, AI that cannot move money),
Design (2, 5, 7: a complete host-to-friend experience), Impact (1 states the problem and audience), Innovation (5: AI evidence,
human decision), Presentation (end to end in one run, a "Sandbox, fake money only" badge on every beat).

## Things to verify before the final render

1. **Narration against footage.** Names ("Cy"), the quote and the "friend who dropped out" come from the decoy chat and the dev sample;
   change the words if the recorded run differs.
2. **No dollar amounts in narration except the $20 deposit.** The payout figures on screen come from PayPal's real sandbox fees,
   which may differ from the fake PayPal's (3.49% + 49c, 25c per payout). Show them as captions from the footage, not as spoken numbers.
3. **Stand-in footage must not be used for beats 3 and 6.** The README already labels the host-dashboard screenshots as made with an
   in-memory PayPal; the video cannot do that.
4. `npm run check:final` in the video folder passes (length, pace, audio fits its slot, no missing clips).

## Which beats can be recorded without PayPal

Only beats 1 and 2. The AI Judge (5) only appears for a no-show who has a **hold**, the settlement (6) and the friends' result pages (7)
need captured and paid money, and showing "Hold in place" in beat 4 needs a real approval. So beats 3 to 7 are one continuous run on the
real sandbox with the four buyer accounts, recorded after the Nov 4 run. The recorder for that stage is not written yet: it should drive
our own pages and leave PayPal's login and approval screens to the person (selectors on PayPal's pages cannot be tested here).

Notes from the recording of beats 1 and 2:
- The decoy chat's day labels are shifted by the recorder so "Sunday" is the coming Sunday. Otherwise the app, correctly, warns that
  the event is more than 3 days away (PayPal's hold period). **Record on a Thursday to Saturday**, or that warning appears in the footage.
- The AI waits varied between 10 s and 30 s across runs; the footage shows the real "Reading... 3 of 7 done" progress, sped up.
- The model sometimes reads the same message twice with different emoji descriptions (one duplicate "no [laughing]..." line appeared in
  one run). The host check step exists for exactly this; leave it in the footage rather than hiding it.

## How the video gets made

```bash
cd /home/wakkadu/Paypal-video
cp .env.example .env                 # add ELEVENLABS_API_KEY (paid plan)
npm run narrate -- --dry             # about 1,450 characters in total; calls nothing
npm run narrate                      # one mp3 per beat into public/audio (paid plan for the final)
npm run record:a                     # beats 1 and 2 from the real app (needs this repo's .env with GEMINI_API_KEY; port 3101)
# beats 3 to 7: record after the sandbox run into public/clips/ (names are in src/storyboard.json)
npm run check:final
npm run studio                       # preview; npm run render writes out/flakeproof-demo.mp4
```

Missing footage renders as a loud striped "DRAFT: FOOTAGE NEEDED" slate, so a draft cannot be mistaken for the final.


## Changes made Nov 3 (read before recording beats 3 to 7)
The app changed after the beats above were written: the host now creates the event from a plain form (beats 1 and 2 recorded the
older chat-first screen, which still exists as the "Fill it in from the group chat" shortcut, so beat 2 stays valid but now starts by
pressing that button), friends use ONE shared link, the screens were redesigned, check-in has "Everyone came", and the host can choose
to keep a no-show's deposit. Re-check every narration line against the new screens before the final render; the storyboard rows above
were updated for beats 3 and 4 only.

# Adding the chat as screenshots

Pasting 50+ messages from a phone is not something anyone does. So the host can give Flakeproof 1 to 8 screenshots
of the chat instead. The host's own name is asked once, because their bubbles (on the right) carry no name.

```
screenshots ──> one AI read per image ──> merge in code ──> HOST CHECKS AND EDITS THE TEXT ──> the RSVP agent (unchanged)
 (shrunk on     POST /api/rsvp/screenshot   POST /api/rsvp/transcript   amounts, days, times highlighted      verifier as before
  the device)   one call per screenshot     no AI                        to compare with the screenshots
```

- The model only **reads pixels into messages**. Cleaning its output, stitching overlapping screenshots and writing the
  transcript are plain code (`server/src/ai/transcribe.ts`).
- Code cannot check a digit against a picture, so **the host is the check**. The transcript step shows the lines that
  state an amount, day or time (amounts first) with the amount or time marked. The text the RSVP agent reads is the
  host's edited text, never the raw reading.
- Reordering or removing a screenshot costs no AI call (merging is a separate request), and one failed screenshot
  shows its own "Try again" without redoing the others.
- Images live only in the request: nothing is stored or logged, and the browser shrinks them to 900 px wide JPEG first.

## Why one call per image

A spike on a fabricated chat of 52 messages in 7 phone screenshots (overlapping, bubbles cut off at the edges, sender
name printed only at the start of a run):

| Approach | Result |
|---|---|
| All 7 images in one call | 45 of 52 lines exact. It kept a **cut-off copy of the deposit message** ("...so nobody") and corrupted emoji. Rejected |
| One call per image, merged in code (flash-lite) | 52 of 52 on clean PNGs; 50 to 51 of 52 on JPEG at 640 px and on different cut points |
| Same, `gemini-3.5-flash` | 51 of 51 visible lines on the hardest variant, including a short abbreviation ("np") that flash-lite read as "yep" |

So reading uses the larger model by default (`GEMINI_VISION_MODEL`), falling over to the smaller one when it is
overloaded for that call (the next call tries the larger one again).

## What the real pipeline did (real server, real Gemini, the app's own 900 px JPEGs)

| Configuration | Runs | Transcript | Final plan from the RSVP agent |
|---|---|---|---|
| Merge that needed the whole start of a screenshot to match | 2 | 51 of 52 lines, but 4 then 10 **extra** lines and false "no overlap" warnings | correct |
| After switching to sequence alignment (garbled first bubbles can no longer break it) | 3 | 52, 50 and 50 of 52; no duplicates, no false warnings. The misses were all **emoji**, which the model sometimes returned as garbage characters | correct |
| After describing emoji in words (`[thumbs up]`) | 3 | 52 of 52 twice; the third run hit the free-tier quota (429) and could not finish | correct in both completed runs |

The "final plan" was Sunday 5 pm and a $20 deposit, after the chat first said Saturday 6 pm and $15, mentioned a $40
court fee, a $1500 rent and a "$1000 each" joke. That is one fabricated chat: it shows the pipeline works, not that
every messy chat is read correctly. Small sample, and the model is not deterministic.

## What it still gets wrong

- **Free-tier quota.** Reading is one call per screenshot, so a burst of runs can hit `429`. The app says so and offers
  "Try again" per screenshot. 7 screenshots took 14 to 35 s depending on load.
- **A word the model "corrects"** (it read "np" as "yep" once, on the smaller model). That is why the host reads the transcript.
- **A cut-off bubble at the bottom edge** with no copy in the next screenshot stays as a stray line. A missing
  overlap is reported ("Screenshot 3 and screenshot 4 share no message"), but the reverse, a stray line, is only visible to the host.
- **One-to-one chats** print no sender name on the left, so those messages become "Unknown" (the RSVP agent never accepts "Unknown" as a guest).
- **Relative day labels** ("Today") are kept as written; they cannot be turned into dates without knowing when the screenshot was taken.
- It needs a screenshot the browser can open (PNG or JPG). A HEIC photo is refused with a message.

## Decoy chats for the demo video

The Rules ban third-party trademarks in the video, so the demo uses a made-up chat drawn with **no logo, app name or
app colours**: `node scripts/decoy-chat/render.mjs out/` writes `shot1.png`, `shot2.png`, ... from
[`scripts/decoy-chat/chat.mjs`](../scripts/decoy-chat/chat.mjs) (needs any Chrome or Chromium; no Python, nothing added to `npm install`).
Edit that file for a shorter or different story. Nobody's real messages are used anywhere in the repo.

Privacy for real use: screenshots are sent to Google's Gemini API to be read (Google's terms for the key's plan apply;
the free tier's terms are not verified here), so the app asks hosts to crop out phone numbers and to use a demo chat.

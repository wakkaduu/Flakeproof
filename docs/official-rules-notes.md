# Official Rules: what they mean for Flakeproof

Read from the Official Rules text (Devpost, pasted by the author on Oct 31, 2026). This is a working
summary, not legal advice; the Rules themselves control. Re-read them before submitting, since Devpost
may amend them.

## Dates (all confirmed from the Rules)

| What | When |
|---|---|
| Submission period ends | **Thu Nov 12, 2026, 12:00 pm Pacific Time** (= Nov 12 20:00 UTC = **Nov 13, 04:00 in UTC+8**, 01:30 in IST) |
| Judging | Dec 1 (2:00 pm PT) to Dec 15 (8:00 am PT) |
| Winners | around Dec 21 |
| After the period ends | **No edits to the submission.** Only the sponsor may allow removal of infringing or personal material |

Internal target: submit by **Nov 11**. The project must stay available and free to test **until Dec 15**.

## How we are judged (five equal criteria, after a pass/fail "fits the theme" gate)

| Criterion | What it asks | Where we stand |
|---|---|---|
| Technological Implementation | Thorough, skilled use of PayPal **and** AI; a working, non-trivial implementation | Strong on PayPal (authorize, void, capture, payouts; proven on the sandbox). AI is half-done: the RSVP agent works; the Judge is not built |
| Design | "A complete, coherent product experience, not just a technical proof of concept" | **Not complete: there is no host dashboard yet.** This is a fifth of the score, so UI polish is not optional |
| Potential Impact | A credible, **specific** case for a real problem and a real audience | Needs a sharp pitch: who loses money to no-shows (court and table bookings, tickets, split rentals) |
| Innovation / Idea | Novel, different from existing ideas | Holds-not-charges plus the pot going to the people who came; AI that reads the chat |
| Presentation | The video shows it working **end to end**; clear problem, audience, why it matters | The 3-minute video is the main evidence. It must include the Judge and the payout |

Judging may also use automated AI analysis, so a clear README and repo matter.

## Prize categories worth aiming at

"Best Use of PayPal + AI" fits us (the AI recommendation drives a real capture and payout).
"Best Demo Delivery" and "Most Impactful" depend on the video and pitch. One project can win a Grand
Prize or a Honorable Mention, not both, plus at most one sponsor prize. Sponsor tools are optional; we use none.

## Submission checklist (Rules, section 4)

| Requirement | Status |
|---|---|
| Integrates PayPal's platform using the free sandbox, central to the project | Done and proven |
| Meaningfully uses an AI tool | RSVP agent done; Judge pending |
| Newly created during the period, or significantly updated | New project; first commit Oct 31, inside the period |
| Text description of features and functionality | To write (Devpost) |
| **Functional demo**: judges can build and run it from the repo, or a hosted URL. A mockup does not count | Setup instructions exist and a clean clone was verified. Decision pending: hosted URL (see below) |
| Public repository on GitHub/GitLab/Bitbucket with all source, assets and instructions | **Not pushed yet.** Create a public repo and push |
| Open-source license **detectable and visible in the repo's About section** | MIT file is present; verify GitHub shows it after the first push |
| Video: under 3 minutes, shows the app running on its device, **public on YouTube**, link in the form | To record |
| Video: **no third-party trademarks or copyrighted music or other material** without permission | Plan: no music (or only music we made), no logos of our own; PayPal's pages appear only as the working product. PayPal is the sponsor; Google/Gemini marks should not appear in the footage |
| Original work, solely owned, not infringing | Yes. Dependencies are open source: a scan of the 103 runtime packages found only MIT, Apache-2.0, ISC and BSD |
| English materials | Yes |
| Test access: "any test account credentials, API keys, or sandbox login details necessary to run and test", or clear instructions to obtain them | The README explains how to get them (15 minutes). Easier for judges: put the four sandbox buyer logins in the Devpost testing-instructions field. **Do not** put the merchant secret or any key in the public repo |
| Keep it free and unrestricted for testing until Dec 15 | Yes for the repo. Anything hosted must stay up that long |
| Platform: runs on the platform it says it targets | State it on the form: web app (desktop and mobile browsers), Node 22+ |

## Things to decide or watch

- **Hosted demo URL.** The Rules accept a repo with run instructions, and judges "may judge based solely on the
  text description, images, and video". A hosted demo removes the 15-minute setup, but it needs our keys on a
  server, a free-tier Gemini quota that can run out, and uptime until Dec 15. Render is a listed sponsor tool
  with its own prize and would suit it; this is optional and undecided.
- **Model availability for judges.** Google already stopped offering `gemini-2.5-flash` to new accounts. By December
  a judge's new key may not support `gemini-3.5-flash-lite`. Plan: a model fallback chain, and the README shows the
  one-line command that lists the models a key can use.
- **Your voice and likeness.** Entrants consent to the sponsor and Devpost using their name, likeness and voice in
  promotion for three years. If you narrate the video, your voice may be used. Captions only avoids that.
- **Eligibility.** Individuals at the age of majority where they live, and solo entry is allowed. The Rules exclude
  residents of places where US or local law prohibits taking part or receiving a prize (they name Brazil, Quebec,
  Russia, Crimea, Cuba, Iran and North Korea, and any country comprehensively sanctioned by OFAC). Check that this
  does not apply to you. Winners need identity verification and tax forms.
- **Disputes.** Entering binds you to arbitration under American Arbitration Association rules and New York law.
- **Pooled deposits.** The Rules do not mention money transmission or pooled funds, and they only ask for a sandbox
  integration. Whether such a service could run for real money is a separate legal question we have not assessed;
  the README says sandbox only and does not claim otherwise.

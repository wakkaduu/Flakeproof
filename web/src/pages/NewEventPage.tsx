import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, hostApi, type CreatedEvent, type HostApi, type RsvpProposal } from '../api';
import { ScreenshotInput } from '../components/ScreenshotInput';
import { Avatar, Banner, btnPrimary, btnQuiet, btnSecondary, Card, fieldInput, Icon, Page } from '../components/ui';
import { inviteMessage } from '../lib/messages';
import { centsToDollars, parseDollars } from '../lib/money';
import { formatMoney } from '../lib/format';
import { rememberEvent } from '../lib/recentEvents';
import { useTitle } from '../lib/useTitle';
import { flagLines, highlight } from '../lib/transcript';
import { useScreenshotReader } from '../lib/useScreenshotReader';
import type { PreparedImage } from '../lib/images';

const MAX_CHARS = 16_000; // mirrors the server limit; the server enforces it
const MAX_GUESTS = 12; // mirrors the server limit
const HONOR_DAYS = 3;

/** paste = choose how to give the chat; transcript = check what was read from screenshots; reading = the AI is working. */
type Step = 'form' | 'paste' | 'transcript' | 'reading' | 'created';
type Mode = 'shots' | 'text';
interface GuestRow { key: number; name: string; checked: boolean; rsvp: 'in' | 'maybe' | 'out' | 'added'; source: 'author' | 'mentioned' | 'added'; evidence: string }

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const localNowString = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

interface Props {
  api?: HostApi;
  copy?: (text: string) => Promise<void>;
  /** Tests only: the real one needs a browser canvas. */
  prepareImage?: (file: File) => Promise<PreparedImage>;
}

export function NewEventPage({ api = hostApi, copy = (t) => navigator.clipboard.writeText(t), prepareImage }: Props) {
  const [step, setStep] = useState<Step>('form');
  const [filled, setFilled] = useState(false);
  // Screenshots are the phone-first way in; pasting text stays for people who already have it.
  const [mode, setMode] = useState<Mode>('shots');
  const [chat, setChat] = useState('');
  const [hostName, setHostName] = useState('');
  const [transcriptWarnings, setTranscriptWarnings] = useState<string[]>([]);
  /** Where "back" goes from the review step, and where an AI failure drops you. */
  const [source, setSource] = useState<'paste' | 'transcript'>('paste');
  const [aiError, setAiError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<RsvpProposal | null>(null);
  const reader = useScreenshotReader(api, prepareImage);

  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [deposit, setDeposit] = useState('');
  const [graceHours, setGraceHours] = useState(24);
  const [potMode, setPotMode] = useState<'share' | 'keep'>('share');
  const [rows, setRows] = useState<GuestRow[]>([]);
  const nextKey = useRef(1);

  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedEvent | null>(null);
  useTitle(created ? 'Event ready' : 'New event');

  async function readChat(from: 'paste' | 'transcript') {
    setAiError(null);
    setSource(from);
    setStep('reading');
    try {
      const p = await api.parseRsvp(chat, browserZone());
      applyProposal(p);
    } catch (e) {
      setAiError((e as ApiError).message);
      setStep(from);
    }
  }

  /** Reads the screenshots that are not read yet, then builds the transcript for the host to check. */
  async function readScreenshots() {
    setAiError(null);
    if (!hostName.trim()) { setAiError('Type your name as your friends see it, so your own messages (on the right) can be labelled.'); return; }
    if (!(await reader.readAll())) return; // a failed screenshot shows its own message and a Try again button
    try {
      const a = await reader.assemble(hostName.trim());
      setChat(a.chat);
      setTranscriptWarnings(a.warnings);
      setStep('transcript');
    } catch (e) {
      setAiError((e as ApiError).message);
    }
  }

  function applyProposal(p: RsvpProposal | null) {
    setProposal(p);
    setTitle(p?.title ?? '');
    setStartsAt(p?.startsAtLocal ?? '');
    setDeposit(p?.depositCents ? centsToDollars(p.depositCents) : '');
    setRows((p?.guests ?? []).map((g) => ({ key: nextKey.current++, name: g.name, checked: g.rsvp === 'in', rsvp: g.rsvp, source: g.source, evidence: g.evidence })));
    setErrors([]);
    setFilled(p !== null);
    setStep('form');
  }

  const depositCents = parseDollars(deposit);
  const chosen = rows.filter((r) => r.checked && r.name.trim());
  const farAway = startsAt !== '' && new Date(startsAt).getTime() - Date.now() > HONOR_DAYS * 86_400_000;

  function validate(): string[] {
    const out: string[] = [];
    if (!title.trim()) out.push('Give the event a name.');
    if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) out.push('Pick when the event starts.');
    else if (new Date(startsAt).getTime() <= Date.now()) out.push('The start time must be in the future.');
    if (depositCents === null) out.push('Enter the deposit as a dollar amount, like 15 or 15.50.');
    else if (depositCents < 1) out.push('The deposit must be more than $0.');
    if (chosen.length > MAX_GUESTS) out.push(`An event can have at most ${MAX_GUESTS} people.`);
    const names = chosen.map((r) => r.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) out.push('Two people have the same name. Make the names different so everyone can tell them apart.');
    return out;
  }

  async function create() {
    if (submitting) return;
    const problems = validate();
    setErrors(problems);
    if (problems.length) return;
    setSubmitting(true);
    try {
      const res = await api.createEvent({
        title: title.trim(),
        startsAt: new Date(startsAt).toISOString(),
        depositCents: depositCents!,
        ...(chosen.length ? { guests: chosen.map((r) => ({ name: r.name.trim() })) } : {}),
        graceHours,
        potMode,
      });
      rememberEvent(res.event.title, res.hostUrl);
      setCreated(res);
      setStep('created');
    } catch (e) {
      setErrors([(e as ApiError).message]);
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'created' && created) return <Created created={created} depositCents={depositCents!} startsAt={startsAt} graceHours={graceHours} potMode={potMode} copy={copy} />;

  return (
    <Page>
      <h1 className="text-3xl font-bold tracking-tight">New event</h1>

      {(step === 'paste' || (step === 'reading' && source === 'paste')) && (
        <section aria-labelledby="paste-h" className="mt-5">
          <h2 id="paste-h" className="text-lg font-semibold">Add your group chat</h2>
          <p className="mt-1 text-ink-soft">You check everything before the event is made.</p>

          <div role="group" aria-label="How to add the chat" className="mt-4 grid grid-cols-2 gap-1 rounded-2xl bg-stone-100 p-1">
            {([['shots', 'Screenshots'], ['text', 'Paste text']] as const).map(([m, label]) => (
              <button
                key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setAiError(null); }}
                className={`min-h-11 rounded-xl px-3 text-base font-medium focus-visible:outline-2 focus-visible:outline-brand-600 ${mode === m ? 'bg-white shadow-card' : 'text-ink-soft'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'shots' && (
            <ScreenshotInput reader={reader} hostName={hostName} onHostName={setHostName} onRead={readScreenshots} error={aiError} />
          )}

          {mode === 'text' && (
            <>
              <label htmlFor="chat" className="mt-4 block text-sm font-medium">Group chat</label>
              <textarea
                id="chat" value={chat} onChange={(e) => setChat(e.target.value)} rows={9} maxLength={MAX_CHARS}
                placeholder={'Sam: court booked Saturday 6pm, $15 deposit each\nAna: I\'m in!\nBen: maybe'}
                className="mt-1 w-full rounded-2xl border border-line bg-white p-3 text-base shadow-card focus-visible:outline-2 focus-visible:outline-brand-600"
              />
              <p className="mt-1 text-xs text-ink-soft">{chat.length}/{MAX_CHARS}. Sent to Gemini to be read. Use a demo chat.</p>
              {aiError && <Alert>{aiError}</Alert>}
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <button type="button" onClick={() => void readChat('paste')} disabled={step === 'reading' || !chat.trim()} className={primary}>
                  {step === 'reading' ? 'Reading the chat…' : 'Read the chat'}
                </button>
              </div>
            </>
          )}
          <div className="mt-3">
            <button type="button" onClick={() => setStep('form')} disabled={step === 'reading' || reader.busy} className={secondary}>Back to the form, I'll type it</button>
          </div>
          <p role="status" className="sr-only">{step === 'reading' ? 'Reading the chat' : ''}</p>
        </section>
      )}

      {(step === 'transcript' || (step === 'reading' && source === 'transcript')) && (
        <section aria-labelledby="transcript-h" className="mt-5">
          <h2 id="transcript-h" className="text-lg font-semibold">Check what was read</h2>
          <p className="mt-1 text-ink-soft">
            Compare with your screenshots. Fix any wrong amount, day, time or name.
          </p>
          {transcriptWarnings.length > 0 && (
            <aside className="mt-3 rounded-2xl border border-hold-100 bg-hold-50 p-4 text-hold-800" aria-labelledby="tw-h">
              <h3 id="tw-h" className="font-semibold">Look at this first</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5">{transcriptWarnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </aside>
          )}
          <FlaggedLines chat={chat} />
          <label htmlFor="transcript" className="mt-4 block text-sm font-medium">Transcript</label>
          <textarea
            id="transcript" value={chat} onChange={(e) => setChat(e.target.value)} rows={12} maxLength={MAX_CHARS}
            className="mt-1 w-full rounded-2xl border border-line bg-white p-3 text-base shadow-card focus-visible:outline-2 focus-visible:outline-brand-600"
          />
          <p className="mt-1 text-xs text-ink-soft">{chat.length}/{MAX_CHARS}</p>
          {aiError && <Alert>{aiError}</Alert>}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => void readChat('transcript')} disabled={step === 'reading' || !chat.trim()} className={primary}>
              {step === 'reading' ? 'Reading the chat…' : 'Read the chat'}
            </button>
            <button type="button" onClick={() => setStep('paste')} disabled={step === 'reading'} className={secondary}>Back to screenshots</button>
          </div>
          <p role="status" className="sr-only">{step === 'reading' ? 'Reading the chat' : ''}</p>
        </section>
      )}

      {step === 'form' && (
        <section aria-labelledby="review-h" className="mt-5">
          <h2 id="review-h" className="sr-only">Event details</h2>

          {!filled && (
            <button type="button" onClick={() => setStep('paste')} className={`${secondary} mt-4 w-full`}><Icon name="sparkle" className="size-4 text-brand-700" />Fill it in from the group chat</button>
          )}
          {filled && (
            <div className="mt-4">
              <Banner tone="info">Filled in from your chat. Check the details below.</Banner>
              <button type="button" onClick={() => setStep(source)} className={btnQuiet}>Back to the chat</button>
            </div>
          )}

          {proposal && proposal.questions.length > 0 && (
            <aside className="mt-3 rounded-2xl border border-hold-100 bg-hold-50 p-4 text-hold-800" aria-labelledby="q-h">
              <h3 id="q-h" className="font-semibold">The AI wasn't sure about</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5">{proposal.questions.map((q) => <li key={q}>{q}</li>)}</ul>
              <p className="mt-2 text-sm">Answer these by editing the fields below.</p>
            </aside>
          )}
          {proposal && proposal.notes.length > 0 && (
            <details className="mt-3 rounded-2xl border border-line bg-white p-4 text-sm">
              <summary className="cursor-pointer font-medium">What was left out or changed ({proposal.notes.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">{proposal.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </details>
          )}

          <form noValidate onSubmit={(e) => { e.preventDefault(); void create(); }} className="mt-5 space-y-5">
            <Field label="Event name" htmlFor="title">
              <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Badminton court" className={input} />
            </Field>
            <Field label="Starts" htmlFor="starts">
              <input id="starts" type="datetime-local" value={startsAt} min={localNowString()} onChange={(e) => setStartsAt(e.target.value)} className={input} />
            </Field>
            {farAway && (
              <p className="rounded-2xl border border-hold-100 bg-hold-50 p-3 text-sm text-hold-800">
                That is more than {HONOR_DAYS} days away. Friends can join now; deposits open {HONOR_DAYS} days before.
              </p>
            )}
            <Field label="Deposit per person (USD)" htmlFor="deposit" hint="Only a hold.">
              <div className="relative">
                <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">$</span>
                <input id="deposit" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="15.00" className={`${input} pl-7`} />
              </div>
            </Field>

            <details className="rounded-2xl border border-line bg-white p-4" open={filled || undefined}>
              <summary className="cursor-pointer font-medium">More options</summary>
              <div className="mt-4 space-y-5">
                <fieldset>
                  <legend className="text-sm font-medium">Free cancellation</legend>
                  <p className="text-sm text-ink-soft">Friends can release their own deposit until then.</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[[48, '2 days before'], [24, '1 day before'], [2, '2 hours before'], [0, 'Until the start']].map(([h, label]) => (
                      <button key={h} type="button" aria-pressed={graceHours === h} onClick={() => setGraceHours(h as number)}
                        className={`min-h-11 rounded-xl border px-3 text-base font-medium ${graceHours === h ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white'} focus-visible:outline-2 focus-visible:outline-brand-600`}>{label}</button>
                    ))}
                  </div>
                </fieldset>
                <fieldset>
                  <legend className="text-sm font-medium">If someone doesn't come, their deposit…</legend>
                  <div className="mt-2 grid gap-2">
                    {([['share', 'is shared with the people who came'], ['keep', 'stays with you, to cover the booking']] as const).map(([v, label]) => (
                      <button key={v} type="button" aria-pressed={potMode === v} onClick={() => setPotMode(v)}
                        className={`min-h-11 rounded-xl border px-3 py-2 text-left text-base font-medium ${potMode === v ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white'} focus-visible:outline-2 focus-visible:outline-brand-600`}>{label}</button>
                    ))}
                  </div>
                </fieldset>
                <GuestList rows={rows} setRows={setRows} nextKey={nextKey} />
              </div>
            </details>

            {depositCents !== null && depositCents > 0 && chosen.length > 0 && (
              <p className="rounded-2xl bg-brand-50 p-3">
                <strong>{chosen.length}</strong> {chosen.length === 1 ? 'person' : 'people'} × <strong>{formatMoney(depositCents, 'USD')}</strong> held in total{' '}
                <strong>{formatMoney(depositCents * chosen.length, 'USD')}</strong>.
              </p>
            )}

            {errors.length > 0 && (
              <div role="alert" className="rounded-2xl border border-charged-100 bg-charged-50 p-4 text-charged-800">
                <p className="font-semibold">Fix this first</p>
                <ul className="mt-1 list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </div>
            )}

            <button type="submit" disabled={submitting} className={`${primary} w-full`}>{submitting ? 'Creating…' : 'Create event'}</button>
          </form>
        </section>
      )}
    </Page>
  );
}

/** The lines that decide the money and the date, with the amount or time marked, to compare with the screenshots. */
function FlaggedLines({ chat }: { chat: string }) {
  const lines = useMemo(() => flagLines(chat), [chat]);
  const shown = lines.slice(0, 12);
  return (
    <section aria-labelledby="flag-h" className="mt-3 rounded-xl border border-line bg-white p-4">
      <h3 id="flag-h" className="font-semibold">Check these lines against your screenshots</h3>
      {lines.length === 0 ? (
        <p className="mt-1 text-sm text-ink-soft">No amounts, days or times were found, so the AI will ask you for them.</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1 text-sm">
            {shown.map((l, i) => (
              <li key={`${i}-${l}`}>{highlight(l).map((p, j) => (p.hit ? <mark key={j} className="rounded bg-hold-100 px-0.5 font-semibold text-hold-800">{p.text}</mark> : <span key={j}>{p.text}</span>))}</li>
            ))}
          </ul>
          {lines.length > shown.length && <p className="mt-1 text-sm text-ink-soft">and {lines.length - shown.length} more in the text below.</p>}
        </>
      )}
    </section>
  );
}

function GuestList({ rows, setRows, nextKey }: { rows: GuestRow[]; setRows: (f: (r: GuestRow[]) => GuestRow[]) => void; nextKey: { current: number } }) {
  const declined = rows.filter((r) => r.rsvp === 'out');
  const shown = rows.filter((r) => r.rsvp !== 'out');
  const update = (key: number, patch: Partial<GuestRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const row = (r: GuestRow) => (
    <li key={r.key} className="rounded-xl border border-line bg-white p-3">
      <div className="flex items-center gap-3">
        <input type="checkbox" checked={r.checked} onChange={(e) => update(r.key, { checked: e.target.checked })} aria-label={`Include ${r.name || 'this person'}`} className="size-5 accent-good-600" />
        <input value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} aria-label="Name" maxLength={60} className={`${input} flex-1`} />
        {r.source === 'added' && (
          <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-sm text-ink-soft underline">Remove</button>
        )}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={r.rsvp === 'in' ? 'good' : 'hold'}>{r.rsvp === 'in' ? 'said they\'re in' : r.rsvp === 'maybe' ? 'maybe' : r.rsvp === 'out' ? 'said no' : 'added by you'}</Badge>
        {r.source === 'mentioned' && <Badge tone="hold">only mentioned by someone else, check this</Badge>}
        {r.evidence && <q className="text-ink-soft">{r.evidence}</q>}
      </p>
    </li>
  );
  return (
    <fieldset>
      <legend className="text-sm font-medium">Names to pre-list (optional)</legend>
      <p className="mt-1 text-sm text-ink-soft">Lets friends tap their name. They can always type it.</p>
      <ul className="mt-2 space-y-2">{shown.map(row)}</ul>
      {shown.length === 0 && <p className="mt-2 text-ink-soft">No names yet. Friends add themselves from the link.</p>}
      {declined.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-ink-soft">Said no ({declined.length})</summary>
          <ul className="mt-2 space-y-2">{declined.map(row)}</ul>
        </details>
      )}
      <button type="button" onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, name: '', checked: true, rsvp: 'added', source: 'added', evidence: '' }])} className={`${secondary} mt-3`}>
        Add someone
      </button>
    </fieldset>
  );
}

/** The host page's path on this site, so the button works on whatever address the app is opened from. */
function hostPath(hostUrl: string): string {
  try { return new URL(hostUrl, window.location.origin).pathname; } catch { return hostUrl; }
}

/** One link for the group chat, with the message already written. The private host link is a separate, clearly marked card. */
function Created({ created, depositCents, startsAt, graceHours, potMode, copy }: { created: CreatedEvent; depositCents: number; startsAt: string; graceHours: number; potMode: 'share' | 'keep'; copy: (t: string) => Promise<void> }) {
  const [copied, setCopied] = useState<string | null>(null);
  const message = inviteMessage(
    { title: created.event.title, startsAt: new Date(startsAt).toISOString(), depositCents, currency: 'USD', potMode, graceHours },
    created.joinUrl,
    new Date(new Date(startsAt).getTime() - HONOR_DAYS * 86_400_000).toISOString(),
  );
  async function doCopy(id: string, text: string) {
    try { await copy(text); setCopied(id); } catch { setCopied(null); }
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <Page>
      <h1 className="text-3xl font-bold tracking-tight">{created.event.title} is ready</h1>
      {created.event.warnings.map((w) => <Alert key={w}>{w}</Alert>)}

      <Card tone="brand" className="mt-4">
        <p className="flex items-center gap-2 font-semibold"><Icon name="chat" className="size-4 text-brand-700" />Message for the group chat</p>
        <p className="mt-2 whitespace-pre-line rounded-2xl bg-white p-3 text-sm" data-testid="chat-message">{message}</p>
        <button type="button" onClick={() => doCopy('chat', message)} className={`${primary} mt-3 w-full`}>
          <Icon name={copied === 'chat' ? 'check' : 'copy'} className="size-4" />{copied === 'chat' ? 'Copied: now paste it in the chat' : 'Copy the message'}
        </button>
        {canShare && (
          <button type="button" onClick={() => void navigator.share({ text: message }).catch(() => {})} className={`${secondary} mt-2 w-full`}><Icon name="share" className="size-4" />Share…</button>
        )}
      </Card>

      {created.event.guests.length > 0 && (
        <section className="mt-6" aria-labelledby="listed-h">
          <h2 id="listed-h" className="text-base font-semibold">Names you listed</h2>
          <ul className="mt-2 space-y-2">
            {created.event.guests.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white p-3">
                <span className="flex items-center gap-3 font-medium"><Avatar name={g.name} size="sm" />{g.name}</span>
                <button type="button" onClick={() => doCopy(g.id, g.inviteUrl)} className={btnQuiet} aria-label={`Copy personal link for ${g.name}`}>{copied === g.id ? 'Copied' : 'Copy personal link'}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <a href={hostPath(created.hostUrl)} className={`${primary} mt-6 w-full`}>Go to your event page<Icon name="arrow" className="size-5" /></a>

      <section className="mt-6 rounded-2xl border border-hold-100 bg-hold-50 p-4 text-hold-800" aria-labelledby="host-h">
        <h2 id="host-h" className="font-semibold">Your host link. Keep it private.</h2>
        <p className="mt-1 text-sm">Only you can mark who came and approve the money. There is no account to recover it, so save it.</p>
        <p className="mt-2 break-all rounded-lg bg-white/70 p-2 text-sm">{created.hostUrl}</p>
        <button type="button" onClick={() => doCopy('host', created.hostUrl)} className={`${secondary} mt-2`}>{copied === 'host' ? 'Copied' : 'Copy host link'}</button>
      </section>
    </Page>
  );
}

// ---- small pieces --------------------------------------------------------------------------

const primary = btnPrimary;
const secondary = btnSecondary;
const input = fieldInput;

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  const hintId = useId();
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {hint && <p id={hintId} className="text-sm text-ink-soft">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
function Badge({ tone, children }: { tone: 'good' | 'hold'; children: ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone === 'good' ? 'bg-good-100 text-good-800' : 'bg-hold-100 text-hold-800'}`}>{children}</span>;
}
function Alert({ children }: { children: ReactNode }) {
  return <div role="alert" className="mt-3 rounded-2xl border border-hold-100 bg-hold-50 p-3 text-sm text-hold-800">{children}</div>;
}

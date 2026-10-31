import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, hostDashboardApi, type Decision, type HostDashboardApi, type HostGuest, type HostView } from '../api';
import { formatMoney, formatWhen } from '../lib/format';

const MAX_CHARS = 8000; // mirrors the server limit
const POLL_MS = 4000;
const MAX_SETTLE_POLLS = 45; // about 3 minutes of waiting for PayPal to finish payouts

interface Props {
  token: string;
  api?: HostDashboardApi;
  copy?: (text: string) => Promise<void>;
  pollMs?: number;
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function HostPage({ token, api = hostDashboardApi, copy = (t) => navigator.clipboard.writeText(t), pollMs = POLL_MS }: Props) {
  const [view, setView] = useState<HostView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  // Bumped whenever an action starts or finishes. A background poll that began before that must not
  // overwrite the newer result the action just produced (a stale page replacing "settling").
  const seq = useRef(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [approved, setApproved] = useState(false);
  const [chat, setChat] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [settlePolls, setSettlePolls] = useState(0);

  const act = useCallback(async (key: string, fn: () => Promise<HostView>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = key;
    seq.current += 1;
    setBusy(key);
    setError(null);
    try {
      setView(await fn());
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    } finally {
      seq.current += 1;
      busyRef.current = null;
      setBusy(null);
    }
  }, []);

  // first load
  useEffect(() => {
    let cancelled = false;
    api.getEvent(token).then((v) => { if (!cancelled) setView(v); }, (e) => { if (!cancelled) setLoadError(e as ApiError); });
    return () => { cancelled = true; };
  }, [api, token]);

  // Live updates: holds appear while the event is open; after approval, settle again until PayPal
  // reports every payout item as done (settle is idempotent and also refreshes payout status).
  const status = view?.status;
  const settling = !!view?.settlementApproved && status !== 'settled';
  useEffect(() => {
    if (!view || status === 'settled') return;
    if (settling && settlePolls >= MAX_SETTLE_POLLS) return;
    const id = setInterval(async () => {
      if (busyRef.current || document.hidden) return;
      const startedAt = seq.current;
      try {
        if (settling) setSettlePolls((n) => n + 1);
        const next = settling ? await api.settle(token) : await api.getEvent(token);
        if (seq.current === startedAt && !busyRef.current) setView(next); // else an action got there first
      } catch (e) {
        if (settling) setError((e as ApiError).message);
      }
    }, pollMs);
    return () => clearInterval(id);
  }, [api, token, view !== null, status, settling, settlePolls, pollMs]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doCopy(id: string, text: string) {
    try { await copy(text); setCopied(id); } catch { setCopied(null); }
  }

  if (loadError) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{loadError.status === 404 ? "This host link isn't valid" : "Couldn't load your event"}</h1>
        <p className="mt-2 text-ink-soft">{loadError.status === 404 ? 'Check that you opened the full host link you saved when you created the event.' : loadError.message}</p>
      </Shell>
    );
  }
  if (!view) return <Shell><p role="status" className="text-ink-soft">Loading your event…</p></Shell>;

  const money = (c: number) => formatMoney(c, view.currency);
  const locked = view.settlementApproved;
  const held = view.guests.filter((g) => g.deposit?.status === 'authorized');
  const noShowsHeld = view.guests.filter((g) => g.attendance === 'no_show' && g.deposit?.status === 'authorized');
  const canJudge = view.status === 'ended' && !locked && noShowsHeld.length > 0;
  const charging = view.guests.filter((g) => g.attendance === 'no_show' && g.decision === 'capture' && g.deposit);
  const releasing = view.guests.filter((g) => g.deposit?.status === 'authorized' && !(g.attendance === 'no_show' && g.decision === 'capture'));

  return (
    <Shell>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">{view.title}</h1>
        <p className="mt-1 text-ink-soft">{formatWhen(view.startsAt)} · {money(view.depositCents)} deposit each</p>
        <StatusChip view={view} />
      </header>

      <div className="mt-4 space-y-3" aria-live="polite">
        {view.warnings.map((w) => <Banner key={w} tone="hold">{w}</Banner>)}
        {view.problems.map((p) => <Banner key={p} tone="charged" alert>{p}</Banner>)}
        {error && <Banner tone="charged" alert>{error}</Banner>}
      </div>

      {view.status === 'open' && (
        <Card className="mt-5">
          <h2 className="text-lg font-semibold">Friends are placing holds</h2>
          <p className="mt-1 text-ink-soft">{held.length} of {view.guests.length} holds are in. You can mark who came as the event goes on. When it is over, close it.</p>
          {!confirmEnd ? (
            <button type="button" onClick={() => setConfirmEnd(true)} className={`${secondary} mt-4`}>Event ended</button>
          ) : (
            <div role="group" aria-label="Confirm ending the event" className="mt-4 rounded-xl border border-hold-100 bg-hold-50 p-4 text-hold-800">
              <p className="font-medium">Close deposits now?</p>
              <p className="mt-1 text-sm">Anyone who has not approved their hold yet will no longer be able to. This cannot be undone.</p>
              <div className="mt-3 flex gap-3">
                <button type="button" disabled={busy !== null} onClick={async () => { if (await act('end', () => api.end(token))) setConfirmEnd(false); }} className={primary}>
                  {busy === 'end' ? 'Closing…' : 'Yes, end it'}
                </button>
                <button type="button" onClick={() => setConfirmEnd(false)} className={secondary}>Not yet</button>
              </div>
            </div>
          )}
        </Card>
      )}

      <section aria-labelledby="guests-h" className="mt-6">
        <h2 id="guests-h" className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Friends</h2>
        <ul className="mt-2 space-y-3">
          {view.guests.map((g) => (
            <GuestCard key={g.id} g={g} view={view} locked={locked} busy={busy} copied={copied === g.id} money={money}
              onCopy={() => doCopy(g.id, g.inviteUrl)}
              onAttendance={(a) => act(`att-${g.id}`, () => api.setAttendance(token, g.id, a))}
              onDecision={(d) => act(`dec-${g.id}`, () => api.setDecision(token, g.id, d))} />
          ))}
        </ul>
      </section>

      {canJudge && (
        <section aria-labelledby="judge-h" className="mt-6">
          <Card>
            <h2 id="judge-h" className="text-lg font-semibold">Ask the AI about the no-shows (optional)</h2>
            <p className="mt-1 text-ink-soft">Paste the group chat from <strong>after</strong> the event. The AI looks for what each no-show said and <strong>suggests</strong>. You still choose for everyone.</p>
            <label htmlFor="after-chat" className="mt-3 block text-sm font-medium">Group chat from after the event</label>
            <textarea id="after-chat" value={chat} onChange={(e) => setChat(e.target.value)} rows={6} maxLength={MAX_CHARS}
              placeholder={'Cy: so sorry, my car broke down on the highway'} className={`${input} mt-1`} />
            <p className="mt-1 text-xs text-ink-soft">{chat.length}/{MAX_CHARS}. Sent to Google's Gemini API to be read and not stored by Flakeproof. Use a demo chat.</p>
            <button type="button" disabled={!chat.trim() || busy !== null} onClick={() => act('judge', () => api.judge(token, chat, browserZone()))} className={`${secondary} mt-3`}>
              {busy === 'judge' ? 'Reading the chat…' : 'Get AI suggestions'}
            </button>
          </Card>
        </section>
      )}

      {view.status !== 'open' && !locked && view.payoutPreview && view.payoutPreview.capturingCount > 0 && (
        <PreviewCard view={view} money={money} />
      )}

      {view.status === 'ended' && !locked && view.blockers.length > 0 && (
        <Card className="mt-6" tone="hold">
          <h2 className="text-lg font-semibold">Still to do before you can settle</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">{view.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Card>
      )}

      {view.status === 'ended' && !locked && view.canSettle && (
        <Card className="mt-6">
          <h2 className="text-lg font-semibold">Approve what happens to the money</h2>
          <ul className="mt-2 space-y-1">
            <li><strong>{releasing.length}</strong> {releasing.length === 1 ? 'hold is' : 'holds are'} released, so those people pay nothing.</li>
            <li>
              {charging.length === 0
                ? <>Nobody is charged.</>
                : <><strong>{charging.length}</strong> {charging.length === 1 ? 'deposit is' : 'deposits are'} charged ({charging.map((g) => g.name).join(', ')}), {money(charging.reduce((s, g) => s + (g.deposit?.amountCents ?? 0), 0))} in total.</>}
            </li>
            {view.payoutPreview && view.payoutPreview.capturingCount > 0 && view.payoutPreview.recipientCount > 0 && (
              <li>About <strong>{view.payoutPreview.recipientCount}</strong> {view.payoutPreview.recipientCount === 1 ? 'person who came is' : 'people who came are'} paid the charged money after PayPal's fees.</li>
            )}
          </ul>
          <label className="mt-4 flex items-start gap-3">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-1 size-5 accent-good-600" />
            <span>I approve this. I understand it cannot be undone.</span>
          </label>
          <button type="button" disabled={!approved || busy !== null} onClick={() => act('settle', () => api.settle(token))} className={`${primary} mt-4 w-full`}>
            {busy === 'settle' ? 'Settling…' : 'Approve and settle'}
          </button>
        </Card>
      )}

      {settling && (
        <Card className="mt-6" tone="hold">
          <h2 className="text-lg font-semibold">Settling with PayPal</h2>
          <p className="mt-1" role="status">Holds are released and charges are made. PayPal is sending the payouts, which can take about a minute.</p>
          {settlePolls >= MAX_SETTLE_POLLS && (
            <button type="button" onClick={() => { setSettlePolls(0); void act('settle', () => api.settle(token)); }} className={`${secondary} mt-3`}>Check again</button>
          )}
        </Card>
      )}

      {view.status === 'settled' && <SettledCard view={view} money={money} />}
    </Shell>
  );
}

// ---- pieces ---------------------------------------------------------------------------------

function StatusChip({ view }: { view: HostView }) {
  const [label, tone] =
    view.status === 'settled' ? ['Settled', 'bg-good-100 text-good-800']
    : view.settlementApproved ? ['Settling', 'bg-hold-100 text-hold-800']
    : view.status === 'ended' ? ['Ended: decide and settle', 'bg-hold-100 text-hold-800']
    : ['Open: holds are being placed', 'bg-good-100 text-good-800'];
  return <p className={`mt-3 inline-block rounded-full px-3 py-1 text-sm font-medium ${tone}`}>{label}</p>;
}

interface GuestCardProps {
  g: HostGuest; view: HostView; locked: boolean; busy: string | null; copied: boolean; money: (c: number) => string;
  onCopy: () => void; onAttendance: (a: 'showed' | 'no_show') => void; onDecision: (d: Decision) => void;
}
function GuestCard({ g, view, locked, busy, copied, money, onCopy, onAttendance, onDecision }: GuestCardProps) {
  const dep = g.deposit;
  const canMark = !locked && view.status !== 'settled';
  const canDecide = view.status === 'ended' && !locked && g.attendance === 'no_show' && dep?.status === 'authorized';
  const depositLine =
    !dep ? 'No deposit yet'
    : dep.status === 'pending' ? 'Waiting for PayPal approval'
    : dep.status === 'authorized' ? `Hold in place: ${money(dep.amountCents)}`
    : dep.status === 'voided' ? 'Hold released: paid nothing'
    : dep.status === 'capture_pending' ? 'Charge pending at PayPal'
    : `Charged ${money(dep.amountCents)}${dep.feeCents !== null ? ` (PayPal fee ${money(dep.feeCents)})` : ''}`;
  const tone = dep?.status === 'authorized' ? 'text-hold-800' : dep?.status === 'captured' || dep?.status === 'capture_pending' ? 'text-charged-800' : dep?.status === 'voided' ? 'text-good-800' : 'text-ink-soft';
  return (
    <li className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{g.name}</h3>
        {(!dep || dep.status === 'pending') && view.status === 'open' && (
          <button type="button" onClick={onCopy} className={secondary}>{copied ? 'Copied' : `Copy link for ${g.name}`}</button>
        )}
      </div>
      <p className={`mt-1 text-sm font-medium ${tone}`}>{depositLine}</p>

      {canMark && (
        <div role="group" aria-label={`Did ${g.name} come?`} className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" aria-pressed={g.attendance === 'showed'} disabled={busy !== null} onClick={() => onAttendance('showed')}
            className={seg(g.attendance === 'showed', 'good')}>Came</button>
          <button type="button" aria-pressed={g.attendance === 'no_show'} disabled={busy !== null} onClick={() => onAttendance('no_show')}
            className={seg(g.attendance === 'no_show', 'charged')}>Didn't come</button>
        </div>
      )}
      {!canMark && g.attendance !== 'unknown' && <p className="mt-2 text-sm text-ink-soft">{g.attendance === 'showed' ? 'Came' : "Didn't come"}</p>}

      {g.ai && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm" aria-label={`AI suggestion for ${g.name}`}>
          <p className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-white">AI suggests</span>
            <strong>{g.ai.recommendation === 'forgive' ? 'Forgive' : g.ai.recommendation === 'capture' ? 'Charge' : 'Not sure: you decide'}</strong>
          </p>
          <p className="mt-1">{g.ai.reason}</p>
          {g.ai.evidence && <p className="mt-1 text-ink-soft">They wrote: <q>{g.ai.evidence}</q></p>}
          {g.ai.minutesBeforeStart !== null && <p className="mt-1 text-ink-soft">{timingLine(g.ai.minutesBeforeStart, view.graceMinutes)}</p>}
          {g.ai.flag === 'addresses_the_ai' && <p className="mt-1 font-medium text-hold-800">This message is addressed to the AI. Treat it with care.</p>}
        </div>
      )}

      {canDecide && (
        <div role="group" aria-label={`What to do about ${g.name}`} className="mt-3">
          <p className="mb-2 text-sm text-ink-soft">Your decision. Nothing is chosen until you choose.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" aria-pressed={g.decision === 'capture'} disabled={busy !== null} onClick={() => onDecision('capture')}
              className={seg(g.decision === 'capture', 'charged')}>Charge {money(dep!.amountCents)}</button>
            <button type="button" aria-pressed={g.decision === 'forgive'} disabled={busy !== null} onClick={() => onDecision('forgive')}
              className={seg(g.decision === 'forgive', 'good')}>Forgive</button>
          </div>
        </div>
      )}
      {!canDecide && g.decision && <p className="mt-2 text-sm text-ink-soft">Your decision: {g.decision === 'capture' ? 'charge' : 'forgive'}</p>}

      {g.payout && (
        <p className="mt-2 text-sm font-medium text-good-800">
          Receives {money(g.payout.amountCents)}: {g.payout.status === 'SUCCESS' ? 'sent' : ['NOT_SENT', 'PENDING'].includes(g.payout.status) ? 'sending…' : 'needs attention'}
        </p>
      )}
    </li>
  );
}

/** "Wrote this 3 h 10 min before the start (within your 2 h rule)". A fact from the chat's timestamps, not the AI's opinion. */
export function timingLine(minutes: number, graceMinutes: number): string {
  const span = (m: number) => { const a = Math.abs(m); const h = Math.floor(a / 60); const r = a % 60; return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`; };
  if (minutes < 0) return `Wrote this ${span(minutes)} after the start.`;
  const rule = `${span(graceMinutes)}`;
  return minutes >= graceMinutes
    ? `Wrote this ${span(minutes)} before the start: within your ${rule} rule.`
    : `Wrote this ${span(minutes)} before the start: later than your ${rule} rule.`;
}

function PreviewCard({ view, money }: { view: HostView; money: (c: number) => string }) {
  const p = view.payoutPreview!;
  return (
    <Card className="mt-6">
      <h2 className="text-lg font-semibold">What the charges would pay out</h2>
      <p className="mt-1">
        Charging <strong>{p.capturingCount}</strong> {p.capturingCount === 1 ? 'deposit' : 'deposits'} would leave about <strong>{money(p.estimatedPotCents)}</strong> after PayPal's fee.
        {p.recipientCount > 0 && p.estimatedPerPersonCents !== null && <> Split between <strong>{p.recipientCount}</strong> {p.recipientCount === 1 ? 'person' : 'people'} that is about <strong>{money(p.estimatedPerPersonCents)}</strong> each, after payout fees.</>}
      </p>
      {p.problem && <p className="mt-2 font-medium text-charged-800">{p.problem === 'no_recipients' ? 'Nobody who came could be paid, so charging is not allowed.' : 'Too little would be left for each person, so charging is not allowed.'}</p>}
      {p.provisional && <p className="mt-2 text-sm text-ink-soft">This is an estimate and will change until everyone is marked as came or didn't come.</p>}
      {!p.provisional && !p.problem && <p className="mt-2 text-sm text-ink-soft">An estimate. The real amounts come from PayPal when you settle.</p>}
    </Card>
  );
}

function SettledCard({ view, money }: { view: HostView; money: (c: number) => string }) {
  const paid = view.guests.filter((g) => g.payout?.status === 'SUCCESS');
  const charged = view.guests.filter((g) => g.deposit?.status === 'captured');
  const released = view.guests.filter((g) => g.deposit?.status === 'voided');
  return (
    <Card className="mt-6" tone="good">
      <h2 className="text-lg font-semibold">All done</h2>
      <ul className="mt-2 space-y-1">
        <li><strong>{released.length}</strong> {released.length === 1 ? 'hold was' : 'holds were'} released.</li>
        <li>{charged.length === 0 ? 'Nobody was charged.' : <><strong>{charged.length}</strong> {charged.length === 1 ? 'deposit was' : 'deposits were'} charged.</>}</li>
        {paid.length > 0 && view.payout && (
          <li>
            <strong>{paid.length}</strong> {paid.length === 1 ? 'person was' : 'people were'} paid {money(paid.reduce((s, g) => s + (g.payout?.amountCents ?? 0), 0))} in total
            {view.payout.actualFeesCents !== null ? ` (PayPal's payout fees: ${money(view.payout.actualFeesCents)}, paid from the charged money)` : ''}.
          </li>
        )}
        {view.payout?.status === 'SKIPPED' && view.payout.skippedReason === 'no_capture' && <li>No payout was needed.</li>}
      </ul>
    </Card>
  );
}

// ---- styles and small components (this page only) --------------------------------------------

const primary = 'flex min-h-12 items-center justify-center rounded-xl bg-ink px-5 py-3 text-base font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-600 disabled:cursor-not-allowed disabled:opacity-60';
const secondary = 'flex min-h-11 items-center justify-center rounded-xl border border-line bg-white px-4 py-2 text-base font-medium transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-600 disabled:opacity-60';
const input = 'w-full rounded-xl border border-line bg-white p-3 text-base focus-visible:outline-2 focus-visible:outline-good-600';
const seg = (on: boolean, tone: 'good' | 'charged') =>
  `min-h-11 rounded-xl border px-3 py-2 text-base font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-600 disabled:opacity-60 ${
    on ? (tone === 'good' ? 'border-good-600 bg-good-100 text-good-800' : 'border-charged-800 bg-charged-100 text-charged-800') : 'border-line bg-white hover:bg-slate-50'}`;

const TONES = { neutral: 'bg-white border-line', hold: 'bg-hold-50 border-hold-100 text-hold-800', good: 'bg-good-50 border-good-100 text-good-800', charged: 'bg-charged-50 border-charged-100 text-charged-800' } as const;
function Card({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: keyof typeof TONES; className?: string }) {
  return <div className={`rounded-2xl border p-5 shadow-card ${TONES[tone]} ${className}`}>{children}</div>;
}
function Banner({ tone, alert, children }: { tone: 'hold' | 'charged'; alert?: boolean; children: ReactNode }) {
  return <div role={alert ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]}`}>{children}</div>;
}
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh max-w-xl px-4 pb-16 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <p className="mb-6 text-sm font-bold tracking-tight text-good-700">Flakeproof <span className="font-normal text-ink-soft">· host</span></p>
      {children}
    </main>
  );
}

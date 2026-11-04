import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, hostDashboardApi, type Decision, type HostDashboardApi, type HostGuest, type HostView } from '../api';
import {
  Avatar, Banner, btnPrimary, btnQuiet, btnSecondary, Card, Chip, EventHeader, fieldInput, Icon, Page, Receipt, SegmentedControl, Skeleton, type ReceiptLine,
} from '../components/ui';
import { formatDeadline, formatMoney } from '../lib/format';
import { inviteMessage, nudgeMessage } from '../lib/messages';
import { useTitle } from '../lib/useTitle';

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
  useTitle(view ? `${view.title} (host)` : 'Your event');

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
      <Page suffix="host">
        <Card>
          <h1 className="text-xl font-semibold">{loadError.status === 404 ? "This host link isn't valid" : "Couldn't load your event"}</h1>
          <p className="mt-2 text-ink-soft">{loadError.status === 404 ? 'Check that you opened the full host link you saved when you created the event.' : loadError.message}</p>
        </Card>
      </Page>
    );
  }
  if (!view) {
    return (
      <Page suffix="host">
        <p role="status" className="text-ink-soft">Loading your event…</p>
        <Skeleton className="mt-4 h-32" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="mt-4 h-24" />)}
      </Page>
    );
  }

  const money = (c: number) => formatMoney(c, view.currency);
  const locked = view.settlementApproved;
  const live = view.guests.filter((g) => g.cancel?.kind !== 'released');
  const held = view.guests.filter((g) => g.deposit?.status === 'authorized');
  const waiting = live.filter((g) => !g.deposit || g.deposit.status === 'pending');
  const noShowsHeld = view.guests.filter((g) => g.attendance === 'no_show' && g.deposit?.status === 'authorized');
  const canJudge = view.status === 'ended' && !locked && noShowsHeld.length > 0;
  const charging = view.guests.filter((g) => g.attendance === 'no_show' && g.decision === 'capture' && g.deposit);
  const releasing = view.guests.filter((g) => g.deposit?.status === 'authorized' && !(g.attendance === 'no_show' && g.decision === 'capture'));
  const unmarked = held.filter((g) => g.attendance === 'unknown');
  const phase = phaseOf(view);
  const keep = view.potMode === 'keep';
  const msgEvent = { title: view.title, startsAt: view.startsAt, depositCents: view.depositCents, currency: view.currency, potMode: view.potMode, graceHours: view.graceMinutes / 60 };
  const holdsOpen = !view.holdsOpenAt || new Date(view.holdsOpenAt) <= new Date();
  const chatMessage = view.joinUrl
    ? (held.length > 0 && holdsOpen && waiting.length > 0 ? nudgeMessage(msgEvent, view.joinUrl, waiting.map((g) => g.name)) : inviteMessage(msgEvent, view.joinUrl, view.holdsOpenAt))
    : null;

  return (
    <Page wide suffix="host">
      <EventHeader title={view.title} startsAt={view.startsAt}>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusChip view={view} />
          <Chip tone="neutral" icon="users">{live.length} {live.length === 1 ? 'person' : 'people'}</Chip>
          <Chip tone="neutral" icon="dollar">{money(view.depositCents)} each</Chip>
        </div>
      </EventHeader>

      <div className="mt-4 space-y-3" aria-live="polite">
        {view.warnings.map((w) => <Banner key={w} tone="hold">{w}</Banner>)}
        {view.problems.map((p) => <Banner key={p} tone="charged" alert>{p}</Banner>)}
        {error && <Banner tone="charged" alert>{error}</Banner>}
      </div>

      <section aria-labelledby="next-h" className="mt-4">
        <Card tone="brand">
          <p id="next-h" className="text-sm font-semibold text-brand-800">What's next</p>
          <p className="mt-1 text-xl font-semibold">{phase.text}</p>
          {phase.sub && <p className="mt-1 text-ink-soft">{phase.sub}</p>}
          {phase.kind === 'open' && (
            <>
              <div className="mt-4 flex flex-wrap gap-3">
                {chatMessage && (
                  <button type="button" onClick={() => doCopy('chat', chatMessage)} className={btnPrimary}>
                    <Icon name={copied === 'chat' ? 'check' : 'chat'} className="size-4" />{copied === 'chat' ? 'Copied: paste it in the chat' : waiting.length > 0 && held.length > 0 && holdsOpen ? 'Copy a reminder for the chat' : 'Copy the message for the chat'}
                  </button>
                )}
                {!confirmEnd && <button type="button" onClick={() => setConfirmEnd(true)} className={btnSecondary}><Icon name="door" className="size-4" />Event ended</button>}
              </div>
              {confirmEnd && (
                <div role="group" aria-label="Confirm ending the event" className="mt-4 rounded-2xl border border-hold-100 bg-hold-50 p-4 text-hold-800">
                  <p className="font-medium">Close deposits now?</p>
                  <p className="mt-1 text-sm">Nobody can put a deposit down after this. It cannot be undone.</p>
                  <div className="mt-3 flex gap-3">
                    <button type="button" disabled={busy !== null} onClick={async () => { if (await act('end', () => api.end(token))) setConfirmEnd(false); }} className={btnPrimary}>
                      {busy === 'end' ? 'Closing…' : 'Yes, end it'}
                    </button>
                    <button type="button" onClick={() => setConfirmEnd(false)} className={btnSecondary}>Not yet</button>
                  </div>
                </div>
              )}
            </>
          )}
          {phase.kind === 'checkin' && (
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" disabled={busy !== null || unmarked.length === 0} onClick={() => act('all-came', () => api.allCame(token))} className={btnPrimary}>
                <Icon name="check" className="size-4" />{busy === 'all-came' ? 'Marking…' : 'Everyone came'}
              </button>
              <a href="#friends" className={btnSecondary}>Mark one by one</a>
            </div>
          )}
          {(phase.kind === 'decide' || phase.link) && phase.kind !== 'checkin' && phase.link && (
            <a href={phase.link.href} className={`${btnPrimary} mt-4 w-full sm:w-auto`}>{phase.link.label}<Icon name="arrow" className="size-4" /></a>
          )}
        </Card>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <section id="friends" aria-labelledby="guests-h">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="guests-h" className="text-xl font-semibold">People</h2>
            {held.length > 0 && <p aria-label="Money so far" className="text-sm text-ink-soft">{held.length} {held.length === 1 ? 'deposit' : 'deposits'} in · <strong className="text-ink">{money(held.reduce((s, g) => s + (g.deposit?.amountCents ?? 0), 0))}</strong> on hold</p>}
          </div>
          {view.guests.length === 0 && (
            <Card className="mt-3"><p className="text-ink-soft">Nobody has joined yet.</p></Card>
          )}
          <ul className="mt-3 space-y-3">
            {view.guests.map((g) => (
              <GuestCard key={g.id} g={g} view={view} locked={locked} busy={busy} copied={copied === g.id} money={money}
                onCopy={() => doCopy(g.id, g.inviteUrl)}
                onRemove={() => act(`rm-${g.id}`, () => api.removeGuest(token, g.id))}
                onAttendance={(a) => act(`att-${g.id}`, () => api.setAttendance(token, g.id, a))}
                onDecision={(d) => act(`dec-${g.id}`, () => api.setDecision(token, g.id, d))} />
            ))}
          </ul>
        </section>

        <div className="space-y-6 lg:sticky lg:top-4">
          {view.status === 'open' && view.joinUrl && (
            <Card>
              <h2 className="text-base font-semibold">Group chat link</h2>
              <p className="mt-2 break-all rounded-xl bg-stone-100 px-3 py-2 text-sm">{view.joinUrl}</p>
            </Card>
          )}

          {canJudge && (
            <section aria-labelledby="judge-h">
              <Card>
                <h2 id="judge-h" className="text-lg font-semibold">Ask the AI about the no-shows (optional)</h2>
                <p className="mt-1 text-ink-soft">Paste the chat from after the event. It only suggests; you choose.</p>
                <label htmlFor="after-chat" className="mt-3 block text-sm font-medium">Group chat from after the event</label>
                <textarea id="after-chat" value={chat} onChange={(e) => setChat(e.target.value)} rows={6} maxLength={MAX_CHARS}
                  placeholder={'Cy: so sorry, my car broke down on the highway'} className={`${fieldInput} mt-1`} />
                <p className="mt-1 text-xs text-ink-soft">{chat.length}/{MAX_CHARS} · Sent to Gemini to be read, not stored. Use a demo chat.</p>
                <button type="button" disabled={!chat.trim() || busy !== null} onClick={() => act('judge', () => api.judge(token, chat, browserZone()))} className={`${btnSecondary} mt-3`}>
                  <Icon name="sparkle" className="size-4" />{busy === 'judge' ? 'Reading the chat…' : 'Get AI suggestions'}
                </button>
              </Card>
            </section>
          )}

          {view.status !== 'open' && !locked && view.payoutPreview && view.payoutPreview.capturingCount > 0 && (
            <PreviewCard view={view} money={money} />
          )}

          {view.status === 'ended' && !locked && view.blockers.length > 0 && (
            <Card tone="hold">
              <h2 className="text-lg font-semibold">Still to do before you can settle</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">{view.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </Card>
          )}

          {view.status === 'ended' && !locked && view.canSettle && (
            <section id="approve" aria-label="Approve and settle">
              <Card>
                <h2 className="text-lg font-semibold">Approve what happens to the money</h2>
                <ul className="mt-2 space-y-1">
                  <li><strong>{releasing.length}</strong> {releasing.length === 1 ? 'hold is' : 'holds are'} released: those people pay nothing.</li>
                  <li>
                    {charging.length === 0
                      ? <>Nobody is charged.</>
                      : <><strong>{charging.length}</strong> {charging.length === 1 ? 'deposit is' : 'deposits are'} charged ({charging.map((g) => g.name).join(', ')}), {money(charging.reduce((s, g) => s + (g.deposit?.amountCents ?? 0), 0))} in total.</>}
                  </li>
                  {keep && charging.length > 0 && <li>You keep the charged money. Nobody is paid out.</li>}
                  {!keep && view.payoutPreview && view.payoutPreview.capturingCount > 0 && view.payoutPreview.recipientCount > 0 && (
                    <li>About <strong>{view.payoutPreview.recipientCount}</strong> {view.payoutPreview.recipientCount === 1 ? 'person who came is' : 'people who came are'} paid the rest.</li>
                  )}
                </ul>
                <label className="mt-4 flex items-start gap-3">
                  <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="mt-1 size-5 accent-brand-600" />
                  <span>I approve this. It cannot be undone.</span>
                </label>
                <button type="button" disabled={!approved || busy !== null} onClick={() => act('settle', () => api.settle(token))} className={`${btnPrimary} mt-4 w-full`}>
                  {busy === 'settle' ? 'Settling…' : 'Approve and settle'}
                </button>
              </Card>
            </section>
          )}

          {settling && (
            <Card tone="hold">
              <h2 className="text-lg font-semibold">Settling with PayPal</h2>
              <p className="mt-1" role="status">{keep ? 'Finishing up.' : 'PayPal is sending the payouts. This can take a minute.'}</p>
              {settlePolls >= MAX_SETTLE_POLLS && (
                <button type="button" onClick={() => { setSettlePolls(0); void act('settle', () => api.settle(token)); }} className={`${btnSecondary} mt-3`}>Check again</button>
              )}
            </Card>
          )}

          {view.status === 'settled' && <SettledCard view={view} money={money} />}
        </div>
      </div>
    </Page>
  );
}

// ---- where the event is ---------------------------------------------------------------------------------

export interface Phase { kind: 'open' | 'checkin' | 'decide' | 'approve' | 'blocked' | 'settling' | 'done'; text: string; sub?: string; link?: { href: string; label: string } }

/** One place that decides what the host should do next. */
export function phaseOf(view: HostView, now: Date = new Date()): Phase {
  const live = view.guests.filter((g) => g.cancel?.kind !== 'released');
  const heldNow = live.filter((g) => g.deposit?.status === 'authorized');
  if (view.status === 'settled') return { kind: 'done', text: 'Everything is sorted', sub: 'Receipt below.' };
  if (view.settlementApproved) {
    const items = view.guests.filter((g) => g.payout);
    const done = items.filter((g) => g.payout?.status === 'SUCCESS').length;
    return { kind: 'settling', text: items.length ? `Sending payouts… ${done} of ${items.length} done` : 'Settling with PayPal…', sub: 'You can close this page.' };
  }
  if (view.status === 'open') {
    const waitingNames = live.filter((g) => !g.deposit || g.deposit.status === 'pending').map((g) => g.name);
    if (live.length === 0) return { kind: 'open', text: 'Share the link in your group chat', sub: 'People appear here as they join.' };
    if (view.holdsOpenAt && new Date(view.holdsOpenAt) > now) {
      return { kind: 'open', text: `${live.length} ${live.length === 1 ? 'person has' : 'people have'} joined`, sub: `Deposits open ${formatDeadline(view.holdsOpenAt)}.` };
    }
    return { kind: 'open', text: `${heldNow.length} of ${live.length} have put the deposit down`, sub: waitingNames.length ? `Waiting on ${waitingNames.join(', ')}.` : 'Everyone is in.' };
  }
  const unmarked = heldNow.filter((g) => g.attendance === 'unknown');
  if (unmarked.length) return { kind: 'checkin', text: `Who came? ${unmarked.length} to mark`, sub: unmarked.map((g) => g.name).join(', '), link: { href: '#friends', label: 'Go to people' } };
  const undecided = heldNow.filter((g) => g.attendance === 'no_show' && !g.decision);
  if (undecided.length) return { kind: 'decide', text: `Decide on ${undecided.map((g) => g.name).join(', ')}`, sub: 'Charge the deposit or forgive it.', link: { href: '#friends', label: 'Go to people' } };
  if (view.canSettle) {
    const charging = heldNow.filter((g) => g.attendance === 'no_show' && g.decision === 'capture').length;
    const releasing = heldNow.length - charging;
    return { kind: 'approve', text: charging ? `Release ${releasing}, charge ${charging}` : `Release all ${releasing} holds`, sub: 'Nothing moves until you approve.', link: { href: '#approve', label: 'Review and approve' } };
  }
  return { kind: 'blocked', text: 'One thing needs fixing first', sub: 'See the note below.' };
}

// ---- pieces ---------------------------------------------------------------------------------

function StatusChip({ view }: { view: HostView }) {
  const [label, tone] =
    view.status === 'settled' ? ['Settled', 'good' as const]
    : view.settlementApproved ? ['Settling', 'hold' as const]
    : view.status === 'ended' ? ['Ended: decide and settle', 'hold' as const]
    : ['Open: holds are being placed', 'good' as const];
  return <Chip tone={tone}>{label}</Chip>;
}

interface GuestCardProps {
  g: HostGuest; view: HostView; locked: boolean; busy: string | null; copied: boolean; money: (c: number) => string;
  onCopy: () => void; onRemove: () => void; onAttendance: (a: 'showed' | 'no_show') => void; onDecision: (d: Decision) => void;
}
function GuestCard({ g, view, locked, busy, copied, money, onCopy, onRemove, onAttendance, onDecision }: GuestCardProps) {
  const dep = g.deposit;
  const out = g.cancel?.kind === 'released';
  // Check-in belongs to the event, not to the weeks before it: hidden until the start time (or the host ended it).
  const started = view.status !== 'open' || new Date(view.startsAt) <= new Date();
  const canMark = !locked && view.status !== 'settled' && !out;
  const canDecide = view.status === 'ended' && !locked && g.attendance === 'no_show' && dep?.status === 'authorized';
  const noHold = !dep || dep.status === 'pending';
  // The chip says where they are. This line only adds what the chip cannot: money.
  const depositLine =
    out || !dep || dep.status === 'pending' || dep.status === 'voided' ? null
    : dep.status === 'authorized' ? `${money(dep.amountCents)} held`
    : dep.status === 'capture_pending' ? 'Charge pending at PayPal'
    : `Charged ${money(dep.amountCents)}${dep.feeCents !== null ? ` (PayPal fee ${money(dep.feeCents)})` : ''}`;
  const tone = out ? 'text-good-800' : dep?.status === 'authorized' ? 'text-hold-800' : dep?.status === 'captured' || dep?.status === 'capture_pending' ? 'text-charged-800' : dep?.status === 'voided' ? 'text-good-800' : 'text-ink-soft';
  const agreed = g.decision && g.ai && g.ai.recommendation !== 'unclear'
    ? (g.ai.recommendation === g.decision ? 'You agreed with the AI' : 'You overruled the AI') : null;
  return (
    <li className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <div className="flex items-center gap-3">
        <Avatar name={g.name} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold">{g.name}</h3>
          {depositLine && <p className={`text-sm ${tone}`}>{depositLine}</p>}
        </div>
        <PersonChip g={g} view={view} />
      </div>

      {noHold && view.status === 'open' && !out && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4">
          <button type="button" onClick={onCopy} className={btnQuiet}><Icon name="copy" className="size-4" />{copied ? 'Copied' : `Copy link for ${g.name}`}</button>
          <button type="button" disabled={busy !== null} onClick={onRemove} className={btnQuiet} aria-label={`Remove ${g.name}`}>Remove</button>
        </div>
      )}

      {g.cancel && <CancelNote cancel={g.cancel} />}

      {canMark && started && (!noHold || view.status !== 'open') && (
        <div className="mt-3">
          <SegmentedControl label={`Did ${g.name} come?`} value={g.attendance === 'unknown' ? null : g.attendance} disabled={busy !== null}
            onChange={onAttendance}
            segments={[
              { value: 'showed', label: 'Came', icon: 'check', tone: 'good' },
              { value: 'no_show', label: "Didn't come", icon: 'x', tone: 'ink' },
            ]} />
        </div>
      )}
      {!canMark && g.attendance !== 'unknown' && <p className="mt-2 text-sm text-ink-soft">{g.attendance === 'showed' ? 'Came' : "Didn't come"}</p>}

      {g.ai && <AiNote g={g} graceMinutes={view.graceMinutes} />}

      {canDecide && (
        <div className="mt-3">
          <p className="mb-2 text-sm text-ink-soft">Your decision</p>
          <SegmentedControl label={`What to do about ${g.name}`} value={g.decision} disabled={busy !== null} onChange={onDecision}
            segments={[
              { value: 'capture', label: `Charge ${money(dep!.amountCents)}`, icon: 'dollar', tone: 'charged' },
              { value: 'forgive', label: 'Forgive', icon: 'check', tone: 'good' },
            ]} />
        </div>
      )}
      {!canDecide && g.decision && <p className="mt-2 text-sm text-ink-soft">Your decision: {g.decision === 'capture' ? 'charge' : 'forgive'}</p>}
      {agreed && <p className="mt-1 text-xs font-medium text-ink-soft">{agreed}</p>}

      {g.payout && (
        <p className="mt-2 text-sm font-medium text-good-800">
          Receives {money(g.payout.amountCents)}: {g.payout.status === 'SUCCESS' ? 'sent' : ['NOT_SENT', 'PENDING'].includes(g.payout.status) ? 'sending…' : 'needs attention'}
        </p>
      )}
    </li>
  );
}

/** One plain word for where this person is. Always text; colour only backs it up. */
function PersonChip({ g, view }: { g: HostGuest; view: HostView }) {
  if (g.cancel?.kind === 'released') return <Chip>Can't come</Chip>;
  if (g.stage === 'paid_out') return <Chip tone="good" icon="check">Got paid</Chip>;
  if (g.stage === 'captured') return <Chip tone="charged">Charged</Chip>;
  if (g.stage === 'voided') return <Chip tone="good" icon="check">Free</Chip>;
  if (g.attendance === 'showed') return <Chip tone="good" icon="check">Came</Chip>;
  if (g.attendance === 'no_show') return <Chip tone="hold">No-show</Chip>;
  if (g.deposit?.status === 'authorized') return <Chip tone="good" icon="lock">Deposit in</Chip>;
  if (view.status === 'open' && g.joined === false) return <Chip>Not joined</Chip>;
  if (view.status !== 'open' && !g.deposit) return <Chip>No deposit</Chip>; // joined, but never put money down: nothing to charge
  return <Chip tone="hold" icon="clock">Waiting</Chip>;
}

/** The friend's own "I can't make it", as a plain fact with its timing. It never decides anything. */
function CancelNote({ cancel }: { cancel: NonNullable<HostGuest["cancel"]> }) {
  const lead = cancel.minutesBeforeStart === null ? '' : ` ${spanText(cancel.minutesBeforeStart)} before the start`;
  const released = cancel.kind === 'released';
  return (
    <p className={`mt-3 flex items-start gap-2 rounded-2xl border px-3 py-2 text-sm ${released ? 'border-good-100 bg-good-50 text-good-800' : 'border-hold-100 bg-hold-50 text-hold-800'}`}>
      <Icon name="clock" className="mt-0.5 size-4" />
      <span>
        {released
          ? `Released their spot${lead}. No check-in needed.`
          : `Said they can't come${lead}. The hold stays; you decide.`}
      </span>
    </p>
  );
}

/** Always visually apart from the host's own choice: dashed, grey, never the colours of a selected option. */
function AiNote({ g, graceMinutes }: { g: HostGuest; graceMinutes: number }) {
  const ai = g.ai!;
  return (
    <div className="mt-3 rounded-2xl border border-dashed border-ai-border bg-ai-bg p-3 text-sm" aria-label={`AI suggestion for ${g.name}`}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-stone-700 px-2 py-0.5 text-xs font-semibold text-white"><Icon name="sparkle" className="size-3" />AI suggests</span>
        <strong>{ai.recommendation === 'forgive' ? 'Forgive' : ai.recommendation === 'capture' ? 'Charge' : 'Not sure: you decide'}</strong>
        <span className="text-xs text-ink-soft">not a decision</span>
      </p>
      <p className="mt-1">{ai.reason}</p>
      {ai.evidence && (
        <p className="mt-2 flex gap-2 border-l-2 border-stone-300 pl-3 text-ink-soft">
          <Icon name="quote" className="mt-0.5 size-4" /><span><q>{ai.evidence}</q></span>
        </p>
      )}
      {ai.minutesBeforeStart !== null && <p className="mt-1 text-ink-soft">{timingLine(ai.minutesBeforeStart, graceMinutes)}</p>}
      {ai.flag === 'addresses_the_ai' && <p className="mt-1 font-medium text-hold-800">This message is addressed to the AI. Treat it with care.</p>}
    </div>
  );
}

function spanText(m: number): string {
  const a = Math.abs(m); const h = Math.floor(a / 60); const r = a % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}

/** "Wrote this 3 h 10 min before the start (within your 2 h rule)". A fact from the chat's timestamps, not the AI's opinion. */
export function timingLine(minutes: number, graceMinutes: number): string {
  if (minutes < 0) return `Wrote this ${spanText(minutes)} after the start.`;
  const rule = spanText(graceMinutes);
  return minutes >= graceMinutes
    ? `Wrote this ${spanText(minutes)} before the start: within your ${rule} rule.`
    : `Wrote this ${spanText(minutes)} before the start: later than your ${rule} rule.`;
}

function PreviewCard({ view, money }: { view: HostView; money: (c: number) => string }) {
  const p = view.payoutPreview!;
  const keep = p.mode === 'keep';
  return (
    <Card>
      <h2 className="text-lg font-semibold">What the charges would pay out</h2>
      <p className="mt-1">
        Charging <strong>{p.capturingCount}</strong> {p.capturingCount === 1 ? 'deposit' : 'deposits'} leaves about <strong>{money(p.estimatedPotCents)}</strong> after PayPal's fee.
        {keep && <> It stays in your PayPal account and nobody is paid out.</>}
        {!keep && p.recipientCount > 0 && p.estimatedPerPersonCents !== null && <> Split between <strong>{p.recipientCount}</strong> {p.recipientCount === 1 ? 'person' : 'people'}: about <strong>{money(p.estimatedPerPersonCents)}</strong> each.</>}
      </p>
      {p.problem && <p className="mt-2 font-medium text-charged-800">{p.problem === 'no_recipients' ? 'Nobody who came could be paid, so charging is not allowed.' : 'Too little would be left for each person, so charging is not allowed.'}</p>}
      <p className="mt-2 text-sm text-ink-soft">An estimate{p.provisional ? ', until everyone is marked' : ''}. PayPal's real amounts come when you settle.</p>
    </Card>
  );
}

/** The payoff screen: every figure is PayPal's, in cents, added up here for display only. */
export function receiptLines(view: HostView, money: (c: number) => string): ReceiptLine[] {
  const released = view.guests.filter((g) => g.deposit?.status === 'voided' && g.cancel?.kind !== 'released');
  const early = view.guests.filter((g) => g.cancel?.kind === 'released');
  const charged = view.guests.filter((g) => g.deposit?.status === 'captured');
  const paid = view.guests.filter((g) => g.payout?.status === 'SUCCESS');
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lines: ReceiptLine[] = [{ label: 'Holds released', value: `${released.length} ${released.length === 1 ? 'person' : 'people'}` }];
  if (early.length) lines.push({ label: 'Released their own spot', value: `${early.length} ${early.length === 1 ? 'person' : 'people'}`, sub: true });
  if (charged.length) {
    const fees = charged.map((g) => g.deposit?.feeCents);
    lines.push({ label: charged.length === 1 ? `Deposit charged (${charged[0]!.name})` : `Deposits charged (${charged.length})`, value: money(sum(charged.map((g) => g.deposit!.amountCents))) });
    if (fees.every((f): f is number => f !== null)) lines.push({ label: "PayPal's fee on the charge", value: `−${money(sum(fees))}`, sub: true });
    if (view.potMode === 'keep' && view.payout) lines.push({ label: 'Kept by you', value: money(view.payout.potCents), strong: true });
    else if (view.payout) lines.push({ label: 'Left to share', value: money(view.payout.potCents) });
  } else {
    lines.push({ label: 'Deposits charged', value: 'None' });
  }
  const paidTotal = sum(paid.map((g) => g.payout!.amountCents));
  const payoutFees = view.payout?.actualFeesCents ?? null;
  if (paid.length) {
    if (payoutFees !== null) lines.push({ label: "PayPal's payout fees", value: `−${money(payoutFees)}`, sub: true });
    lines.push({ label: 'Paid out to people who came', value: money(paidTotal), strong: true });
    const left = (view.payout?.potCents ?? 0) - paidTotal - (payoutFees ?? 0);
    if (payoutFees !== null && left > 0) lines.push({ label: 'Left over in your PayPal account', value: money(left), sub: true });
  }
  return lines;
}

function SettledCard({ view, money }: { view: HostView; money: (c: number) => string }) {
  return (
    <Card tone="good">
      <p className="flex items-center gap-2 text-sm font-semibold"><Icon name="check" draw className="size-5" />Receipt</p>
      <h2 className="mt-1 text-lg font-semibold">All done</h2>
      <Receipt title="Receipt" lines={receiptLines(view, money)} />
      {view.payout?.status === 'SKIPPED' && view.payout.skippedReason === 'no_capture' && <p className="mt-3 text-sm">No payout was needed.</p>}
      {view.payout?.status === 'SKIPPED' && view.payout.skippedReason === 'kept_by_host' && <p className="mt-3 text-sm">You kept the charged money.</p>}
    </Card>
  );
}

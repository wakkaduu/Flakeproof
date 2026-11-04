import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, guestApi, type GuestApi, type GuestView } from '../api';
import { Avatar, Banner, btnPrimary, btnQuiet, btnSecondary, Card, EventHeader, Icon, Page, Skeleton } from '../components/ui';
import { formatDeadline, formatMoney } from '../lib/format';
import { downloadText, reminderIcs } from '../lib/ics';
import { useTitle } from '../lib/useTitle';

export type PayPalReturn = 'return' | 'cancel' | null;

interface Props {
  token: string;
  /** What PayPal told the browser when it sent the guest back (?paypal=return|cancel). */
  paypalReturn?: PayPalReturn;
  api?: GuestApi;
  /** Where to send the browser for PayPal approval. Injected so tests don't navigate. */
  navigate?: (url: string) => void;
  /** Saves a calendar file. Injected so tests do not need a browser download. */
  download?: (filename: string, mime: string, text: string) => void;
}

type Busy = null | 'starting' | 'confirming' | 'cancelling';
interface Notice { tone: 'info' | 'warn'; text: string }

export function GuestPage({ token, paypalReturn = null, api = guestApi, navigate = (u) => window.location.assign(u), download = downloadText }: Props) {
  const [view, setView] = useState<GuestView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const handledReturn = useRef(false);
  useTitle(view ? view.event.title : 'Your invite');

  const confirm = useCallback(async () => {
    setBusy('confirming');
    setNotice(null);
    try {
      setView(await api.authorize(token));
    } catch (e) {
      const err = e as ApiError;
      setNotice({
        tone: 'warn',
        text: err.code === 'not_approved'
          ? "We didn't see an approval from PayPal yet. If you closed PayPal early, no problem: nothing was held. Try again below."
          : err.message,
      });
    } finally {
      setBusy(null);
    }
  }, [api, token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await api.getGuest(token);
        if (cancelled) return;
        setView(v);
        if (!handledReturn.current) {
          handledReturn.current = true;
          if (paypalReturn === 'cancel') {
            setNotice({ tone: 'info', text: 'You cancelled on PayPal. Nothing was held and nothing was charged.' });
          } else if (paypalReturn === 'return' && v.depositStatus === 'pending') {
            void confirm();
          }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e as ApiError);
      }
    })();
    return () => { cancelled = true; };
  }, [api, token, paypalReturn, confirm]);

  async function approve() {
    setBusy('starting');
    setNotice(null);
    try {
      const { approveUrl } = await api.startDeposit(token);
      navigate(approveUrl); // stay busy: the browser is leaving
    } catch (e) {
      setNotice({ tone: 'warn', text: (e as ApiError).message });
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy('cancelling');
    setNotice(null);
    try {
      setView(await api.cancel(token));
    } catch (e) {
      setNotice({ tone: 'warn', text: (e as ApiError).message });
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-semibold">
            {loadError.status === 404 ? "This invite link isn't valid" : "Couldn't load your invite"}
          </h1>
          <p className="mt-2 text-ink-soft">
            {loadError.status === 404
              ? 'Check that you opened the full link your host sent you.'
              : loadError.message}
          </p>
        </Card>
      </Shell>
    );
  }
  if (!view) {
    return (
      <Shell>
        <Card>
          <p role="status" className="text-ink-soft">Loading your invite…</p>
          <Skeleton className="mt-3 h-8 w-2/3" />
          <Skeleton className="mt-3 h-16" />
        </Card>
      </Shell>
    );
  }

  const { event } = view;
  const amount = formatMoney(event.depositCents, event.currency);

  return (
    <Shell>
      <p className="mb-3 flex items-center gap-2 text-ink-soft"><Avatar name={view.guestName} size="sm" /><span>Hi {view.guestName}</span></p>
      <EventHeader title={event.title} startsAt={event.startsAt}>
        <p className="mt-4 flex items-baseline justify-between gap-3 border-t border-line pt-3">
          <span className="text-ink-soft">Deposit</span>
          <span className="text-2xl font-bold tabular-nums">{amount}</span>
        </p>
      </EventHeader>

      <div aria-live="polite" className="mt-4 space-y-4">
        {notice && <Banner tone={notice.tone === 'warn' ? 'hold' : 'info'} alert={notice.tone === 'warn'}>{notice.text}</Banner>}
        {busy === 'confirming' && <Banner tone="info">Confirming with PayPal…</Banner>}
        <StatusPanel view={view} amount={amount} busy={busy} onApprove={approve}
          onRemind={() => view.holds && download('flakeproof-reminder.ics', 'text/calendar', reminderIcs({ title: event.title, opensAt: view.holds.opensAt, startsAt: event.startsAt, url: window.location.href.split('?')[0]!, uid: token.slice(0, 12) }))} />
      </div>

      <CancelPanel view={view} busy={busy} onConfirm={cancel} />

      <HowItWorks amount={amount} potMode={event.potMode ?? 'share'} />
    </Shell>
  );
}

function StatusPanel({ view, amount, busy, onApprove, onRemind }: { view: GuestView; amount: string; busy: Busy; onApprove: () => void; onRemind: () => void }) {
  const { event, outcome, share } = view;
  const money = (c: number) => formatMoney(c, event.currency);

  if (view.cancel?.state === 'released') {
    return (
      <Card tone="good">
        <h2 className="text-lg font-semibold">You're out. Nothing was charged.</h2>
        <p className="mt-1">Your host has been told.</p>
      </Card>
    );
  }

  if (!view.canApprove && view.depositStatus === null && view.holds?.state === 'not_yet' && event.status === 'open') {
    return (
      <Card tone="brand">
        <p className="flex items-center gap-2 text-sm font-semibold text-brand-800"><Icon name="check" className="size-4" />You're on the list</p>
        <h2 className="mt-1 text-lg font-semibold">Deposits open {formatDeadline(view.holds.opensAt)}</h2>
        <p className="mt-1 text-ink-soft">PayPal holds last 3 days. Come back to this link then.</p>
        <button type="button" onClick={onRemind} className={`${btnSecondary} mt-4 w-full`}><Icon name="calendar" className="size-4" />Remind me in my calendar</button>
      </Card>
    );
  }

  if (view.canApprove) {
    return (
      <Card tone="brand">
        <h2 className="text-lg font-semibold">Hold {amount} to confirm your spot</h2>
        <p className="mt-1 text-ink-soft">It is only a hold: <strong>nothing is charged</strong>.</p>
        <button type="button" onClick={onApprove} disabled={busy !== null} className={`${btnPrimary} mt-4 w-full`}>
          {!busy && <Icon name="lock" className="size-4" />}{busy === 'starting' ? 'Opening PayPal…' : 'Approve with PayPal'}
        </button>
        <p className="mt-2 text-center text-sm text-ink-soft">PayPal's last button says “Complete Purchase”. Here it only places the hold.</p>
      </Card>
    );
  }

  if (outcome.kind === 'held') {
    return (
      <Card tone="hold">
        <p className="flex items-center gap-2 text-sm font-semibold"><Icon name="check" draw className="size-5" />You're in</p>
        <h2 className="mt-1 text-lg font-semibold">Your {money(outcome.amountCents ?? event.depositCents)} hold is in place</h2>
        <p className="mt-1">Nothing is charged. Show up and it disappears.</p>
      </Card>
    );
  }

  if (outcome.kind === 'received') {
    return (
      <Card tone="good">
        <h2 className="text-lg font-semibold">You received {money(outcome.amountCents ?? 0)}</h2>
        <p className="mt-1">You paid nothing, and your share is in your PayPal account.</p>
      </Card>
    );
  }

  if (outcome.kind === 'nothing_charged') {
    return (
      <Card tone="good">
        <h2 className="text-lg font-semibold">You paid nothing</h2>
        {share && <ShareLine share={share} money={money} />}
      </Card>
    );
  }

  if (outcome.kind === 'charged') {
    return (
      <Card tone="charged">
        <h2 className="text-lg font-semibold">Your {money(outcome.amountCents ?? event.depositCents)} deposit was charged</h2>
        <p className="mt-1">You weren't there, so it goes to {event.potMode === 'keep' ? 'your host' : 'the people who came'}. Questions? Ask your host.</p>
      </Card>
    );
  }

  return (
    <Card tone="neutral">
      <h2 className="text-lg font-semibold">Deposits are closed</h2>
      <p className="mt-1 text-ink-soft">The event has ended.</p>
    </Card>
  );
}

/**
 * "Can't make it". Early enough, this releases the friend's own hold at once (a PayPal void) and tells the host in
 * time to rebook. Too late, it only warns the host, who still decides. Never promises a refund of a charge.
 * Kept quiet: a text button, with the explanation only once it is pressed.
 */
function CancelPanel({ view, busy, onConfirm }: { view: GuestView; busy: Busy; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const c = view.cancel;
  if (!c) return null;
  if (c.state === 'late_notice') {
    return (
      <p className="mt-4 flex items-start gap-2 text-sm text-ink-soft">
        <Icon name="clock" className="mt-0.5 size-4" />
        <span>Your host knows you can't come. {view.depositStatus === 'authorized' ? 'Your hold stays until they decide.' : 'They decide what happens next.'}</span>
      </p>
    );
  }
  if (!c.can) return null;
  const release = c.can === 'release';
  const holding = view.depositStatus === 'authorized';
  if (!confirming) {
    return (
      <div className="mt-3 text-center">
        <button type="button" onClick={() => setConfirming(true)} className={btnQuiet}>
          {release ? "I can't make it" : "Tell my host I can't come"}
        </button>
        {release && <p className="text-xs text-ink-soft">Free until {formatDeadline(c.releaseUntil)}</p>}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Confirm you cannot come" className="mt-4 rounded-2xl border border-hold-100 bg-hold-50 p-4 text-hold-800">
      <p className="font-medium">{release ? 'Release your spot?' : 'Tell your host you cannot come?'}</p>
      <p className="mt-1 text-sm">
        {release
          ? `${holding ? 'Your hold is released right away' : 'You come off the list'}, you pay nothing and your host can rebook. Cannot be undone.`
          : "It's too close to the start to release your hold yourself. Your host decides, and it stays until then."}
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={busy !== null} onClick={onConfirm} className={btnPrimary}>
          {busy === 'cancelling' ? 'One moment…' : release ? 'Yes, release my spot' : 'Yes, tell my host'}
        </button>
        <button type="button" onClick={() => setConfirming(false)} className={btnQuiet}>Keep my spot</button>
      </div>
    </div>
  );
}

function ShareLine({ share, money }: { share: { amountCents: number; status: string }; money: (c: number) => string }) {
  const bad = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'UNCLAIMED', 'ONHOLD'].includes(share.status);
  return (
    <p className="mt-2 font-medium">
      Your share of the no-show deposit: {money(share.amountCents)}{' '}
      <span className="font-normal text-ink-soft">
        {bad ? '(there was a problem sending it; your host will sort it out)' : '(on its way to your PayPal)'}
      </span>
    </p>
  );
}

/** Collapsed by default: the explanation is one tap away, not in the way. */
function HowItWorks({ amount, potMode }: { amount: string; potMode: 'share' | 'keep' }) {
  return (
    <details className="group mt-6 border-t border-line pt-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between font-medium">
        How it works<Icon name="plus" className="size-4 text-ink-soft group-open:rotate-45" />
      </summary>
      <ol className="mt-2 space-y-3 text-ink-soft">
        <Step n={1}>You approve a hold of {amount} on PayPal. Nothing is charged.</Step>
        <Step n={2}>Show up and the hold is released. You pay nothing.</Step>
        <Step n={3}>{potMode === 'keep' ? "Don't show up and it is charged and goes to your host." : "Don't show up and it is charged and shared with the people who came."}</Step>
      </ol>
      <p className="mt-4 text-xs text-ink-soft">PayPal sandbox, so no real money moves.</p>
    </details>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800" aria-hidden="true">{n}</span>
      <span>{children}</span>
    </li>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <Page>{children}</Page>;
}

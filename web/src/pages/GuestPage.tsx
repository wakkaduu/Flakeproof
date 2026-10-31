import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, guestApi, type GuestApi, type GuestView } from '../api';
import { formatMoney, formatWhen } from '../lib/format';

export type PayPalReturn = 'return' | 'cancel' | null;

interface Props {
  token: string;
  /** What PayPal told the browser when it sent the guest back (?paypal=return|cancel). */
  paypalReturn?: PayPalReturn;
  api?: GuestApi;
  /** Where to send the browser for PayPal approval. Injected so tests don't navigate. */
  navigate?: (url: string) => void;
}

type Busy = null | 'starting' | 'confirming';
interface Notice { tone: 'info' | 'warn'; text: string }

export function GuestPage({ token, paypalReturn = null, api = guestApi, navigate = (u) => window.location.assign(u) }: Props) {
  const [view, setView] = useState<GuestView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const handledReturn = useRef(false);

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
        <Card><p role="status" className="text-ink-soft">Loading your invite…</p></Card>
      </Shell>
    );
  }

  const { event } = view;
  const amount = formatMoney(event.depositCents, event.currency);

  return (
    <Shell>
      <p className="text-sm text-ink-soft">Hi {view.guestName}</p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">{event.title}</h1>

      <Card className="mt-5">
        <dl className="grid grid-cols-2 gap-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-soft">When</dt>
            <dd className="mt-1 font-medium">{formatWhen(event.startsAt)}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-soft">Deposit</dt>
            <dd className="mt-1 text-2xl font-bold tabular-nums">{amount}</dd>
          </div>
        </dl>
      </Card>

      <div aria-live="polite" className="mt-5 space-y-4">
        {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
        {busy === 'confirming' && <Banner tone="info">Confirming with PayPal…</Banner>}
        <StatusPanel view={view} amount={amount} busy={busy} onApprove={approve} />
      </div>

      <HowItWorks amount={amount} />
    </Shell>
  );
}

function StatusPanel({ view, amount, busy, onApprove }: { view: GuestView; amount: string; busy: Busy; onApprove: () => void }) {
  const { event, outcome, share } = view;
  const money = (c: number) => formatMoney(c, event.currency);

  if (view.canApprove) {
    return (
      <Card tone="neutral">
        <h2 className="text-lg font-semibold">Hold {amount} to confirm your spot</h2>
        <p className="mt-1 text-ink-soft">
          You approve it on PayPal. It is only a hold: <strong>nothing is charged</strong>.
        </p>
        <button
          type="button"
          onClick={onApprove}
          disabled={busy !== null}
          className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-ink px-5 py-3 text-base font-semibold text-white transition hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'starting' ? 'Opening PayPal…' : 'Approve with PayPal'}
        </button>
        <p className="mt-3 text-sm text-ink-soft">
          On PayPal's page the final button says “Complete Purchase”. Here it only places the hold.
        </p>
      </Card>
    );
  }

  if (outcome.kind === 'held') {
    return (
      <Card tone="hold">
        <h2 className="text-lg font-semibold">Your {money(outcome.amountCents ?? event.depositCents)} hold is in place</h2>
        <p className="mt-1">Nothing has been charged. If you show up, the hold is released and you pay nothing.</p>
      </Card>
    );
  }

  if (outcome.kind === 'received') {
    return (
      <Card tone="good">
        <h2 className="text-lg font-semibold">You received {money(outcome.amountCents ?? 0)}</h2>
        <p className="mt-1">Your hold was released, so you paid nothing, and your share of the no-show deposit is in your PayPal account.</p>
      </Card>
    );
  }

  if (outcome.kind === 'nothing_charged') {
    return (
      <Card tone="good">
        <h2 className="text-lg font-semibold">You paid nothing</h2>
        <p className="mt-1">Your hold was released.</p>
        {share && <ShareLine share={share} money={money} />}
      </Card>
    );
  }

  if (outcome.kind === 'charged') {
    return (
      <Card tone="charged">
        <h2 className="text-lg font-semibold">Your {money(outcome.amountCents ?? event.depositCents)} deposit was charged</h2>
        <p className="mt-1">You weren't there, so the deposit goes to the people who came. Talk to your host if that's a mistake.</p>
      </Card>
    );
  }

  return (
    <Card tone="neutral">
      <h2 className="text-lg font-semibold">Deposits are closed</h2>
      <p className="mt-1 text-ink-soft">This event has ended, so a deposit can't be placed any more.</p>
    </Card>
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

function HowItWorks({ amount }: { amount: string }) {
  return (
    <section className="mt-8" aria-labelledby="how">
      <h2 id="how" className="text-sm font-semibold uppercase tracking-wide text-ink-soft">How it works</h2>
      <ol className="mt-3 space-y-3">
        <Step n={1}>You approve a hold of {amount} on PayPal. Nothing is charged.</Step>
        <Step n={2}>Show up and the hold is released. You pay nothing.</Step>
        <Step n={3}>Don't show up and the deposit is charged and shared with the people who did.</Step>
      </ol>
      <p className="mt-6 text-xs text-ink-soft">
        Test mode: this runs on PayPal's sandbox, so no real money moves.
      </p>
    </section>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-good-100 text-sm font-semibold text-good-800" aria-hidden="true">{n}</span>
      <span>{children}</span>
    </li>
  );
}

const TONES = {
  neutral: 'bg-white border-line',
  hold: 'bg-hold-50 border-hold-100 text-hold-800',
  good: 'bg-good-50 border-good-100 text-good-800',
  charged: 'bg-charged-50 border-charged-100 text-charged-800',
} as const;

function Card({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: keyof typeof TONES; className?: string }) {
  return <div className={`rounded-2xl border p-5 shadow-card ${TONES[tone]} ${className}`}>{children}</div>;
}

function Banner({ tone, children }: { tone: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div role={tone === 'warn' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${tone === 'warn' ? 'border-hold-100 bg-hold-50 text-hold-800' : 'border-line bg-white text-ink-soft'}`}>
      {children}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 pb-12 pt-[max(1.5rem,env(safe-area-inset-top))]">
      <p className="mb-6 text-sm font-bold tracking-tight text-good-700">Flakeproof</p>
      {children}
    </main>
  );
}

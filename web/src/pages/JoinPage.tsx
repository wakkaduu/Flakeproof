import { useEffect, useState } from 'react';
import { ApiError, joinApi, type JoinApi, type JoinView } from '../api';
import { Avatar, Banner, btnPrimary, Card, EventHeader, fieldInput, Icon, Page, Skeleton } from '../components/ui';
import { formatDeadline, formatMoney } from '../lib/format';
import { recallJoined, rememberJoined } from '../lib/joined';
import { useTitle } from '../lib/useTitle';

interface Props {
  code: string;
  api?: JoinApi;
  /** Where to go after joining. Injected so tests do not navigate. */
  navigate?: (path: string) => void;
}

/** What a friend sees first: the one link from the group chat. Tap your name, get your own page. */
export function JoinPage({ code, api = joinApi, navigate = (p) => window.location.assign(p) }: Props) {
  const [view, setView] = useState<JoinView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  useTitle(view ? view.event.title : 'You are invited');

  // Back on the same phone: go straight to your own page.
  const back = recallJoined(code);
  useEffect(() => { if (back) navigate(`/g/${back.token}`); }, [back, navigate]);

  useEffect(() => {
    if (back) return;
    let off = false;
    api.getJoin(code).then((v) => { if (!off) setView(v); }, (e) => { if (!off) setLoadError(e as ApiError); });
    return () => { off = true; };
  }, [api, code, back]);

  async function join(who: { guestId: string } | { name: string }) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const j = await api.join(code, who);
      rememberJoined(code, { token: j.inviteToken, name: j.name });
      navigate(`/g/${j.inviteToken}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
      // A name may have just been taken by someone else: refresh the list.
      api.getJoin(code).then(setView, () => {});
    }
  }

  if (back) return <Page><p role="status" className="text-ink-soft">Welcome back, {back.name}. Opening your page…</p></Page>;
  if (loadError) {
    return (
      <Page>
        <Card><h1 className="text-xl font-semibold">{loadError.status === 404 ? "This link isn't valid" : "Couldn't load the invite"}</h1>
          <p className="mt-2 text-ink-soft">{loadError.status === 404 ? 'Ask your host to send the link again.' : loadError.message}</p></Card>
      </Page>
    );
  }
  if (!view) {
    return (
      <Page>
        <p role="status" className="sr-only">Loading the invite…</p>
        <Skeleton className="h-36" /><Skeleton className="mt-4 h-40" />
      </Page>
    );
  }

  const { event, holds } = view;
  const money = formatMoney(event.depositCents, event.currency);
  const free = view.names.filter((n) => !n.taken);
  const cutoff = event.graceHours > 0 ? `until ${event.graceHours >= 24 && event.graceHours % 24 === 0 ? `${event.graceHours / 24} day${event.graceHours === 24 ? '' : 's'}` : `${event.graceHours} hours`} before` : 'until the start';

  return (
    <Page>
      <EventHeader title={event.title} startsAt={event.startsAt}>
        <p className="mt-4 flex items-baseline justify-between gap-3 border-t border-line pt-3">
          <span className="text-ink-soft">Deposit, only a hold</span>
          <span className="text-2xl font-bold tabular-nums">{money}</span>
        </p>
        {view.joinedCount > 0 && <p className="mt-2 text-sm text-ink-soft"><strong className="text-ink">{view.joinedCount}</strong> {view.joinedCount === 1 ? 'person is' : 'people are'} in.</p>}
      </EventHeader>

      {!view.joinable ? (
        <Card className="mt-4"><h2 className="text-lg font-semibold">This event has started</h2><p className="mt-1 text-ink-soft">Nobody can join any more.</p></Card>
      ) : (
        <section className="mt-5" aria-labelledby="who-h">
          <h2 id="who-h" className="text-xl font-semibold">Who are you?</h2>
          {error && <div className="mt-3"><Banner tone="hold" alert>{error}</Banner></div>}

          {view.names.length > 0 && (
            <ul className="mt-3 grid gap-2">
              {view.names.map((n) => (
                <li key={n.id}>
                  <button type="button" disabled={n.taken || busy} onClick={() => void join({ guestId: n.id })}
                    className={`flex min-h-14 w-full items-center gap-3 rounded-xl border px-4 py-2 text-left text-lg font-medium transition ${n.taken ? 'border-line bg-stone-50 text-ink-soft' : 'border-line bg-white hover:bg-brand-50'} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed`}>
                    <Avatar name={n.name} />
                    <span className="flex-1">{n.name}</span>
                    {n.taken && <span className="text-sm font-normal text-ink-soft">Taken</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {view.canAddName && (
            <form className="mt-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void join({ name: name.trim() }); }}>
              <label htmlFor="your-name" className="block text-base font-medium">{free.length > 0 ? 'Not on the list? Type your name' : 'Your name'}</label>
              <div className="mt-2 flex gap-2">
                <input id="your-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="given-name" className={fieldInput} />
                <button type="submit" disabled={!name.trim() || busy} className={`${btnPrimary} shrink-0 px-6`}>{busy ? 'Joining…' : 'Join'}</button>
              </div>
            </form>
          )}
          {!view.canAddName && free.length === 0 && <p className="mt-3 text-ink-soft">This event is full. Ask your host.</p>}
        </section>
      )}

      <details className="group mt-6 border-t border-line pt-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between font-medium">
          How the deposit works<Icon name="plus" className="size-4 text-ink-soft group-open:rotate-45" />
        </summary>
        <ul className="mt-2 space-y-2 text-ink-soft">
          <li className="flex gap-2"><Icon name="lock" className="mt-1 size-4" />You put down {money} on PayPal. It is only a hold.{holds.state === 'not_yet' && <> Deposits open <strong className="text-ink">{formatDeadline(holds.opensAt)}</strong>; you can join now.</>}</li>
          <li className="flex gap-2"><Icon name="check" className="mt-1 size-4" />You come: it disappears and you pay nothing.</li>
          <li className="flex gap-2"><Icon name="clock" className="mt-1 size-4" />Plans change: cancel free {cutoff}.</li>
          <li className="flex gap-2"><Icon name="dollar" className="mt-1 size-4" />You don't come: it is charged and {event.potMode === 'keep' ? 'goes to your host to cover the booking' : 'shared with the people who came'}.</li>
        </ul>
        <p className="mt-3 text-xs text-ink-soft">PayPal sandbox, so no real money moves.</p>
      </details>
    </Page>
  );
}

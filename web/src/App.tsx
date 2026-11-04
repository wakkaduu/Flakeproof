import type { ReactNode } from 'react';
import { btnPrimary, Icon, Page, type IconName } from './components/ui';
import { JoinPage } from './pages/JoinPage';
import { GuestPage, type PayPalReturn } from './pages/GuestPage';
import { loadRecent } from './lib/recentEvents';
import { HostPage } from './pages/HostPage';
import { NewEventPage } from './pages/NewEventPage';

function parseReturn(search: string): PayPalReturn {
  const v = new URLSearchParams(search).get('paypal');
  return v === 'return' || v === 'cancel' ? v : null;
}

/** Tiny router: only the routes the demo needs. */
export function App({ path = window.location.pathname, search = window.location.search }: { path?: string; search?: string }) {
  const guest = /^\/g\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  if (guest?.[1]) return <GuestPage token={guest[1]} paypalReturn={parseReturn(search)} />;
  const join = /^\/e\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  if (join?.[1]) return <JoinPage code={join[1]} />;
  if (/^\/new\/?$/.test(path)) return <NewEventPage />;
  const host = /^\/host\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  if (host?.[1]) return <HostPage token={host[1]} />;
  return <Home />;
}

function Home() {
  return (
    <Page wide>
      <div className="lg:grid lg:grid-cols-2 lg:items-center lg:gap-14 lg:pt-8">
        <div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight lg:text-5xl">A deposit that costs you nothing if you show up.</h1>
          <p className="mt-4 text-lg text-ink-soft">For the court, the table or the cabin you already booked.</p>
          <a href="/new" className={`${btnPrimary} mt-6 w-full lg:w-auto lg:px-8`}>Create an event<Icon name="arrow" className="size-5" /></a>
        </div>

        <section className="mt-10 lg:mt-0" aria-labelledby="how-h">
          <h2 id="how-h" className="sr-only">How it works</h2>
          <ol className="space-y-4">
            <HowStep icon="chat" title="Share one link">Friends tap their name. No accounts.</HowStep>
            <HowStep icon="lock" title="Friends put down a deposit">Nothing is charged.</HowStep>
            <HowStep icon="check" title="They show up, they pay nothing" />
            <HowStep icon="dollar" title="Someone flakes">It covers the booking or goes to those who came.</HowStep>
          </ol>
        </section>
      </div>
      <RecentEvents />
      <p className="mt-12 text-xs text-ink-soft">Sandbox, fake money. An AI helps set up events and only suggests on no-shows.</p>
    </Page>
  );
}

function HowStep({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700"><Icon name={icon} className="size-5" /></span>
      <span><span className="block font-semibold">{title}</span><span className="text-ink-soft">{children}</span></span>
    </li>
  );
}

function RecentEvents() {
  const recent = loadRecent();
  if (recent.length === 0) return null;
  return (
    <section className="mt-10" aria-labelledby="recent-h">
      <h2 id="recent-h" className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Events you created on this device</h2>
      <ul className="mt-2 space-y-2 lg:max-w-md">
        {recent.map((e) => (
          <li key={e.hostPath}>
            <a href={e.hostPath} className="flex min-h-11 items-center justify-between rounded-2xl border border-line bg-white px-4 py-2">
              <span className="font-medium">{e.title}</span>
              <span className="flex items-center gap-2 text-sm text-ink-soft">{new Date(e.createdAt).toLocaleDateString()}<Icon name="arrow" className="size-4" /></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

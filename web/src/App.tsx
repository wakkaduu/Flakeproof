import { GuestPage, type PayPalReturn } from './pages/GuestPage';
import { NewEventPage } from './pages/NewEventPage';

function parseReturn(search: string): PayPalReturn {
  const v = new URLSearchParams(search).get('paypal');
  return v === 'return' || v === 'cancel' ? v : null;
}

/** Tiny router: only the routes the demo needs. */
export function App({ path = window.location.pathname, search = window.location.search }: { path?: string; search?: string }) {
  const guest = /^\/g\/([A-Za-z0-9_-]{16,64})\/?$/.exec(path);
  if (guest?.[1]) return <GuestPage token={guest[1]} paypalReturn={parseReturn(search)} />;
  if (/^\/new\/?$/.test(path)) return <NewEventPage />;
  if (/^\/host\/[A-Za-z0-9_-]{16,64}\/?$/.test(path)) return <HostSoon />;
  return <Home />;
}

function Home() {
  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 py-10">
      <p className="text-sm font-bold tracking-tight text-good-700">Flakeproof</p>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">A deposit that costs you nothing if you show up.</h1>
      <p className="mt-3 text-ink-soft">Open the invite link your host sent you to confirm your spot.</p>
      <a href="/new" className="mt-6 flex min-h-12 items-center justify-center rounded-xl bg-ink px-5 py-3 text-base font-semibold text-white">Host an event</a>
    </main>
  );
}

function HostSoon() {
  return (
    <main className="mx-auto min-h-dvh max-w-md px-4 py-10">
      <p className="text-sm font-bold tracking-tight text-good-700">Flakeproof</p>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">Host page</h1>
      <p className="mt-2 text-ink-soft">Marking who showed up and approving the money comes in the next step. Keep this link; it is your host key.</p>
    </main>
  );
}

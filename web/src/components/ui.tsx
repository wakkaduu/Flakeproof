// Shared pieces for every screen. One look: an invitation, not a payments console.
// Say "deposit" and "hold" (people know them from hotels and fuel pumps); keep PayPal jargon out of the UI.
import type { ReactNode } from 'react';
import { formatWhen } from '../lib/format';

// ---- icons: inline, decorative (the text next to them carries the meaning) ----------------------
const PATHS: Record<string, string> = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  share: 'M12 15V4m0 0L8 8m4-4l4 4M5 13v7h14v-7',
  arrow: 'M5 12h14m0 0l-5-5m5 5l-5 5',
  alert: 'M12 8v5m0 3.5v.01M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z',
  quote: 'M7 17h3l1-5V7H6v5h3M15 17h3l1-5V7h-5v5h3',
  users: 'M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 19v-1a3 3 0 0 0-2.5-3M15 5.2a3 3 0 0 1 0 5.6',
  dollar: 'M12 4v16M16 8.5c0-1.4-1.8-2.5-4-2.5s-4 1.1-4 2.5S9.8 11 12 11s4 1.1 4 2.5-1.8 2.5-4 2.5-4-1.1-4-2.5',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  door: 'M6 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M4 20h16M13 12v.01',
  calendar: 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4',
  chat: 'M4 5h16v11H9l-5 4z',
  plus: 'M12 5v14M5 12h14',
};
export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-5', draw = false }: { name: IconName; className?: string; draw?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`${className} shrink-0 ${draw ? 'draw-check' : ''}`} aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

// ---- shared control styles -----------------------------------------------------------------------
export const ring = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';
export const btnPrimary = `flex min-h-13 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-brand-700 ${ring} disabled:cursor-not-allowed disabled:opacity-60`;
export const btnSecondary = `flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-base font-medium transition hover:bg-brand-50 ${ring} disabled:opacity-60`;
export const btnQuiet = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-base font-medium text-ink-soft underline-offset-4 transition hover:text-ink hover:underline ${ring} disabled:opacity-60`;
export const fieldInput = `min-h-12 w-full rounded-xl border border-line bg-white px-3 py-2 text-base ${ring}`;

// ---- surfaces ----------------------------------------------------------------------------------------
const TONES = {
  neutral: 'bg-white border-line',
  brand: 'bg-brand-50 border-brand-100 text-ink',
  hold: 'bg-hold-50 border-hold-100 text-hold-800',
  good: 'bg-good-50 border-good-100 text-good-800',
  charged: 'bg-charged-50 border-charged-100 text-charged-800',
} as const;
export type Tone = keyof typeof TONES;

export function Card({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <div className={`rounded-2xl border p-5 shadow-card ${TONES[tone]} ${className}`}>{children}</div>;
}

export function Banner({ tone, alert, children }: { tone: 'info' | 'hold' | 'charged'; alert?: boolean; children: ReactNode }) {
  const cls = tone === 'info' ? 'border-line bg-white text-ink-soft' : TONES[tone];
  return (
    <div role={alert ? 'alert' : 'status'} className={`flex gap-2 rounded-2xl border px-4 py-3 text-sm ${cls}`}>
      {tone !== 'info' && <Icon name="alert" className="mt-0.5 size-4" />}
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-2xl bg-stone-200/70 ${className}`} />;
}

export function Wordmark({ suffix }: { suffix?: string }) {
  return (
    <p className="flex items-center gap-2 text-base font-bold tracking-tight text-brand-700">
      <span className="flex size-7 items-center justify-center rounded-lg bg-brand-600 text-white"><Icon name="check" className="size-4" /></span>
      Flakeproof{suffix && <span className="font-normal text-ink-soft">· {suffix}</span>}
      <span className="rounded-full border border-line px-2 py-0.5 text-xs font-medium text-ink-soft" title="PayPal sandbox: no real money moves">Sandbox</span>
    </p>
  );
}

/** Page frame: centred, phone-first, wider on desktop when asked. */
export function Page({ children, wide = false, suffix, bar }: { children: ReactNode; wide?: boolean; suffix?: string; bar?: ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">Skip to the content</a>
      <main id="main" className={`mx-auto min-h-dvh px-4 pb-16 pt-[max(1.25rem,env(safe-area-inset-top))] ${wide ? 'max-w-md lg:max-w-5xl' : 'max-w-md'}`}>
        <div className="mb-5"><a href="/" aria-label="Flakeproof home"><Wordmark suffix={suffix} /></a></div>
        {children}
      </main>
      {bar}
    </>
  );
}

// ---- people and events ---------------------------------------------------------------------------------------
const AVATARS = [
  'bg-rose-100 text-rose-800', 'bg-amber-100 text-amber-900', 'bg-lime-100 text-lime-900', 'bg-emerald-100 text-emerald-900',
  'bg-sky-100 text-sky-900', 'bg-indigo-100 text-indigo-900', 'bg-fuchsia-100 text-fuchsia-900', 'bg-orange-100 text-orange-900',
];
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const initials = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
};

/** A name as a soft coloured circle. Decorative: the name is always written next to it. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'size-14 text-xl' : size === 'sm' ? 'size-8 text-xs' : 'size-11 text-base';
  return <span aria-hidden="true" className={`flex ${dim} shrink-0 items-center justify-center rounded-full font-semibold ${AVATARS[hash(name.toLowerCase()) % AVATARS.length]}`}>{initials(name)}</span>;
}

const CHIP = {
  good: 'bg-good-100 text-good-800', hold: 'bg-hold-100 text-hold-800', charged: 'bg-charged-100 text-charged-800',
  neutral: 'bg-stone-100 text-stone-700', brand: 'bg-brand-100 text-brand-800',
} as const;
/** A short status word. Always text; the colour only backs it up. */
export function Chip({ tone = 'neutral', icon, children }: { tone?: keyof typeof CHIP; icon?: IconName; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium ${CHIP[tone]}`}>{icon && <Icon name={icon} className="size-3.5" />}{children}</span>;
}

/** The top of every event screen: the name and when, on a calm card with one accent edge. */
export function EventHeader({ title, startsAt, children }: { title: string; startsAt: string; children?: ReactNode }) {
  return (
    <header className="rounded-2xl border border-line border-l-4 border-l-brand-600 bg-white p-5 shadow-card">
      <h1 className="text-3xl font-bold leading-tight tracking-tight [overflow-wrap:anywhere]">{title}</h1>
      <p className="mt-2 flex items-center gap-2 text-ink-soft"><Icon name="calendar" className="size-4" />{formatWhen(startsAt)}</p>
      {children}
    </header>
  );
}

// ---- two choices that look like one control -------------------------------------------------------------------
export interface Segment<T extends string> { value: T; label: string; icon: IconName; tone: 'good' | 'charged' | 'ink' }
/** The selected side is solid; the unselected side stays neutral, so "nothing chosen yet" is visibly different. */
export function SegmentedControl<T extends string>({ label, value, onChange, segments, disabled }: {
  label: string; value: T | null; onChange: (v: T) => void; segments: [Segment<T>, Segment<T>]; disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-1 rounded-2xl bg-stone-100 p-1">
      {segments.map((s) => {
        const on = value === s.value;
        const solid = s.tone === 'good' ? 'bg-good-700 text-white' : s.tone === 'charged' ? 'bg-charged-800 text-white' : 'bg-ink text-white';
        return (
          <button key={s.value} type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(s.value)}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-base font-medium transition ${ring} disabled:opacity-60 ${on ? solid : 'bg-white text-ink hover:bg-brand-50'}`}>
            <Icon name={s.icon} className="size-4" />{s.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- receipt: the payoff screen ------------------------------------------------------------------------------------
export interface ReceiptLine { label: string; value: string; strong?: boolean; sub?: boolean }
export function Receipt({ title, lines, children }: { title: string; lines: ReceiptLine[]; children?: ReactNode }) {
  return (
    <dl aria-label={title} className="mt-3 divide-y divide-current/10 rounded-2xl bg-white/70 px-4 py-1 text-ink">
      {lines.map((l, i) => (
        <div key={`${l.label}-${i}`} className={`rise flex items-baseline justify-between gap-4 py-2 ${l.strong ? 'font-semibold' : ''} ${l.sub ? 'text-sm text-ink-soft' : ''}`} style={{ animationDelay: `${i * 60}ms` }}>
          <dt>{l.label}</dt>
          <dd className="text-right font-semibold tabular-nums">{l.value}</dd>
        </div>
      ))}
      {children}
    </dl>
  );
}

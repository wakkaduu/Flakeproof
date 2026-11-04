import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestView, HostGuest, HostView, JoinView } from '../src/api';
import { App } from '../src/App';
import { GuestPage } from '../src/pages/GuestPage';
import { HostPage } from '../src/pages/HostPage';
import { JoinPage } from '../src/pages/JoinPage';

afterEach(() => cleanup());

/** Words a person sees without opening anything: collapsed explanations (<details>) do not count. */
function visibleWords(root: HTMLElement): number {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('details > :not(summary), [aria-hidden="true"], .sr-only, script, style').forEach((n) => n.remove());
  return (clone.textContent ?? '').split(/\s+/).filter(Boolean).length;
}

const guestView: GuestView = {
  guestName: 'Ana', event: { title: 'Court booking', startsAt: '2026-11-07T18:00:00.000Z', depositCents: 2000, currency: 'USD', status: 'open', potMode: 'share' },
  holds: { state: 'open', opensAt: '2026-11-04T18:00:00.000Z' }, stage: 'invited', depositStatus: null, outcome: { kind: 'none' }, share: null, canApprove: true,
  cancel: { releaseUntil: '2026-11-06T18:00:00.000Z', state: null, cancelledAt: null, can: 'release' },
};
const joinView: JoinView = {
  event: { title: 'Court booking', startsAt: '2026-11-07T18:00:00.000Z', depositCents: 2000, currency: 'USD', status: 'open', potMode: 'share', graceHours: 24 },
  holds: { state: 'open', opensAt: '2026-11-04T18:00:00.000Z' }, names: [{ id: 'a', name: 'Ana', taken: false }, { id: 'b', name: 'Ben', taken: false }],
  joinable: true, canAddName: true, joinedCount: 1,
};
const g = (name: string, over: Partial<HostGuest> = {}): HostGuest => ({
  id: name, name, inviteUrl: 'u', attendance: 'unknown', decision: null, ai: null, stage: 'authorized', joined: true,
  deposit: { status: 'authorized', amountCents: 2000, feeCents: null, netCents: null, payerEmail: null }, payout: null, ...over,
});
const hostView: HostView = {
  id: 'e', title: 'Court booking', startsAt: '2026-11-07T18:00:00.000Z', depositCents: 2000, currency: 'USD', status: 'open', graceMinutes: 1440, potMode: 'share',
  joinUrl: 'http://x/e/abc', settlementApproved: false, canSettle: false, blockers: [], warnings: [], problems: [],
  guests: [g('Ana'), g('Ben'), g('Cy'), g('Dee', { deposit: null, stage: 'invited' })], payoutPreview: null, payout: null,
};

// Budgets are deliberately tight: a screen that needs more words than this should hide the rest behind a tap.
describe('screens stay light on words', () => {
  it('landing', () => {
    const { container } = render(<App path="/" search="" />);
    expect(visibleWords(container)).toBeLessThanOrEqual(75);
  });

  it('join page', async () => {
    const { container } = render(<JoinPage code={'j'.repeat(32)} api={{ getJoin: vi.fn(async () => joinView), join: vi.fn() }} />);
    await screen.findByText('Who are you?');
    expect(visibleWords(container)).toBeLessThanOrEqual(35);
  });

  it('a friend about to put the deposit down', async () => {
    const { container } = render(<GuestPage token={'t'.repeat(24)} api={{ getGuest: vi.fn(async () => guestView), startDeposit: vi.fn(), authorize: vi.fn(), cancel: vi.fn() }} />);
    await screen.findByRole('button', { name: 'Approve with PayPal' });
    expect(visibleWords(container)).toBeLessThanOrEqual(50);
  });

  it('the host page while deposits come in', async () => {
    const { container } = render(<HostPage token={'h'.repeat(32)} api={{ getEvent: vi.fn(async () => hostView) } as never} copy={vi.fn(async () => {})} pollMs={999999} />);
    await screen.findByRole('heading', { name: 'Ana' });
    expect(visibleWords(container)).toBeLessThanOrEqual(60);
  });
});

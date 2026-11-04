// When a friend can put a hold down. PayPal only guarantees an authorization for its honor period (3 days in
// the US), so a hold placed a week ahead may not be capturable after the event. Instead of warning and hoping,
// the invite link works for joining at any time and the hold opens `honorPeriodDays` before the start.

export type HoldWindowState = 'not_yet' | 'open' | 'closed';

export function holdWindow(startsAt: Date, honorPeriodDays: number, now: Date): { opensAt: Date; closesAt: Date; state: HoldWindowState } {
  const opensAt = new Date(startsAt.getTime() - honorPeriodDays * 86_400_000);
  const state: HoldWindowState = now < opensAt ? 'not_yet' : now < startsAt ? 'open' : 'closed';
  return { opensAt, closesAt: startsAt, state };
}

// The only place that decides which state changes are legal. Services call these guards
// before writing, so an illegal transition is a loud bug, not silent data corruption.

export const DEPOSIT_STATUSES = ['pending', 'authorized', 'capture_pending', 'captured', 'voided'] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

const DEPOSIT_TRANSITIONS: Record<DepositStatus, readonly DepositStatus[]> = {
  pending: ['authorized'],
  authorized: ['captured', 'capture_pending', 'voided'],
  capture_pending: ['captured'],
  captured: [],
  voided: [],
};

export const EVENT_STATUSES = ['open', 'ended', 'settled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

const EVENT_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  open: ['ended'],
  ended: ['settled'],
  settled: [],
};

export type Attendance = 'unknown' | 'showed' | 'no_show';
export type Decision = 'capture' | 'forgive';
export type CancelKind = 'released' | 'late_notice';

/** The last moment a friend can release their own hold without asking the host. Same rule the Judge uses. */
export function releaseDeadline(startsAt: Date, graceHours: number): Date {
  return new Date(startsAt.getTime() - graceHours * 3_600_000);
}

export class IllegalTransitionError extends Error {
  constructor(public readonly entity: string, public readonly from: string, public readonly to: string) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
  }
}

export function canDeposit(from: DepositStatus, to: DepositStatus): boolean {
  return DEPOSIT_TRANSITIONS[from].includes(to);
}
export function assertDepositTransition(from: DepositStatus, to: DepositStatus): void {
  if (!canDeposit(from, to)) throw new IllegalTransitionError('deposit', from, to);
}
export function assertEventTransition(from: EventStatus, to: EventStatus): void {
  if (!EVENT_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError('event', from, to);
}

/** What PayPal action a held deposit needs, given the guest's attendance and the host's decision. */
export function settlementAction(
  attendance: Attendance,
  decision: Decision | null,
): 'void' | 'capture' | 'undecided' {
  if (attendance === 'showed') return 'void';
  if (attendance === 'no_show') {
    if (decision === 'capture') return 'capture';
    if (decision === 'forgive') return 'void';
  }
  return 'undecided';
}

export type GuestStage =
  | 'invited' | 'authorized' | 'showed' | 'no_show' | 'voided' | 'captured' | 'paid_out' | 'cancelled';

/** The per-guest story the host and guest see: invited -> authorized -> showed/no-show -> voided/captured -> paid out. */
export function deriveGuestStage(g: {
  attendance: Attendance;
  depositStatus: DepositStatus | null;
  payoutItemStatus: string | null;
  /** The friend released their own hold ahead of the cutoff. */
  releasedEarly?: boolean;
}): GuestStage {
  if (g.releasedEarly) return 'cancelled';
  if (g.payoutItemStatus === 'SUCCESS') return 'paid_out';
  if (g.depositStatus === 'captured' || g.depositStatus === 'capture_pending') return 'captured';
  if (g.depositStatus === 'voided') return 'voided';
  if (g.attendance === 'showed') return 'showed';
  if (g.attendance === 'no_show') return 'no_show';
  if (g.depositStatus === 'authorized') return 'authorized';
  return 'invited';
}

import type { Prisma } from '@prisma/client';
import type { Attendance, Decision, DepositStatus } from '../domain/stateMachine.js';

export const eventInclude = {
  guests: { include: { deposit: true, payoutItem: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  payout: { include: { items: true } },
} satisfies Prisma.EventInclude;
export type EventFull = Prisma.EventGetPayload<{ include: typeof eventInclude }>;
export type GuestFull = EventFull['guests'][number];

export const attendanceOf = (g: { attendance: string }) => g.attendance as Attendance;
export const decisionOf = (g: { decision: string | null }) => g.decision as Decision | null;
export const depositStatusOf = (d: { status: string }) => d.status as DepositStatus;

/** PayPal payout item statuses that need a human; we never auto-retry money. */
export const BAD_PAYOUT_STATUSES = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'UNCLAIMED', 'ONHOLD']);

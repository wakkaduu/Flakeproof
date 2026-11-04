import type { AppConfig } from '../config.js';
import { estimateCaptureNet, planPayout } from '../domain/money.js';
import { attendanceOf, decisionOf, depositStatusOf, releasedEarly, type EventFull } from './shared.js';

/**
 * What would happen to the money if the host settled right now. An ESTIMATE (capture fees are
 * approximated); the real payout always uses PayPal's reported amounts. Its job is to stop the
 * host from capturing a no-show's deposit when nobody could receive it.
 */
export interface PayoutPreview {
  /** Attendance is still unknown for someone with a held deposit, so recipients may change. */
  provisional: boolean;
  capturingCount: number;
  recipientCount: number;
  estimatedPotCents: number;
  /** Smallest estimated share, or null when nothing would be paid. */
  estimatedPerPersonCents: number | null;
  /** null = fine or nothing to capture. */
  problem: 'no_recipients' | 'pot_too_small' | null;
  /** Showed up and paid, but PayPal gave no email, so they cannot be paid. */
  unpayableNames: string[];
  /** share = paid to the people who came; keep = the host keeps it. */
  mode: 'share' | 'keep';
}

export function payoutPreview(ev: EventFull, cfg: AppConfig): PayoutPreview {
  const held = ev.guests.filter((g) => g.deposit && ['authorized', 'capture_pending', 'captured', 'voided'].includes(g.deposit.status));
  const provisional = held.some((g) => g.deposit!.status === 'authorized' && attendanceOf(g) === 'unknown');

  const capturing = ev.guests.filter(
    (g) => g.deposit && attendanceOf(g) === 'no_show' && decisionOf(g) === 'capture' && depositStatusOf(g.deposit) !== 'voided',
  );
  const attendees = ev.guests.filter((g) => g.deposit && !releasedEarly(g) && attendanceOf(g) === 'showed' && depositStatusOf(g.deposit) !== 'captured');
  const recipients = attendees.filter((g) => g.deposit!.payerEmail);
  const unpayableNames = attendees.filter((g) => !g.deposit!.payerEmail).map((g) => g.name);

  if (ev.potMode === 'keep') {
    const kept = capturing.reduce((s, g) => s + (g.deposit!.netCents ?? estimateCaptureNet(g.deposit!.amountCents, { bps: cfg.captureFeeBps, fixedCents: cfg.captureFeeFixedCents })), 0);
    return { provisional, capturingCount: capturing.length, recipientCount: 0, estimatedPotCents: kept, estimatedPerPersonCents: null, problem: null, unpayableNames: [], mode: 'keep' };
  }
  const nets = capturing.map((g) =>
    // Use the real figure once the capture has happened.
    g.deposit!.netCents ?? estimateCaptureNet(g.deposit!.amountCents, { bps: cfg.captureFeeBps, fixedCents: cfg.captureFeeFixedCents }),
  );
  const plan = planPayout({
    capturedNetCents: nets,
    recipientIds: recipients.map((g) => g.id),
    feePerItemCents: cfg.payoutFeePerItemCents,
    minPerPersonCents: cfg.minPayoutPerPersonCents,
  });
  const perPerson = plan.viable ? Math.min(...plan.items.map((i) => i.amountCents)) : null;
  return {
    provisional,
    capturingCount: capturing.length,
    recipientCount: recipients.length,
    estimatedPotCents: plan.potCents,
    estimatedPerPersonCents: perPerson,
    problem: capturing.length === 0 || plan.viable ? null : plan.reason === 'no_recipients' ? 'no_recipients' : 'pot_too_small',
    unpayableNames,
    mode: 'share',
  };
}

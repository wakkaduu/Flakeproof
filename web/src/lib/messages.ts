// Ready-written messages for the group chat. Hosts paste one link into a chat; they should not have to write the sentence too.
import { formatDeadline, formatMoney, formatWhen } from './format';

export interface MessageEvent { title: string; startsAt: string; depositCents: number; currency: string; potMode?: 'share' | 'keep'; graceHours?: number }

/** The first message: the plan and the one link. */
export function inviteMessage(ev: MessageEvent, joinUrl: string, holdsOpenAt?: string, now: Date = new Date()): string {
  const money = formatMoney(ev.depositCents, ev.currency);
  const cancel = ev.graceHours ? ` Can't make it? Cancel free until ${ev.graceHours >= 24 && ev.graceHours % 24 === 0 ? `${ev.graceHours / 24} day${ev.graceHours === 24 ? '' : 's'} before` : `${ev.graceHours} h before`}.` : '';
  const later = holdsOpenAt && new Date(holdsOpenAt) > now ? ` Deposits open ${formatDeadline(holdsOpenAt)}.` : '';
  return `${ev.title}, ${formatWhen(ev.startsAt)}. Tap your name to confirm your spot with a ${money} deposit. It is only a hold: nothing is charged if you show up.${cancel}${later}\n${joinUrl}`;
}

/** The nudge: who is still missing, named, so nobody has to scroll up to find the link. */
export function nudgeMessage(ev: MessageEvent, joinUrl: string, names: string[]): string {
  const money = formatMoney(ev.depositCents, ev.currency);
  const who = names.length ? `${names.join(', ')}: ` : '';
  return `${who}deposits are open for ${ev.title}. Put down ${money} here (it is only a hold, nothing is charged if you show up):\n${joinUrl}`;
}

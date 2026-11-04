import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, Chip, EventHeader, SegmentedControl } from '../src/components/ui';
import { reminderIcs } from '../src/lib/ics';
import { inviteMessage, nudgeMessage } from '../src/lib/messages';

afterEach(() => cleanup());

describe('reminderIcs', () => {
  it('is a valid single-event calendar file that fires when deposits open', () => {
    const ics = reminderIcs({ title: 'Court, "A"; night', opensAt: '2026-11-04T18:00:00.000Z', startsAt: '2026-11-07T18:00:00.000Z', url: 'https://x.test/g/abc', uid: 'u1' });
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.at(-1)).toBe('END:VCALENDAR');
    expect(ics).toContain('DTSTART:20261104T180000Z');
    expect(ics).toContain('DTEND:20261104T181500Z');
    expect(ics).toContain('TRIGGER:PT0M');
    expect(ics).toContain('SUMMARY:Put down your deposit for Court\\, "A"\; night'); // commas and semicolons are escaped
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).not.toMatch(/[^\r]\n/); // CRLF only
  });
});

describe('group chat messages', () => {
  const ev = { title: 'Court booking', startsAt: '2026-11-07T18:00:00.000Z', depositCents: 2000, currency: 'USD', graceHours: 24 };
  it('writes the plan and the one link, and is honest that it is only a hold', () => {
    const m = inviteMessage(ev, 'https://x.test/e/abc', undefined);
    expect(m).toContain('Court booking');
    expect(m).toContain('$20.00 deposit');
    expect(m).toContain('nothing is charged if you show up');
    expect(m).toContain('Cancel free until 1 day before');
    expect(m.endsWith('https://x.test/e/abc')).toBe(true);
  });
  it('mentions when deposits open only if that is still in the future', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    expect(inviteMessage(ev, 'u', '2026-11-04T18:00:00.000Z', now)).toContain('Deposits open');
    expect(inviteMessage(ev, 'u', '2026-10-30T18:00:00.000Z', now)).not.toContain('Deposits open');
  });
  it('names the people who are still missing in the reminder', () => {
    expect(nudgeMessage(ev, 'u', ['Ben', 'Dee'])).toMatch(/^Ben, Dee: deposits are open for Court booking/);
    expect(nudgeMessage(ev, 'u', [])).toMatch(/^deposits are open/);
  });
});

describe('components', () => {
  it('keeps long names inside the header, writes the date as text, and uses no emoji', () => {
    render(<EventHeader title={'A'.repeat(120)} startsAt="2026-11-07T18:00:00.000Z" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('[overflow-wrap:anywhere]');
    expect(screen.getByText(/November 7|November 8/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('shows an avatar as decoration only and a chip as words', () => {
    const { container } = render(<><Avatar name="Dee R" /><Chip tone="good" icon="check">Free</Chip></>);
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent('DR');
    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('leaves a two-way choice visibly unchosen until chosen', () => {
    render(<SegmentedControl label="Did Ana come?" value={null} onChange={() => {}} segments={[
      { value: 'a', label: 'Came', icon: 'check', tone: 'good' }, { value: 'b', label: "Didn't come", icon: 'x', tone: 'ink' },
    ]} />);
    for (const b of screen.getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false');
  });
});

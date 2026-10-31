import { describe, expect, it } from 'vitest';
import { flagLines, highlight } from '../src/lib/transcript';

describe('flagLines (the lines the host should compare with the screenshots)', () => {
  const chat = [
    '[Mon, 2 Nov 09:12] Sam: the court at Riverside is $40 for 2 hours',
    '[Mon, 2 Nov 09:14] Ana: me!! been dying to play',
    '[Tue, 3 Nov 10:00] Sam: ok sunday it is, 4pm instead. deposit $20',
    '[Tue, 3 Nov 10:05] Ben: lol',
    '[Tue, 3 Nov 11:20] Eli: wait I have a thing sunday, sorry I\'m out',
    '[Tue, 3 Nov 11:21] Cy: 15 bucks is fine',
  ].join('\n');

  it('lists lines with an amount, a day or a time, without their stamp, amounts first', () => {
    expect(flagLines(chat)).toEqual([
      'Sam: the court at Riverside is $40 for 2 hours',
      'Sam: ok sunday it is, 4pm instead. deposit $20',
      'Cy: 15 bucks is fine',
      "Eli: wait I have a thing sunday, sorry I'm out",
    ]);
  });

  it('does not flag a line only because its [Day time] stamp has a day in it', () => {
    expect(flagLines('[Tue, 3 Nov 10:05] Ben: lol')).toEqual([]);
  });

  it('copes with an empty transcript', () => {
    expect(flagLines('')).toEqual([]);
  });
});

describe('highlight', () => {
  it('marks amounts and times and leaves the rest', () => {
    const parts = highlight('Sam: ok sunday it is, 4pm instead. deposit $20.50 each');
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['sunday', '4pm', '$20.50']);
    expect(parts.map((p) => p.text).join('')).toBe('Sam: ok sunday it is, 4pm instead. deposit $20.50 each');
  });

  it('marks "15 bucks" and "5 usd" as amounts', () => {
    expect(highlight('15 bucks or 5 usd').filter((p) => p.hit).map((p) => p.text)).toEqual(['15 bucks', '5 usd']);
  });

  it('returns one plain part when there is nothing to mark', () => {
    expect(highlight('lol')).toEqual([{ text: 'lol', hit: false }]);
  });
});

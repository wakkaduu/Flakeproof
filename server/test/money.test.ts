import { describe, expect, it } from 'vitest';
import { formatCents, parseMoney, planPayout } from '../src/domain/money.js';

describe('formatCents / parseMoney', () => {
  it('round-trips', () => {
    for (const c of [0, 1, 9, 10, 99, 100, 434, 123456]) expect(parseMoney(formatCents(c))).toBe(c);
  });
  it('rejects non-strict formats', () => {
    for (const bad of ['4.3', '4', '4.345', '-1.00', '1e3', ' 4.34', 4.34, null, undefined]) {
      expect(() => parseMoney(bad)).toThrow();
    }
  });
  it('rejects bad cents', () => {
    expect(() => formatCents(1.5)).toThrow();
    expect(() => formatCents(-1)).toThrow();
  });
});

describe('planPayout (pot rule A)', () => {
  const base = { feePerItemCents: 25, minPerPersonCents: 100 };

  it('demo story: one $20 no-show captured, three attendees', () => {
    // $20.00 deposit -> fee 3.49% + 0.49 = 0.70 + 0.49 = 1.19 -> net 18.81 (illustrative)
    const plan = planPayout({ ...base, capturedNetCents: [1881], recipientIds: ['a', 'b', 'c'] });
    expect(plan.viable).toBe(true);
    if (!plan.viable) return;
    expect(plan.potCents).toBe(1881);
    expect(plan.feeReserveCents).toBe(75);
    expect(plan.distributableCents).toBe(1806);
    expect(plan.items.map((i) => i.amountCents)).toEqual([602, 602, 602]);
  });

  it('gives odd cents to the first recipients, one each', () => {
    const plan = planPayout({ ...base, capturedNetCents: [1000], recipientIds: ['a', 'b', 'c'] });
    expect(plan.viable).toBe(true);
    if (!plan.viable) return;
    expect(plan.distributableCents).toBe(925);
    expect(plan.items.map((i) => i.amountCents)).toEqual([309, 308, 308]);
  });

  it('items always sum exactly to distributable (many shapes)', () => {
    for (let pot = 300; pot < 4000; pot += 37) {
      for (let n = 1; n <= 9; n++) {
        const ids = Array.from({ length: n }, (_, i) => `g${i}`);
        const plan = planPayout({ ...base, capturedNetCents: [pot], recipientIds: ids });
        if (!plan.viable) continue;
        expect(plan.items.reduce((s, i) => s + i.amountCents, 0)).toBe(plan.distributableCents);
        expect(plan.distributableCents + plan.feeReserveCents).toBe(plan.potCents);
        const amounts = plan.items.map((i) => i.amountCents);
        expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('sums several captures', () => {
    const plan = planPayout({ ...base, capturedNetCents: [434, 434], recipientIds: ['a'] });
    expect(plan).toMatchObject({ viable: true, potCents: 868, distributableCents: 843 });
  });

  it('reports why nothing is paid', () => {
    expect(planPayout({ ...base, capturedNetCents: [], recipientIds: ['a'] })).toMatchObject({ viable: false, reason: 'no_capture' });
    expect(planPayout({ ...base, capturedNetCents: [500], recipientIds: [] })).toMatchObject({ viable: false, reason: 'no_recipients' });
    expect(planPayout({ ...base, capturedNetCents: [434], recipientIds: ['a', 'b', 'c', 'd'] })).toMatchObject({ viable: false, reason: 'pot_too_small' });
  });

  it('never goes negative or pays below the minimum', () => {
    const plan = planPayout({ ...base, capturedNetCents: [50], recipientIds: ['a', 'b'] });
    expect(plan).toMatchObject({ viable: false, distributableCents: 0 });
  });

  it('rejects non-integer input and duplicate recipients', () => {
    expect(() => planPayout({ ...base, capturedNetCents: [4.5], recipientIds: ['a'] })).toThrow();
    expect(() => planPayout({ ...base, capturedNetCents: [500], recipientIds: ['a', 'a'] })).toThrow();
  });
});

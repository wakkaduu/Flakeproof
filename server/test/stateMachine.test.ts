import { describe, expect, it } from 'vitest';
import {
  assertDepositTransition, assertEventTransition, canDeposit, deriveGuestStage, settlementAction,
  DEPOSIT_STATUSES, IllegalTransitionError,
} from '../src/domain/stateMachine.js';

describe('deposit transitions', () => {
  it('allows the happy paths', () => {
    expect(canDeposit('pending', 'authorized')).toBe(true);
    expect(canDeposit('authorized', 'voided')).toBe(true);
    expect(canDeposit('authorized', 'captured')).toBe(true);
    expect(canDeposit('authorized', 'capture_pending')).toBe(true);
    expect(canDeposit('capture_pending', 'captured')).toBe(true);
  });
  it('terminal states go nowhere; captured and voided never convert', () => {
    for (const to of DEPOSIT_STATUSES) {
      expect(canDeposit('captured', to)).toBe(false);
      expect(canDeposit('voided', to)).toBe(false);
    }
    expect(() => assertDepositTransition('captured', 'voided')).toThrow(IllegalTransitionError);
    expect(() => assertDepositTransition('voided', 'captured')).toThrow(IllegalTransitionError);
  });
  it('cannot skip authorization', () => {
    expect(canDeposit('pending', 'captured')).toBe(false);
    expect(canDeposit('pending', 'voided')).toBe(false);
  });
});

describe('event transitions', () => {
  it('open -> ended -> settled only', () => {
    expect(() => assertEventTransition('open', 'ended')).not.toThrow();
    expect(() => assertEventTransition('ended', 'settled')).not.toThrow();
    expect(() => assertEventTransition('open', 'settled')).toThrow();
    expect(() => assertEventTransition('settled', 'open')).toThrow();
  });
});

describe('settlementAction', () => {
  it('showed -> void, forgiven no-show -> void, captured no-show -> capture', () => {
    expect(settlementAction('showed', null)).toBe('void');
    expect(settlementAction('no_show', 'forgive')).toBe('void');
    expect(settlementAction('no_show', 'capture')).toBe('capture');
  });
  it('never acts without attendance and (for no-shows) a decision', () => {
    expect(settlementAction('unknown', null)).toBe('undecided');
    expect(settlementAction('unknown', 'capture')).toBe('undecided');
    expect(settlementAction('no_show', null)).toBe('undecided');
  });
  it('a decision cannot capture someone marked as showed', () => {
    expect(settlementAction('showed', 'capture')).toBe('void');
  });
});

describe('deriveGuestStage', () => {
  const s = (attendance: any, depositStatus: any, payoutItemStatus: string | null = null) =>
    deriveGuestStage({ attendance, depositStatus, payoutItemStatus });
  it('walks the story', () => {
    expect(s('unknown', null)).toBe('invited');
    expect(s('unknown', 'pending')).toBe('invited');
    expect(s('unknown', 'authorized')).toBe('authorized');
    expect(s('showed', 'authorized')).toBe('showed');
    expect(s('no_show', 'authorized')).toBe('no_show');
    expect(s('showed', 'voided')).toBe('voided');
    expect(s('no_show', 'captured')).toBe('captured');
    expect(s('showed', 'voided', 'SUCCESS')).toBe('paid_out');
    expect(s('showed', 'voided', 'PENDING')).toBe('voided');
  });
});

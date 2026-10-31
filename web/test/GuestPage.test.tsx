import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ApiError, type GuestApi, type GuestView } from '../src/api';
import { GuestPage } from '../src/pages/GuestPage';

const TOKEN = 'abcdefghijklmnopqrstuvwx';

const base: GuestView = {
  guestName: 'Ana',
  event: { title: 'Court booking', startsAt: '2026-11-02T18:00:00.000Z', depositCents: 2000, currency: 'USD', status: 'open' },
  stage: 'invited',
  depositStatus: null,
  outcome: { kind: 'none' },
  share: null,
  canApprove: true,
};
const held: GuestView = { ...base, stage: 'authorized', depositStatus: 'authorized', outcome: { kind: 'held', amountCents: 2000 }, canApprove: false };

function fakeApi(over: Partial<GuestApi> = {}, view: GuestView = base): GuestApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getGuest: vi.fn(async () => { calls.push('get'); return view; }),
    startDeposit: vi.fn(async () => { calls.push('start'); return { approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=O1' }; }),
    authorize: vi.fn(async () => { calls.push('authorize'); return held; }),
    ...over,
  };
}

describe('GuestPage', () => {
  it('shows the event, the server-decided amount, and what happens', async () => {
    render(<GuestPage token={TOKEN} api={fakeApi()} />);
    expect(await screen.findByRole('heading', { name: 'Court booking' })).toBeInTheDocument();
    expect(screen.getByText('Hi Ana')).toBeInTheDocument();
    expect(screen.getAllByText('$20.00').length).toBeGreaterThan(0);
    expect(screen.getByText(/Show up and the hold is released/)).toBeInTheDocument();
    expect(screen.getByText(/sandbox, so no real money moves/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Hold \$20\.00/ })).toBeInTheDocument();
  });

  it('Approve with PayPal starts the deposit and sends the browser to PayPal', async () => {
    const navigate = vi.fn();
    const api = fakeApi();
    render(<GuestPage token={TOKEN} api={api} navigate={navigate} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve with PayPal' }));
    expect(api.startDeposit).toHaveBeenCalledWith(TOKEN);
    expect(navigate).toHaveBeenCalledWith('https://www.sandbox.paypal.com/checkoutnow?token=O1');
    expect(screen.getByRole('button', { name: /Opening PayPal/ })).toBeDisabled();
  });

  it('a double click starts only one deposit', async () => {
    const navigate = vi.fn();
    const api = fakeApi();
    render(<GuestPage token={TOKEN} api={api} navigate={navigate} />);
    const btn = await screen.findByRole('button', { name: 'Approve with PayPal' });
    await userEvent.dblClick(btn);
    expect(api.startDeposit).toHaveBeenCalledTimes(1);
  });

  it('shows a safe message and re-enables the button when starting fails', async () => {
    const api = fakeApi({ startDeposit: vi.fn(async () => { throw new ApiError(503, 'paypal_unavailable', 'PayPal is not responding right now.'); }) });
    render(<GuestPage token={TOKEN} api={api} navigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve with PayPal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PayPal is not responding right now.');
    expect(screen.getByRole('button', { name: 'Approve with PayPal' })).toBeEnabled();
  });

  it('on return from PayPal, confirms automatically and shows the hold', async () => {
    const api = fakeApi({}, { ...base, depositStatus: 'pending' });
    render(<GuestPage token={TOKEN} paypalReturn="return" api={api} />);
    expect(await screen.findByRole('heading', { name: /hold is in place/ })).toHaveTextContent('$20.00');
    expect(api.authorize).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Approve with PayPal' })).not.toBeInTheDocument();
  });

  it('on return without an actual approval, explains and offers to try again', async () => {
    const api = fakeApi({ authorize: vi.fn(async () => { throw new ApiError(409, 'not_approved', "You haven't approved the payment on PayPal yet."); }) }, { ...base, depositStatus: 'pending' });
    render(<GuestPage token={TOKEN} paypalReturn="return" api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was held');
    expect(screen.getByRole('button', { name: 'Approve with PayPal' })).toBeEnabled();
  });

  it('on cancel, says nothing was held and does not call authorize', async () => {
    const api = fakeApi({}, { ...base, depositStatus: 'pending' });
    render(<GuestPage token={TOKEN} paypalReturn="cancel" api={api} />);
    expect(await screen.findByText(/Nothing was held and nothing was charged/)).toBeInTheDocument();
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it('does not re-authorize when the guest is already held', async () => {
    const api = fakeApi({}, held);
    render(<GuestPage token={TOKEN} paypalReturn="return" api={api} />);
    expect(await screen.findByRole('heading', { name: /hold is in place/ })).toBeInTheDocument();
    expect(api.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['voided, no share', { ...base, stage: 'voided', depositStatus: 'voided', outcome: { kind: 'nothing_charged' }, canApprove: false }, /You paid nothing/],
    ['captured', { ...base, stage: 'captured', depositStatus: 'captured', outcome: { kind: 'charged', amountCents: 2000 }, canApprove: false }, /\$20\.00 deposit was charged/],
    ['paid out', { ...base, stage: 'paid_out', depositStatus: 'voided', outcome: { kind: 'received', amountCents: 602 }, share: { amountCents: 602, status: 'SUCCESS' }, canApprove: false }, /You received \$6\.02/],
    ['event ended, never deposited', { ...base, event: { ...base.event, status: 'ended' }, canApprove: false }, /Deposits are closed/],
  ] as [string, GuestView, RegExp][])('shows the right outcome: %s', async (_n, view, text) => {
    render(<GuestPage token={TOKEN} api={fakeApi({}, view)} />);
    expect(await screen.findByRole('heading', { name: text })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve with PayPal' })).not.toBeInTheDocument();
  });

  it('shows a released guest their pending share', async () => {
    const view: GuestView = { ...base, stage: 'voided', depositStatus: 'voided', outcome: { kind: 'nothing_charged' }, share: { amountCents: 602, status: 'PENDING' }, canApprove: false };
    render(<GuestPage token={TOKEN} api={fakeApi({}, view)} />);
    expect(await screen.findByText(/Your share of the no-show deposit: \$6\.02/)).toBeInTheDocument();
    expect(screen.getByText(/on its way/)).toBeInTheDocument();
  });

  it('flags a payout problem without alarming wording or internals', async () => {
    const view: GuestView = { ...base, stage: 'voided', depositStatus: 'voided', outcome: { kind: 'nothing_charged' }, share: { amountCents: 602, status: 'UNCLAIMED' }, canApprove: false };
    render(<GuestPage token={TOKEN} api={fakeApi({}, view)} />);
    expect(await screen.findByText(/your host will sort it out/)).toBeInTheDocument();
    expect(screen.queryByText(/UNCLAIMED/)).not.toBeInTheDocument();
  });

  it('handles an invalid link and a server outage', async () => {
    const { unmount } = render(<GuestPage token={TOKEN} api={fakeApi({ getGuest: vi.fn(async () => { throw new ApiError(404, 'not_found', 'This invite link is not valid.'); }) })} />);
    expect(await screen.findByRole('heading', { name: /isn't valid/ })).toBeInTheDocument();
    unmount();
    render(<GuestPage token={TOKEN} api={fakeApi({ getGuest: vi.fn(async () => { throw new ApiError(0, 'network', 'Could not reach the server.'); }) })} />);
    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });
});

describe('App routing', () => {
  it('shows the landing text for unknown paths and never renders the guest page for malformed tokens', () => {
    render(<App path="/" search="" />);
    expect(screen.getByText(/costs you nothing if you show up/)).toBeInTheDocument();
    render(<App path="/g/short" search="" />);
    expect(screen.getAllByText(/costs you nothing if you show up/).length).toBe(2);
  });

  it('routes /g/:token?paypal=return to the guest page in return mode', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = method === 'POST' ? held : { ...base, depositStatus: 'pending' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App path={`/g/${TOKEN}`} search="?paypal=return&token=ORDER1&PayerID=X" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /hold is in place/ })).toBeInTheDocument());
    // Nothing from PayPal's query string (order id, payer id) is ever sent to our server.
    for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toMatch(/ORDER1|PayerID/);
    vi.unstubAllGlobals();
  });
});

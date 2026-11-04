import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ApiError, type JoinApi, type JoinView } from '../src/api';
import { recallJoined, rememberJoined } from '../src/lib/joined';
import { JoinPage } from '../src/pages/JoinPage';

const CODE = 'j'.repeat(32);
const view = (over: Partial<JoinView> = {}): JoinView => ({
  event: { title: 'Court booking', startsAt: '2026-11-07T10:00:00.000Z', depositCents: 2000, currency: 'USD', status: 'open', potMode: 'share', graceHours: 24 },
  holds: { state: 'open', opensAt: '2026-11-04T10:00:00.000Z' },
  names: [{ id: 'g1', name: 'Ana', taken: false }, { id: 'g2', name: 'Ben', taken: true }],
  joinable: true, canAddName: true, joinedCount: 1, ...over,
});
function fakeApi(v: JoinView = view(), over: Partial<JoinApi> = {}): JoinApi {
  return {
    getJoin: vi.fn(async () => v),
    join: vi.fn(async (_c, who) => ({ inviteToken: 'T'.repeat(24), inviteUrl: 'http://x/g/' + 'T'.repeat(24), name: 'guestId' in who ? 'Ana' : who.name })),
    ...over,
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('JoinPage: the one link from the group chat', () => {
  it('shows the invitation, what the deposit is, and who is already in', async () => {
    render(<JoinPage code={CODE} api={fakeApi()} />);
    expect(await screen.findByRole('heading', { name: 'Court booking' })).toBeInTheDocument();
    expect(screen.getByText(/is in\./)).toHaveTextContent('1 person is in.');
    expect(screen.getAllByText(/\$20\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Deposit, only a hold/)).toBeInTheDocument();
    expect(screen.getByText(/cancel free until 1 day before/)).toBeInTheDocument();
  });

  it('lets a friend tap a listed name; a taken name cannot be tapped', async () => {
    const api = fakeApi();
    const navigate = vi.fn();
    render(<JoinPage code={CODE} api={api} navigate={navigate} />);
    expect(await screen.findByRole('button', { name: /Ben/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Ana/ }));
    expect(api.join).toHaveBeenCalledWith(CODE, { guestId: 'g1' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/g/' + 'T'.repeat(24)));
    expect(recallJoined(CODE)).toEqual({ token: 'T'.repeat(24), name: 'Ana' });
  });

  it('lets a friend type a name that is not on the list', async () => {
    const api = fakeApi();
    const navigate = vi.fn();
    render(<JoinPage code={CODE} api={api} navigate={navigate} />);
    await userEvent.type(await screen.findByLabelText('Not on the list? Type your name'), '  Dee R ');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(api.join).toHaveBeenCalledWith(CODE, { name: 'Dee R' });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it('with no listed names it just asks for a name, and cannot join with an empty one', async () => {
    render(<JoinPage code={CODE} api={fakeApi(view({ names: [], joinedCount: 0 }))} />);
    expect(await screen.findByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  });

  it('shows the server\'s reason when a name is taken, and refreshes the list', async () => {
    const api = fakeApi(view(), { join: vi.fn(async () => { throw new ApiError(409, 'name_taken', 'Someone already joined as Dee. Add an initial, like “Dee K.”'); }) });
    render(<JoinPage code={CODE} api={api} navigate={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Not on the list? Type your name'), 'Dee');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add an initial');
    expect(api.getJoin).toHaveBeenCalledTimes(2);
  });

  it('says when deposits open later, and that you can join now', async () => {
    render(<JoinPage code={CODE} api={fakeApi(view({ holds: { state: 'not_yet', opensAt: '2026-11-04T10:00:00.000Z' } }))} />);
    expect(await screen.findByText(/you can join now/)).toBeInTheDocument();
  });

  it('says where a no-show\'s deposit goes, as the host chose', async () => {
    render(<JoinPage code={CODE} api={fakeApi(view({ event: { ...view().event, potMode: 'keep' } }))} />);
    expect(await screen.findByText(/goes to your host to cover the booking/)).toBeInTheDocument();
  });

  it('closes cleanly once the event has started, and when the link is wrong', async () => {
    render(<JoinPage code={CODE} api={fakeApi(view({ joinable: false, canAddName: false }))} />);
    expect(await screen.findByRole('heading', { name: 'This event has started' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    cleanup();
    render(<JoinPage code={CODE} api={fakeApi(view(), { getJoin: vi.fn(async () => { throw new ApiError(404, 'not_found', 'nope'); }) })} />);
    expect(await screen.findByRole('heading', { name: "This link isn't valid" })).toBeInTheDocument();
  });

  it('takes a friend back to their own page on the same phone, without asking who they are', async () => {
    rememberJoined(CODE, { token: 'T'.repeat(24), name: 'Ana' });
    const api = fakeApi();
    const navigate = vi.fn();
    render(<JoinPage code={CODE} api={api} navigate={navigate} />);
    expect(screen.getByText(/Welcome back, Ana/)).toBeInTheDocument();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/g/' + 'T'.repeat(24)));
    expect(api.getJoin).not.toHaveBeenCalled();
  });

  it('is routed from /e/:code, and a malformed code is not', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view()), { status: 200 })));
    render(<App path={`/e/${CODE}`} search="" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    cleanup();
    render(<App path="/e/short" search="" />);
    expect(screen.getByRole('heading', { name: /costs you nothing if you show up/ })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe('remembering who you are on this phone', () => {
  it('ignores tampered or malformed storage', () => {
    localStorage.setItem('flakeproof.joined', JSON.stringify({ [CODE]: { token: '<script>', name: 'x' } }));
    expect(recallJoined(CODE)).toBeNull();
    localStorage.setItem('flakeproof.joined', '{nope');
    expect(recallJoined(CODE)).toBeNull();
    localStorage.setItem('flakeproof.joined', '[1,2]');
    expect(recallJoined(CODE)).toBeNull();
  });

  it('keeps one entry per link and only a handful', () => {
    for (let i = 0; i < 30; i++) rememberJoined(`code${i}`.padEnd(20, 'x'), { token: 'T'.repeat(24), name: 'A' });
    expect(Object.keys(JSON.parse(localStorage.getItem('flakeproof.joined')!)).length).toBeLessThanOrEqual(20);
  });
});

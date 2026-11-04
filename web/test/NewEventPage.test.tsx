import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { ApiError, type CreatedEvent, type HostApi, type RsvpProposal } from '../src/api';
import { centsToDollars, parseDollars } from '../src/lib/money';
import { NewEventPage } from '../src/pages/NewEventPage';

const future = (hours: number) => {
  const d = new Date(Date.now() + hours * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const PROPOSAL: RsvpProposal = {
  organizer: 'Sam', title: 'Court booking', startsAtLocal: future(30), depositCents: 1500,
  guests: [
    { name: 'Ana', rsvp: 'in', source: 'author', evidence: "Ana: I'm in!", downgraded: false },
    { name: 'Ben', rsvp: 'maybe', source: 'author', evidence: 'Ben: maybe', downgraded: false },
    { name: 'Cy', rsvp: 'out', source: 'author', evidence: "Cy: can't, sorry", downgraded: false },
    { name: 'Tom', rsvp: 'in', source: 'mentioned', evidence: 'Ana: Tom is coming too', downgraded: false },
  ],
  questions: ['Which Dee is coming?'],
  notes: ['Left out “Dee’s sister”: that name does not appear in the chat.'],
};
const JOIN = 'http://localhost:5173/e/' + 'j'.repeat(32);
const CREATED: CreatedEvent = {
  hostToken: 'h'.repeat(32), hostUrl: 'http://localhost:5173/host/' + 'h'.repeat(32), joinUrl: JOIN,
  event: { id: 'e1', title: 'Court booking', warnings: [], guests: [
    { id: 'g1', name: 'Ana', inviteUrl: 'http://localhost:5173/g/' + 'a'.repeat(32) },
    { id: 'g2', name: 'Tom', inviteUrl: 'http://localhost:5173/g/' + 't'.repeat(32) },
  ] },
};
function fakeApi(over: Partial<HostApi> = {}): HostApi {
  return {
    parseRsvp: vi.fn(async () => PROPOSAL),
    createEvent: vi.fn(async () => CREATED),
    readShot: vi.fn(async () => ({ messages: [] })),
    assembleShots: vi.fn(async () => ({ chat: '', messageCount: 0, warnings: [], unknownCount: 0 })),
    ...over,
  };
}
const emptyNameInput = () => screen.getAllByLabelText('Name').find((i) => (i as HTMLInputElement).value === '')!;
/** The form is the front door; reading a chat is an optional shortcut. */
const openChat = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Fill it in from the group chat' }));
async function readChat(api: HostApi, user = userEvent.setup()) {
  render(<NewEventPage api={api} copy={vi.fn(async () => {})} />);
  await openChat(user);
  await user.click(screen.getByRole('button', { name: 'Paste text' }));
  await user.type(screen.getByLabelText('Group chat'), 'Sam: $15 each\nAna: in');
  await user.click(screen.getByRole('button', { name: 'Read the chat' }));
  await screen.findByRole('heading', { name: 'Event details' });
  return user;
}

describe('money helpers', () => {
  it('parses strictly and round-trips', () => {
    expect(parseDollars('15')).toBe(1500);
    expect(parseDollars('$15.5')).toBe(1550);
    expect(parseDollars(' 0.07 ')).toBe(7);
    for (const bad of ['', 'abc', '15.555', '-5', '1e3', '15,50', '$', '1234567']) expect(parseDollars(bad)).toBeNull();
    expect(centsToDollars(1550)).toBe('15.50');
    expect(centsToDollars(7)).toBe('0.07');
  });
});

describe('NewEventPage: reading the chat', () => {
  it('sends the chat and the browser time zone, then prefills from the proposal', async () => {
    const api = fakeApi();
    await readChat(api);
    expect(api.parseRsvp).toHaveBeenCalledWith('Sam: $15 each\nAna: in', Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(screen.getByLabelText('Event name')).toHaveValue('Court booking');
    expect(screen.getByLabelText('Deposit per person (USD)')).toHaveValue('15.00');
    expect(screen.getByLabelText('Starts')).toHaveValue(PROPOSAL.startsAtLocal);
  });

  it('only ticks people who said they are in; maybes are unticked; decliners are tucked away', async () => {
    await readChat(fakeApi());
    expect(screen.getByRole('checkbox', { name: 'Include Ana' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include Ben' })).not.toBeChecked();
    expect(screen.getByText(/Said no \(1\)/)).toBeInTheDocument();
  });

  it('shows the AI\'s questions, what was dropped, and flags people only mentioned by someone else', async () => {
    await readChat(fakeApi());
    expect(screen.getByRole('heading', { name: "The AI wasn't sure about" })).toBeInTheDocument();
    expect(screen.getByText('Which Dee is coming?')).toBeInTheDocument();
    expect(screen.getByText(/What was left out or changed \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/only mentioned by someone else/)).toBeInTheDocument();
    expect(screen.getByText("Ana: I'm in!")).toBeInTheDocument();
  });

  it('leaves the deposit empty when no amount was verified, and blocks creating until the host enters one', async () => {
    const api = fakeApi({ parseRsvp: vi.fn(async () => ({ ...PROPOSAL, depositCents: null })) });
    const user = await readChat(api);
    expect(screen.getByLabelText('Deposit per person (USD)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the deposit as a dollar amount');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('shows the server\'s message when the AI fails and the manual path still works', async () => {
    const api = fakeApi({ parseRsvp: vi.fn(async () => { throw new ApiError(503, 'ai_unavailable', 'The AI helper is busy or unreachable right now. Try again in a moment, or add guests by hand.'); }) });
    const user = userEvent.setup();
    render(<NewEventPage api={api} />);
    await openChat(user);
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    await user.type(screen.getByLabelText('Group chat'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Read the chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('by hand');
    await user.click(screen.getByRole('button', { name: /Back to the form, I'll type it/ }));
    expect(await screen.findByRole('heading', { name: 'Event details' })).toBeInTheDocument();
    expect(screen.getByText(/No names yet/)).toBeInTheDocument();
  });

  it('disables reading while empty and while in flight', async () => {
    let resolve!: (p: RsvpProposal) => void;
    const api = fakeApi({ parseRsvp: vi.fn(() => new Promise<RsvpProposal>((r) => { resolve = r; })) });
    const user = userEvent.setup();
    render(<NewEventPage api={api} />);
    await openChat(user);
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    expect(screen.getByRole('button', { name: 'Read the chat' })).toBeDisabled();
    await user.type(screen.getByLabelText('Group chat'), 'x');
    await user.click(screen.getByRole('button', { name: 'Read the chat' }));
    expect(screen.getByRole('button', { name: /Reading the chat/ })).toBeDisabled();
    resolve(PROPOSAL);
    await screen.findByRole('heading', { name: 'Event details' });
  });
});

describe('NewEventPage: creating the event', () => {
  it('sends exactly what the host confirmed: ticked people, integer cents, an ISO start', async () => {
    const api = fakeApi();
    const user = await readChat(api);
    await user.click(screen.getByRole('checkbox', { name: 'Include Ben' })); // host decides Ben is in
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await screen.findByRole('heading', { name: /is ready/ });
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(api.createEvent).toHaveBeenCalledWith({
      title: 'Court booking',
      startsAt: new Date(PROPOSAL.startsAtLocal!).toISOString(),
      depositCents: 1500,
      guests: [{ name: 'Ana' }, { name: 'Ben' }, { name: 'Tom' }],
      graceHours: 24,
      potMode: 'share',
    });
  });

  it('gives the host a button straight to the event page, using this site\'s address', async () => {
    const api = fakeApi();
    const user = await readChat(api);
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await screen.findByRole('heading', { name: /is ready/ });
    expect(screen.getByRole('link', { name: 'Go to your event page' })).toHaveAttribute('href', '/host/' + 'h'.repeat(32));
  });

  it('lets the host fix a name and add someone the chat missed', async () => {
    const api = fakeApi();
    const user = await readChat(api);
    await user.click(screen.getByRole('button', { name: 'Add someone' }));
    await user.type(emptyNameInput(), 'Dee R');
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await screen.findByRole('heading', { name: /is ready/ });
    expect((api.createEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0].guests).toContainEqual({ name: 'Dee R' });
  });

  it('validates before sending: duplicates, bad amount, zero', async () => {
    const api = fakeApi();
    const user = await readChat(api);
    const create = () => user.click(screen.getByRole('button', { name: 'Create event' }));
    await user.click(screen.getByRole('button', { name: 'Add someone' }));
    await user.type(emptyNameInput(), 'ana');
    await create();
    expect(screen.getByRole('alert')).toHaveTextContent('same name');
    const dep = screen.getByLabelText('Deposit per person (USD)');
    await user.clear(dep); await user.type(dep, '15.555'); await create();
    expect(screen.getByRole('alert')).toHaveTextContent('dollar amount');
    await user.clear(dep); await user.type(dep, '0'); await create();
    expect(screen.getByRole('alert')).toHaveTextContent('more than $0');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('a double click creates one event', async () => {
    let finish!: (c: CreatedEvent) => void;
    const api = fakeApi({ createEvent: vi.fn(() => new Promise<CreatedEvent>((r) => { finish = r; })) });
    const user = await readChat(api);
    const btn = screen.getByRole('button', { name: 'Create event' });
    await user.dblClick(btn);
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    finish(CREATED);
    await screen.findByRole('heading', { name: /is ready/ });
  });

  it('shows a server error and keeps the form', async () => {
    const api = fakeApi({ createEvent: vi.fn(async () => { throw new ApiError(400, 'duplicate_guest', 'Guest names must be different so people can tell each other apart.'); }) });
    const user = await readChat(api);
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Guest names must be different');
    expect(screen.getByLabelText('Event name')).toHaveValue('Court booking');
  });

  it('warns when the event is further away than the 3-day honor period', async () => {
    const api = fakeApi({ parseRsvp: vi.fn(async () => ({ ...PROPOSAL, startsAtLocal: future(24 * 10) })) });
    await readChat(api);
    expect(screen.getByText(/more than 3 days away/)).toBeInTheDocument();
  });

  it('summarises what will be held', async () => {
    await readChat(fakeApi());
    expect(screen.getByText(/held in total/)).toHaveTextContent('2 people × $15.00 held in total $30.00');
  });
});

describe('NewEventPage: the link', () => {
  async function created(copy = vi.fn(async () => {})) {
    const user = userEvent.setup();
    render(<NewEventPage api={fakeApi()} copy={copy} />);
    await openChat(user);
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    await user.type(screen.getByLabelText('Group chat'), 'x');
    await user.click(screen.getByRole('button', { name: 'Read the chat' }));
    await screen.findByRole('heading', { name: 'Event details' });
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await screen.findByRole('heading', { name: /is ready/ });
    return { user, copy };
  }

  it('gives ONE link for the group chat, with the message already written', async () => {
    const { user, copy } = await created();
    const msg = screen.getByTestId('chat-message');
    expect(msg).toHaveTextContent('Court booking');
    expect(msg).toHaveTextContent('$15.00');
    expect(msg).toHaveTextContent('nothing is charged if you show up');
    expect(msg).toHaveTextContent(JOIN);
    await user.click(screen.getByRole('button', { name: 'Copy the message' }));
    expect(copy).toHaveBeenLastCalledWith(expect.stringContaining(JOIN));
    expect(screen.getByRole('button', { name: /Copied: now paste it in the chat/ })).toBeInTheDocument();
  });

  it('still lets the host send one listed person their own link, and keeps the host link private', async () => {
    const { user, copy } = await created();
    await user.click(screen.getByRole('button', { name: 'Copy personal link for Ana' }));
    expect(copy).toHaveBeenLastCalledWith('http://localhost:5173/g/' + 'a'.repeat(32));
    expect(screen.getByText(/Keep it private/)).toBeInTheDocument();
    expect(screen.getByText(CREATED.hostUrl)).toBeInTheDocument();
  });

  it('sends the host\'s free-cancellation and pot choices, and no names when none were listed', async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(<NewEventPage api={api} copy={vi.fn(async () => {})} />);
    await user.type(screen.getByLabelText('Event name'), 'Cabin weekend');
    await user.type(screen.getByLabelText('Starts'), future(48));
    await user.type(screen.getByLabelText(/Deposit per person/), '25');
    await user.click(screen.getByRole('button', { name: '2 days before' }));
    await user.click(screen.getByRole('button', { name: 'stays with you, to cover the booking' }));
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await screen.findByRole('heading', { name: /is ready/ });
    const body = (api.createEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body).toMatchObject({ title: 'Cabin weekend', depositCents: 2500, graceHours: 48, potMode: 'keep' });
    expect(body.guests).toBeUndefined();
  });

  it('is a form first: the chat reader is a shortcut, not the front door', () => {
    render(<NewEventPage api={fakeApi()} />);
    expect(screen.getByLabelText('Event name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fill it in from the group chat' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Group chat')).not.toBeInTheDocument();
  });
});

describe('remembering the host link on this device', () => {
  it('saves the host path when an event is created and lists it on the home page', async () => {
    localStorage.clear();
    const user = userEvent.setup();
    render(<NewEventPage api={fakeApi()} copy={vi.fn(async () => {})} />);
    await openChat(user);
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    await user.type(screen.getByLabelText('Group chat'), 'x');
    await user.click(screen.getByRole('button', { name: 'Read the chat' }));
    await screen.findByRole('heading', { name: 'Event details' });
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await screen.findByRole('heading', { name: /is ready/ });
    expect(JSON.parse(localStorage.getItem('flakeproof.recentEvents')!)[0]).toMatchObject({ title: 'Court booking', hostPath: '/host/' + 'h'.repeat(32) });
    expect(localStorage.getItem('flakeproof.recentEvents')).not.toContain('localhost'); // only the path, not an origin
    cleanup();
    render(<App path="/" search="" />);
    expect(screen.getByRole('link', { name: /Court booking/ })).toHaveAttribute('href', '/host/' + 'h'.repeat(32));
  });

  it('ignores tampered or malformed stored data', () => {
    localStorage.setItem('flakeproof.recentEvents', JSON.stringify([{ title: 'x', hostPath: 'javascript:alert(1)', createdAt: '' }, { title: 5 }, 'junk']));
    render(<App path="/" search="" />);
    expect(screen.queryByText(/Events you created/)).not.toBeInTheDocument();
    localStorage.setItem('flakeproof.recentEvents', '{not json');
    cleanup();
    render(<App path="/" search="" />);
    expect(screen.getByRole('link', { name: 'Create an event' })).toBeInTheDocument();
  });
});

describe('routing', () => {
  it('/new shows the form; /host/:token shows the host placeholder; home links to /new', async () => {
    render(<App path="/new" search="" />);
    expect(screen.getByRole('heading', { name: 'New event' })).toBeInTheDocument();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Event not found' } }), { status: 404 })));
    render(<App path={`/host/${'h'.repeat(32)}`} search="" />);
    expect(await screen.findByRole('heading', { name: "This host link isn't valid" })).toBeInTheDocument();
    vi.unstubAllGlobals();
    render(<App path="/" search="" />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Create an event' })).toHaveAttribute('href', '/new'));
  });
});

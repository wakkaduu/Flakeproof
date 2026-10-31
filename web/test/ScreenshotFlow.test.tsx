import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Assembled, type CreatedEvent, type HostApi, type RsvpProposal, type ShotMessage } from '../src/api';
import { MAX_SHOTS } from '../src/lib/useScreenshotReader';
import { NewEventPage } from '../src/pages/NewEventPage';

afterEach(cleanup);

const msg = (author: string | null, text: string, time: string | null, fromHost = false): ShotMessage => ({ author, fromHost, kind: 'text', text, time });
const DATE: ShotMessage = { author: null, fromHost: false, kind: 'date', text: 'Tue, 3 Nov', time: null };
const BY_FILE: Record<string, ShotMessage[]> = {
  'a.png': [DATE, msg(null, 'deposit is $20', '10:00', true), msg('Ana', 'in', '10:05')],
  'b.png': [msg('Ana', 'in', '10:05'), msg('Ben', 'in too', '10:06')],
  'c.png': [msg('Cy', 'in!', '10:07')],
};
const CHAT = '[Tue, 3 Nov 10:00] Sam: deposit is $20\n[Tue, 3 Nov 10:05] Ana: in\n[Tue, 3 Nov 10:06] Ben: in too';
const ASSEMBLED: Assembled = {
  chat: CHAT, messageCount: 3, unknownCount: 0,
  warnings: ['Screenshot 1 and screenshot 2 share no message, so something between them may be missing. Add a screenshot that overlaps both.'],
};
const PROPOSAL: RsvpProposal = {
  organizer: 'Sam', title: 'Badminton', startsAtLocal: null, depositCents: 2000,
  guests: [{ name: 'Ana', rsvp: 'in', source: 'author', evidence: 'Ana: in', downgraded: false }],
  questions: [], notes: [],
};
const CREATED = { hostToken: 'h'.repeat(32), hostUrl: 'x', event: { id: 'e', title: 't', warnings: [], guests: [] } } as CreatedEvent;

const file = (name: string, lastModified = 1, type = 'image/png') => new File(['x'], name, { type, lastModified });
// The real shrinker needs a browser canvas; the page takes it as a prop so tests do not.
const prepareImage = vi.fn(async (f: File) => ({ image: { mimeType: 'image/jpeg' as const, data: btoa(f.name) }, thumb: 'data:image/jpeg;base64,AAAA' }));

function fakeApi(over: Partial<HostApi> = {}): HostApi {
  return {
    parseRsvp: vi.fn(async () => PROPOSAL),
    createEvent: vi.fn(async () => CREATED),
    readShot: vi.fn(async (img) => ({ messages: BY_FILE[atob(img.data)] ?? [] })),
    assembleShots: vi.fn(async () => ASSEMBLED),
    ...over,
  };
}
const setup = (api: HostApi, opts: Parameters<typeof userEvent.setup>[0] = {}) => {
  const user = userEvent.setup(opts);
  render(<NewEventPage api={api} copy={vi.fn(async () => {})} prepareImage={prepareImage} />);
  return user;
};
const shotItems = () => within(screen.getByRole('list', { name: 'Screenshots, oldest first' })).getAllByRole('listitem');
async function add(user: ReturnType<typeof userEvent.setup>, ...files: File[]) {
  await user.upload(screen.getByLabelText(/Add (more )?screenshots/), files);
  await waitFor(() => expect(shotItems()).toHaveLength(files.length));
}

describe('NewEventPage: adding the chat as screenshots', () => {
  it('offers screenshots first and keeps pasting text one tap away', async () => {
    const user = setup(fakeApi());
    expect(screen.getByRole('button', { name: 'Screenshots' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText(/Add screenshots/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Group chat')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    expect(screen.getByLabelText('Group chat')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add screenshots/)).not.toBeInTheDocument();
  });

  it('reads each screenshot, shows a transcript to check, and reads the host\'s EDITED text', async () => {
    const api = fakeApi();
    const user = setup(api);
    await add(user, file('a.png', 1), file('b.png', 2));
    await user.type(screen.getByLabelText('Your name in the chat'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));

    await screen.findByRole('heading', { name: 'Check what was read' });
    expect(api.readShot).toHaveBeenCalledTimes(2);
    expect(api.assembleShots).toHaveBeenCalledWith([BY_FILE['a.png'], BY_FILE['b.png']], 'Sam');
    // warnings first, then the lines that decide money and date, with the amount marked
    expect(screen.getByText(/share no message/)).toBeInTheDocument();
    expect(screen.getByText('$20', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.getByLabelText('Transcript')).toHaveValue(CHAT);

    // the host fixes a misread amount; THAT text is what the AI gets
    const fixed = CHAT.replace('$20', '$25');
    fireEvent.change(screen.getByLabelText('Transcript'), { target: { value: fixed } });
    expect(screen.getByText('$25', { selector: 'mark' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read the chat' }));
    await screen.findByRole('heading', { name: 'Check the details' });
    expect(api.parseRsvp).toHaveBeenCalledWith(fixed, Intl.DateTimeFormat().resolvedOptions().timeZone);

    // back goes to the transcript (not to an empty paste box), with the edit and the screenshots intact
    await user.click(screen.getByRole('button', { name: 'Back to the chat' }));
    expect(screen.getByLabelText('Transcript')).toHaveValue(fixed);
    await user.click(screen.getByRole('button', { name: 'Back to screenshots' }));
    expect(shotItems()).toHaveLength(2);
    expect(screen.getByLabelText('Your name in the chat')).toHaveValue('Sam');
  });

  it('asks for the host\'s name before reading anything', async () => {
    const api = fakeApi();
    const user = setup(api);
    await add(user, file('a.png'));
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Type your name/);
    expect(api.readShot).not.toHaveBeenCalled();
  });

  it('shows which screenshot failed, keeps the others, and Try again reads only that one', async () => {
    let calls = 0;
    const readShot = vi.fn(async (img: { data: string }) => {
      if (atob(img.data) === 'b.png' && ++calls === 1) throw new ApiError(503, 'ai_unavailable', 'The AI helper is busy or unreachable right now. Try again in a moment, or add guests by hand.');
      return { messages: BY_FILE[atob(img.data)] ?? [] };
    });
    const api = fakeApi({ readShot });
    const user = setup(api);
    await add(user, file('a.png', 1), file('b.png', 2));
    await user.type(screen.getByLabelText('Your name in the chat'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));

    const second = await waitFor(() => { const li = shotItems()[1]!; expect(within(li).getByRole('alert')).toBeInTheDocument(); return li; });
    expect(within(second).getByRole('alert')).toHaveTextContent('busy or unreachable');
    expect(within(shotItems()[0]!).getByText('2 messages read')).toBeInTheDocument(); // the day separator is not a message
    expect(api.assembleShots).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Check what was read' })).not.toBeInTheDocument();

    await user.click(within(second).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(shotItems()[1]!).getByText('2 messages read')).toBeInTheDocument());
    expect(readShot).toHaveBeenCalledTimes(3); // a, b (failed), b again: "a" was not read twice
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Check what was read' });
  });

  it('puts screenshots in the order they were taken, and the host can reorder or remove them', async () => {
    const api = fakeApi();
    const user = setup(api);
    // picked newest-first; the file time says which came first
    await add(user, file('c.png', 30), file('a.png', 10), file('b.png', 20));
    expect(shotItems().map((li) => within(li).getByRole('img').getAttribute('alt'))).toEqual(['Screenshot 1', 'Screenshot 2', 'Screenshot 3']);
    await user.click(screen.getByRole('button', { name: 'Move screenshot 1 down' })); // a <-> b
    await user.click(screen.getByRole('button', { name: 'Remove screenshot 3' }));   // drops c
    await user.type(screen.getByLabelText('Your name in the chat'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));
    await screen.findByRole('heading', { name: 'Check what was read' });
    expect(api.assembleShots).toHaveBeenCalledWith([BY_FILE['b.png'], BY_FILE['a.png']], 'Sam');
    expect(api.readShot).toHaveBeenCalledTimes(2); // c was removed before reading
  });

  it('says what it skipped: non-images, files the browser cannot open, and anything past the limit', async () => {
    prepareImage.mockImplementationOnce(async () => { throw new Error('cannot decode'); });
    const user = setup(fakeApi(), { applyAccept: false });
    const many = Array.from({ length: MAX_SHOTS + 2 }, (_, i) => file(`s${i}.png`, i));
    await user.upload(screen.getByLabelText(/Add screenshots/), [file('notes.txt', 0, 'text/plain'), ...many]);
    await waitFor(() => expect(shotItems()).toHaveLength(MAX_SHOTS));
    const notes = screen.getByRole('list', { name: 'Skipped files' });
    expect(notes).toHaveTextContent('Skipped notes.txt: it is not an image.');
    expect(notes).toHaveTextContent(`Only ${MAX_SHOTS} screenshots fit. Skipped 1.`); // 10 picked: 1 unreadable, 8 added, 1 left over
    expect(notes).toHaveTextContent('Could not open s0.png');
    expect(screen.getByLabelText(/Add more screenshots/)).toBeDisabled();
  });

  it('keeps the transcript and says so when the AI step fails, so nothing has to be redone', async () => {
    const api = fakeApi({ parseRsvp: vi.fn(async () => { throw new ApiError(503, 'ai_unavailable', 'The AI helper is busy or unreachable right now. Try again in a moment, or add guests by hand.'); }) });
    const user = setup(api);
    await add(user, file('a.png'));
    await user.type(screen.getByLabelText('Your name in the chat'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));
    await screen.findByRole('heading', { name: 'Check what was read' });
    await user.click(screen.getByRole('button', { name: 'Read the chat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('busy or unreachable');
    expect(screen.getByLabelText('Transcript')).toHaveValue(CHAT);
    expect(screen.getByRole('button', { name: 'Read the chat' })).toBeEnabled();
  });

  it('shows the server\'s message when the transcript cannot be built', async () => {
    const api = fakeApi({ assembleShots: vi.fn(async () => { throw new ApiError(400, 'host_name_required', 'Type your name as your friends see it, so your own messages (on the right) can be labelled.'); }) });
    const user = setup(api);
    await add(user, file('a.png'));
    await user.type(screen.getByLabelText('Your name in the chat'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Type your name/);
    expect(screen.queryByRole('heading', { name: 'Check what was read' })).not.toBeInTheDocument();
  });

  it('cannot be started twice while reading, and says how far along it is', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const api = fakeApi({ readShot: vi.fn(async (img) => { await gate; return { messages: BY_FILE[atob(img.data)] ?? [] }; }) });
    const user = setup(api);
    await add(user, file('a.png', 1), file('b.png', 2));
    await user.type(screen.getByLabelText('Your name in the chat'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Read screenshots' }));
    const busy = await screen.findByRole('button', { name: /Reading… 0 of 2 done/ });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('button', { name: /Skip, I'll add people myself/ })).toBeDisabled();
    release();
    await screen.findByRole('heading', { name: 'Check what was read' });
    expect(api.readShot).toHaveBeenCalledTimes(2);
  });
});

import { useId, type ReactNode } from 'react';
import { input, secondary, primary } from '../lib/ui';
import { MAX_SHOTS, type ScreenshotReader, type Shot } from '../lib/useScreenshotReader';

interface Props {
  reader: ScreenshotReader;
  hostName: string;
  onHostName: (v: string) => void;
  /** Reads every unread screenshot, then moves on. */
  onRead: () => void;
  error: string | null;
}

const STATUS: Record<Shot['status'], string> = { ready: 'Ready to read', reading: 'Reading…', done: '', failed: '' };

/** Phone-first way to give Flakeproof the chat: a few screenshots instead of copying 50 messages. */
export function ScreenshotInput({ reader, hostName, onHostName, onRead, error }: Props) {
  const fileId = useId();
  const nameId = useId();
  const { shots, notices, busy } = reader;
  const full = shots.length >= MAX_SHOTS;

  return (
    <div className="mt-4">
      <p className="text-ink-soft">
        Screenshot the chat on your phone, scrolling so each one overlaps the last by a message or two. Start where the plan is made. Up to {MAX_SHOTS}.
      </p>

      <input
        id={fileId} type="file" accept="image/*" multiple className="peer sr-only" disabled={full || busy}
        onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void reader.addFiles(files); }}
      />
      <label
        htmlFor={fileId}
        className={`${secondary} mt-3 cursor-pointer peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-good-600 ${full || busy ? 'pointer-events-none opacity-60' : ''}`}
      >
        {shots.length === 0 ? 'Add screenshots' : 'Add more screenshots'}
      </label>

      {notices.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-hold-800" aria-label="Skipped files">{notices.map((n) => <li key={n}>{n}</li>)}</ul>
      )}

      {shots.length > 0 && (
        <ol aria-label="Screenshots, oldest first" className="mt-3 space-y-2">
          {shots.map((s, i) => (
            <li key={s.id} className="flex items-start gap-3 rounded-xl border border-line bg-white p-3">
              <img src={s.thumb} alt={`Screenshot ${i + 1}`} width={48} className="h-20 w-12 shrink-0 rounded border border-line object-cover object-top" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Screenshot {i + 1}</p>
                <p className="text-sm text-ink-soft" aria-live="polite">
                  {s.status === 'done' ? `${(s.messages ?? []).filter((m) => m.kind !== 'date').length} messages read` : STATUS[s.status]}
                </p>
                {s.status === 'failed' && (
                  <div className="mt-1">
                    <p role="alert" className="text-sm text-charged-800">{s.error}</p>
                    <button type="button" onClick={() => void reader.readOne(s.id)} disabled={busy} className="mt-1 text-sm font-medium underline">Try again</button>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <TextButton label={`Move screenshot ${i + 1} up`} disabled={busy || i === 0} onClick={() => reader.move(s.id, -1)}>Move up</TextButton>
                  <TextButton label={`Move screenshot ${i + 1} down`} disabled={busy || i === shots.length - 1} onClick={() => reader.move(s.id, 1)}>Move down</TextButton>
                  <TextButton label={`Remove screenshot ${i + 1}`} disabled={busy} onClick={() => reader.remove(s.id)}>Remove</TextButton>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4">
        <label htmlFor={nameId} className="block text-sm font-medium">Your name in the chat</label>
        <p className="text-sm text-ink-soft">Your own messages are on the right and show no name. Type the name your friends know you by.</p>
        <input id={nameId} value={hostName} onChange={(e) => onHostName(e.target.value)} maxLength={40} autoComplete="given-name" className={`${input} mt-1`} />
      </div>

      {error && <div role="alert" className="mt-3 rounded-xl border border-hold-100 bg-hold-50 p-3 text-sm text-hold-800">{error}</div>}

      <button type="button" onClick={onRead} disabled={busy || shots.length === 0} className={`${primary} sticky bottom-3 z-10 mt-4 w-full shadow-lg sm:w-auto`}>
        {busy ? `Reading… ${reader.doneCount} of ${shots.length} done` : shots.length > 0 && reader.doneCount === shots.length ? 'Continue' : 'Read screenshots'}
      </button>
      <p role="status" className="sr-only">{busy ? `Reading screenshots, ${reader.doneCount} of ${shots.length} done` : ''}</p>
      <p className="mt-2 text-xs text-ink-soft">
        Screenshots are shrunk on your device, sent to Google's Gemini API to be read, and not kept by Flakeproof. Crop out phone numbers, and use a demo chat, not a private one.
      </p>
    </div>
  );
}

function TextButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="min-h-8 underline disabled:no-underline disabled:opacity-40">
      {children}
    </button>
  );
}

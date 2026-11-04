/**
 * Remembers, on this phone, which personal link belongs to which group link, so opening the group link again
 * takes a friend straight back to their own page instead of asking who they are. A convenience only: the personal
 * link stays the key, and the host can always give someone theirs again.
 */
const KEY = 'flakeproof.joined';
export interface JoinedEntry { token: string; name: string }
type Store = Pick<Storage, 'getItem' | 'setItem'>;

function read(storage: Store): Record<string, JoinedEntry> {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function recallJoined(code: string, storage: Store = localStorage): JoinedEntry | null {
  const e = read(storage)[code];
  return e && typeof e.token === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(e.token) && typeof e.name === 'string' ? e : null;
}

export function rememberJoined(code: string, entry: JoinedEntry, storage: Store = localStorage): void {
  try {
    const all = read(storage);
    // Keep the list short: a phone that joins dozens of events does not need them all.
    const keep = Object.entries(all).slice(-19);
    storage.setItem(KEY, JSON.stringify({ ...Object.fromEntries(keep), [code]: entry }));
  } catch { /* storage unavailable (private mode): the friend just keeps the page open or bookmarks it */ }
}

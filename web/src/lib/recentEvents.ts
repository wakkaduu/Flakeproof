/**
 * The host link is the only key to an event (no accounts). If the host loses it, nobody can mark
 * attendance or approve the money. So we also remember it in this browser. This is a convenience,
 * not a recovery guarantee: the host should still keep the link.
 */
const KEY = 'flakeproof.recentEvents';
export interface RecentEvent { title: string; hostPath: string; createdAt: string }

export function loadRecent(storage: Pick<Storage, 'getItem'> = localStorage): RecentEvent[] {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is RecentEvent => typeof e?.title === 'string' && typeof e?.hostPath === 'string' && /^\/host\/[A-Za-z0-9_-]{16,64}$/.test(e.hostPath)).slice(0, 10);
  } catch {
    return [];
  }
}

export function rememberEvent(title: string, hostUrl: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
  try {
    const hostPath = new URL(hostUrl).pathname;
    const next = [{ title, hostPath, createdAt: new Date().toISOString() }, ...loadRecent(storage).filter((e) => e.hostPath !== hostPath)].slice(0, 10);
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode, quota): the on-screen link is still shown */
  }
}

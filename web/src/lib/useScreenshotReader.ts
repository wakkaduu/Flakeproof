import { useRef, useState } from 'react';
import type { ApiError, Assembled, HostApi, ShotImage, ShotMessage } from '../api';
import { prepareImage, type PreparedImage } from './images';

export const MAX_SHOTS = 8; // mirrors the server limit
const CONCURRENCY = 4;

export type ShotStatus = 'ready' | 'reading' | 'done' | 'failed';
export interface Shot {
  id: number;
  name: string;
  thumb: string;
  image: ShotImage;
  status: ShotStatus;
  error: string | null;
  messages: ShotMessage[] | null;
}

type Api = Pick<HostApi, 'readShot' | 'assembleShots'>;

/**
 * Holds the chosen screenshots and what was read from each. It lives in the page (not in the picker)
 * so going back from the next step does not lose them. Reading is one request per image; merging is a
 * separate request that uses no AI, so removing or reordering a screenshot never costs another read.
 */
export function useScreenshotReader(api: Api, prepare: (file: File) => Promise<PreparedImage> = prepareImage) {
  const ref = useRef<Shot[]>([]); // the latest list, readable from async code
  const [shots, setShots] = useState<Shot[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nextId = useRef(1);

  const set = (fn: (s: Shot[]) => Shot[]) => { ref.current = fn(ref.current); setShots(ref.current); };
  const patch = (id: number, p: Partial<Shot>) => set((s) => s.map((x) => (x.id === id ? { ...x, ...p } : x)));

  async function addFiles(files: File[]) {
    const notes: string[] = [];
    const images = files.filter((f) => {
      const ok = f.type.startsWith('image/');
      if (!ok) notes.push(`Skipped ${f.name}: it is not an image.`);
      return ok;
    });
    // Screenshots are taken in order, so the file time is the best guess at the order the chat was scrolled.
    const sorted = [...images].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
    let tried = 0;
    for (const file of sorted) {
      if (ref.current.length >= MAX_SHOTS) break; // a file the browser cannot open does not use up a slot
      tried++;
      try {
        const p = await prepare(file);
        set((s) => [...s, { id: nextId.current++, name: file.name, thumb: p.thumb, image: p.image, status: 'ready', error: null, messages: null }]);
      } catch {
        notes.push(`Could not open ${file.name}. Use a PNG or JPG screenshot.`);
      }
    }
    if (tried < sorted.length) notes.push(`Only ${MAX_SHOTS} screenshots fit. Skipped ${sorted.length - tried}.`);
    setNotices(notes);
  }

  const remove = (id: number) => set((s) => s.filter((x) => x.id !== id));
  const move = (id: number, dir: -1 | 1) => set((s) => {
    const i = s.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= s.length) return s;
    const next = [...s];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  async function readOne(id: number) {
    const shot = ref.current.find((s) => s.id === id);
    if (!shot) return;
    patch(id, { status: 'reading', error: null });
    try {
      const r = await api.readShot(shot.image);
      patch(id, { status: 'done', messages: r.messages, error: null });
    } catch (e) {
      patch(id, { status: 'failed', error: (e as ApiError).message || 'Could not read this screenshot.' });
    }
  }

  /** Reads every screenshot that is not read yet (4 at a time). True when all of them are read. */
  async function readAll(): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const queue = ref.current.filter((s) => s.status !== 'done').map((s) => s.id);
      const worker = async () => { for (let id = queue.shift(); id !== undefined; id = queue.shift()) await readOne(id); };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    return ref.current.length > 0 && ref.current.every((s) => s.status === 'done');
  }

  const assemble = (hostName: string): Promise<Assembled> => api.assembleShots(ref.current.map((s) => s.messages ?? []), hostName);

  return {
    shots, notices, busy, addFiles, remove, move, readOne, readAll, assemble,
    doneCount: shots.filter((s) => s.status === 'done').length,
  };
}
export type ScreenshotReader = ReturnType<typeof useScreenshotReader>;

import { useEffect } from 'react';

/** Sets the browser tab title for the current screen, so the tab and screen readers say where you are. */
export function useTitle(title: string): void {
  useEffect(() => { document.title = title ? `${title} · Flakeproof` : 'Flakeproof'; }, [title]);
}

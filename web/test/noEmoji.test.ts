import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : /\.(tsx?|css|html)$/.test(f) ? [join(dir, f)] : []));

describe('a professional look', () => {
  it('uses no emoji anywhere in the interface source (icons are inline SVG, status is always a word)', () => {
    const offenders = [...walk(join(import.meta.dirname, '..', 'src')), join(import.meta.dirname, '..', 'index.html')]
      .filter((f) => /\p{Extended_Pictographic}/u.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

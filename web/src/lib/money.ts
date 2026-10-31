/** Display/input helpers only. Server owns all money logic in integer cents. */

/** Strict: "15", "15.5", "$15.50". Returns whole cents or null. No floats involved. */
export function parseDollars(input: string): number | null {
  const m = /^\$?\s*(\d{1,6})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
}

export function centsToDollars(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

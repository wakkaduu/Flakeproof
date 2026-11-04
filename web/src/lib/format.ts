/** Display only. All money logic stays on the server in integer cents. */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function formatWhen(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** "Sat 4:00 PM": short, for deadlines that are always within a day or two. */
export function formatDeadline(iso: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

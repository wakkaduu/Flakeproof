/**
 * A tiny calendar file (RFC 5545) so a friend can be reminded when deposits open. There is no notification service
 * behind Flakeproof (no accounts, no email, no texts), so the honest reminder is the one the friend's own phone sends.
 */
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export function reminderIcs(opts: { title: string; opensAt: string; url: string; startsAt: string; uid: string }): string {
  const opens = new Date(opts.opensAt);
  const end = new Date(opens.getTime() + 15 * 60_000);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flakeproof//Reminder//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}@flakeproof`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(opens)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`Put down your deposit for ${opts.title}`)}`,
    `DESCRIPTION:${esc(`Deposits are open. Nothing is charged if you come. ${opts.url}`)}`,
    `URL:${opts.url}`,
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`Deposits are open for ${opts.title}`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

/** Hands the file to the browser as a download. Not unit-tested (needs a real browser); the content above is. */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The transcript is read from pixels, and code cannot check a digit against a picture. So the host
 * does: lines that mention an amount, a day or a time are listed apart, with the amount or time
 * highlighted, so the few lines that decide the money and the date are easy to compare with the screenshots.
 */
const AMOUNT = String.raw`\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars?|bucks|usd)\b`;
const WHEN = String.raw`\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b|\b(?:today|tomorrow|tonight|noon)\b`;
// Exactly one capture group, so String.split() returns the matches at the odd positions.
const MARK = new RegExp(`(${AMOUNT}|${WHEN})`, 'gi');
const HAS_MARK = new RegExp(`${AMOUNT}|${WHEN}`, 'i');
const HAS_AMOUNT = new RegExp(AMOUNT, 'i');
const STAMP = /^\[[^\]]*\]\s*/;

/** Splits a line into plain and highlighted parts (the highlighted parts are the amounts and times). */
export function highlight(line: string): { text: string; hit: boolean }[] {
  return line.split(MARK).map((text, i) => ({ text, hit: i % 2 === 1 })).filter((p) => p.text !== '');
}

/**
 * The transcript lines that state an amount, a day or a time, without their "[Day time]" prefix.
 * Lines with an amount come first: a misread digit there costs money, and casual mentions of a weekday must not push them out.
 */
export function flagLines(chat: string): string[] {
  const amounts: string[] = [];
  const whens: string[] = [];
  for (const raw of chat.split('\n')) {
    const body = raw.replace(STAMP, '').trim();
    if (!body) continue;
    if (HAS_AMOUNT.test(body)) amounts.push(body);
    else if (HAS_MARK.test(body)) whens.push(body);
  }
  return [...amounts, ...whens];
}

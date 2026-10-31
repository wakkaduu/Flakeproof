// Creates a sample event on the running dev server and prints the links. For manual testing.
//   npm run dev:event                 -> 4 guests, $20.00 deposit, starts in 2 hours
//   npm run dev:event -- 1500 Ana Ben -> $15.00, guests Ana and Ben
const api = process.env.API_URL || 'http://localhost:3001';
const [cents, ...names] = process.argv.slice(2);
const guests = (names.length ? names : ['Ana', 'Ben', 'Cy', 'Dee']).map((name) => ({ name }));
const res = await fetch(`${api}/api/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    title: 'Court booking',
    startsAt: new Date(Date.now() + 2 * 3600e3).toISOString(),
    depositCents: Number(cents) || 2000,
    guests,
  }),
}).catch((e) => { console.error(`Could not reach ${api}. Is "npm run dev" running?\n${e.message}`); process.exit(1); });
const body = await res.json();
if (!res.ok) { console.error(JSON.stringify(body, null, 2)); process.exit(1); }
console.log(`\nHost link (keep private): ${body.hostUrl}\n`);
for (const g of body.event.guests) console.log(`  ${g.name.padEnd(8)} ${g.inviteUrl}`);
console.log('');

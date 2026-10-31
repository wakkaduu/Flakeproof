# Judge test pack (template for the Devpost "testing instructions" field)

Paste into the private testing-instructions field at submission time. Fill the bracketed parts then. Do **not** commit real values.

```
Flakeproof runs locally in about 5 minutes. Everything uses the PayPal SANDBOX (fake money).

1. Node 22+. Clone the repo, then: cp .env.example .env && npm run setup
2. PayPal sandbox merchant (free): follow docs/sandbox-setup.md, or use ours: [CLIENT_ID] / [CLIENT_SECRET]
3. Gemini key (free, 1 minute): https://aistudio.google.com/apikey  (the app works without it; AI features are then off)
4. npm run dev, open http://localhost:5173/new

Sandbox "friend" logins (US personal accounts, use a private window on PayPal's page):
  Ana  [email] / [password]
  Ben  [email] / [password]
  Cy   [email] / [password]
  Dee  [email] / [password]

Quickest tour: npm run e2e:sandbox runs the whole money flow (3 friends, 1 flakes, payout) and prints a report.
Keep the sandbox accounts and any shared merchant credentials alive until Dec 15, 2026.
```

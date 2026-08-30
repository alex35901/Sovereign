# Sovereign

A self-hosted personal finance app in the shape of Monarch Money — dashboard, accounts and
net worth, transactions, cash flow, budget, recurring, goals, investments and reports.
Written from scratch; it contains none of Monarch's code or assets.

The point is cost. Monarch is $100/yr, plus $200 for the retirement tier. The data behind
those features costs between **$0 and $15/yr** if you run the app yourself — see
[Bank sync](#bank-sync) below.

## Running it

**Accounts no aggregator can reach** — employer 401(k) recordkeepers are the usual case, and
some refuse aggregator access outright — are kept current from the **Balance points** card on
the account page: a dated balance, typed in, as often as a statement arrives. Points can be
back-dated, and only the newest one drives the current balance.

**Getting historical balances in:** every account page has **Import history** on its Balance
history card. Feed it a CSV with a date column and a balance column and it fills the chart
backwards. Daily exports are collapsed to their change points on the way in — a 706-row
property history becomes 83 stored points, which renders identically because balances carry
forward.

**Without the terminal:** double-click **`start.cmd`**. It pulls the latest version, installs
anything new, starts the app and opens http://localhost:5273 in your browser. Leave the black
window open while you use the app; close it to stop. Run it again any time to get updates —
pushing to GitHub does not change the files on your PC, so something has to pull them down,
and that script is the something.

**Better still, don't run it locally at all.** Deploy once to Vercel (below) and every change
pushed to `main` rebuilds itself within a minute. Then you really can just refresh the page,
from any device, and bank sync works too.

**From a terminal**, if you prefer:

```
npm install
npm run dev      # http://localhost:5273 - UI only, no bank sync
vercel dev       # http://localhost:5273 - includes the /api function
npm run build    # type-check + production bundle
npm test         # logic self-tests, no browser needed
```

First launch seeds two years of realistic demo data so every screen has something in it.
**Settings → Danger zone → Erase everything** clears it when you're ready for real numbers.

## Where your data lives

In `localStorage`, in one browser, on one machine. Nothing is transmitted anywhere unless
you connect a sync provider. That means:

- **Take backups.** Settings → *Back up JSON* writes a complete, re-importable snapshot.
  Clearing site data destroys everything otherwise.
- Moving to another machine or browser = export JSON, import it on the other side.
- ~1,300 transactions is roughly 400 KB, well inside the ~5 MB budget. A decade of history
  would want a real database — swap `src/lib/storage.ts` for one; nothing else needs to change.

## Bank sync

Getting transactions in, cheapest first:

| Route | Cost | Notes |
| --- | --- | --- |
| CSV / manual | $0 | Works today, no signup. Mint, Monarch, YNAB and raw bank exports all import. |
| **SimpleFIN Bridge** | **$15/yr** | Implemented. MX-backed, ~16k institutions, 25 max, refreshes daily. |
| **RentCast** | **$0** | Implemented, for property values — see below. 50 lookups/month on the free tier. |
| **Plaid** | **$0** | Implemented. Trial plan: 10 institutions, and the only route here returning holdings. |
| Teller | $0 | Not wired up. 100 connections, US only, thin on retirement accounts. |

### Plaid

For IRAs, Roth IRAs, 401(k)s and brokerages: Plaid returns positions, cost basis and prices,
which SimpleFIN cannot. Its Trial plan is free for 10 institutions.

Unlike the other two providers, Plaid's credentials authorise every request for every
connected bank, so they stay on the server: set `PLAID_CLIENT_ID` and `PLAID_SECRET` as Vercel
environment variables (add `PLAID_ENV=sandbox` to test against fake banks first) and redeploy.
Only the per-connection access token is held in the browser.

Connect investment accounts and banks separately — Plaid rejects a link whose institution
doesn't support every product requested, so asking for holdings and transactions at once fails
on institutions offering only one. Holdings replace an account's previous positions on each
sync, so a sold position disappears rather than lingering at its last price.

Some institutions refuse aggregator access entirely — employer 401(k) recordkeepers are the
common case — and no provider gets past that. Those are kept current from the Balance points
card.

### Vehicles

There is no free per-VIN valuation API — Kelley Blue Book and Edmunds retired their public
ones and the paid providers don't publish pricing — so vehicle accounts model depreciation
instead of quoting a market. Enter what it cost, when it was bought, the body type and rough
annual mileage; the curve is fitted to 2026 industry averages for five-year depreciation
(41.8% for the average vehicle, 34.2% trucks, 35.4% hybrids, 57.2% EVs) with the first year
steepest, and mileage either side of 12,000 a year moves the vehicle along it faster or slower.

Leave **re-record monthly** on and the value updates itself roughly every 25 days, whether or
not the page is opened. A real quote from a dealer or KBB always wins: enter it as a balance
point and it takes precedence over the model.

### Property values

Bank aggregators carry no property valuations — MX, and therefore SimpleFIN, simply doesn't
have them. Real-estate accounts get their value from RentCast instead: put the address on the
account, press **Refresh estimate**, and the returned figure is written as a balance snapshot,
so net worth updates and the history chart keeps what came before.

Sign up at [rentcast.io](https://www.rentcast.io/api), create a key on the free Developer
plan, and paste it into Settings → Property values. That plan allows 50 lookups a month; two
properties refreshed monthly uses two. Settings also has an **Update now** button that walks
every property with an address.

### Connecting SimpleFIN

1. Sign up at [bridge.simplefin.org](https://bridge.simplefin.org). There's a 30-day free
   trial, but you have to start it (or subscribe) **before your first bank can be added** —
   the account exists without one, the connection doesn't.
2. Link your banks there, then generate a **setup token** (a long base64 string, single use).
3. Paste it into Settings → Bank sync → Connect.

The token is exchanged once for a durable access URL, which is stored in this browser and
sent only to your own `/api/simplefin` function. That function exists because the bridge
sends no CORS headers and its access URL carries HTTP Basic credentials, which browsers
refuse to send cross-origin — so the request has to be made server-side.

**Sync only works where that function runs**: `vercel dev` locally, or a deployment. Plain
`npm run dev` serves the UI but not `/api`, so Connect fails there — the app says so rather
than blaming SimpleFIN.

Syncing pulls a 90-day window (SimpleFIN's per-request maximum), de-duplicates on the
bridge's own transaction ids, and runs every new transaction through your rules.

### Adding another provider

Implement `SyncAdapter` in `src/lib/sync/types.ts`, register it in `src/lib/sync/index.ts`.
`mergeSync` and the rest of the app are provider-agnostic.

## Deploying

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Add New → Project**, pick `sovereign`, press Deploy. No settings to change — `vercel.json`
   already handles the SPA rewrites and keeps `/api/*` out of them.
3. You get a URL like `sovereign-xxxx.vercel.app`. That's the app, on every device you own.

After that, every push to `main` redeploys automatically in about a minute — refresh the page
and the change is there. The `/api/simplefin` function runs there too, so bank sync works
without `vercel dev`.

Any static host works as well, but without somewhere to run `api/simplefin.ts` you're on CSV
imports only.

## How it's put together

```
src/
  types.ts          domain model — money is integer cents everywhere, outflows negative
  store.tsx         one immutable DB in context; every write goes through apply(), which
                    snapshots for undo and persists (debounced)
  lib/
    select.ts       all derived data — net worth, cash flow, budget rollups, rollover,
                    recurring detection, sankey, portfolio
    emoji-data.ts   generated: 1,914 emoji, grouped and searchable. Regenerate with
                    scripts/build-emoji.mjs; loaded as its own chunk on first use
    seed.ts         deterministic 24-month demo generator
    csv.ts          RFC-4180 parser, column-role guessing, dedupe, export
    rules.ts        criteria → actions, applied on import and sync
    sync/           adapter interface, SimpleFIN client, merge logic
  components/       ui primitives + hand-rolled SVG charts (no charting dependency)
  screens/          one file per route
api/simplefin.ts    server-side proxy for the bridge
scripts/selftest.mjs  bundles the TS modules with esbuild and asserts against a stub bridge
```

Notable behaviour worth knowing:

- **Transfers are excluded** from income, spending and budgets — a credit-card payment
  moves money, it isn't a new expense. Categories in the Transfers group carry that flag.
- **Clicking a budget figure** opens what's behind it: the last six months as bars, what was
  spent last month, and the monthly average — each one click away from becoming the budget.
  The average counts empty months as zero, so a category used twice a year averages low, which
  is the useful answer when setting a monthly number. *Apply to all future months* stores a
  standing amount rather than writing to every month individually, so it covers months that
  don't exist yet; a single month edited later overrides it again.
- **Rollover** is opt-in per category (⋯ menu on a budget row) and accumulates forward from
  the earliest budgeted month, floored at zero.
- **Recurring detection** wants three or more hits from one merchant, a gap that matches a
  known cadence, *and* consistent gaps — the last part is what stops five random grocery
  runs a month from looking weekly. Amounts may vary (utility bills do).
- **Splits** replace a transaction's own category in every report and budget total.
- Net worth is drawn from per-account balance snapshots, forward-filled, not recomputed
  from transactions — so manual accounts (a house, a car) chart correctly.

## What's deliberately missing

No bank sync beyond SimpleFIN, no market data feed (investment prices are entered by hand),
no multi-user households, no mobile apps, no bill pay. Those are where the $100 goes.

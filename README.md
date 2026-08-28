# Sovereign

A self-hosted personal finance app in the shape of Monarch Money — dashboard, accounts and
net worth, transactions, cash flow, budget, recurring, goals, investments and reports.
Written from scratch; it contains none of Monarch's code or assets.

The point is cost. Monarch is $100/yr, plus $200 for the retirement tier. The data behind
those features costs between **$0 and $15/yr** if you run the app yourself — see
[Bank sync](#bank-sync) below.

## Running it

```
npm install
npm run dev      # http://localhost:5273
npm run build    # type-check + production bundle
npm test         # logic self-tests (19 assertions, no browser needed)
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
| Plaid Trial | $0 | Not wired up. 10 institutions, and the only route with real holdings-level investment data. |
| Teller | $0 | Not wired up. 100 connections, US only, thin on retirement accounts. |

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

Vercel, with **Root Directory** set to `monarch`. `vercel.json` handles the SPA rewrites and
keeps `/api/*` out of them. Any static host works too, but without a host for `api/simplefin.ts`
you're on CSV imports only.

## How it's put together

```
src/
  types.ts          domain model — money is integer cents everywhere, outflows negative
  store.tsx         one immutable DB in context; every write goes through apply(), which
                    snapshots for undo and persists (debounced)
  lib/
    select.ts       all derived data — net worth, cash flow, budget rollups, rollover,
                    recurring detection, sankey, portfolio
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

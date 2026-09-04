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
npm run dev      # http://localhost:5273 - serves the app and the api/ functions
npm run build    # type-check + production bundle
npm test         # logic self-tests, no browser needed
                 # set DATABASE_URL to also exercise the store against real Postgres
```

First launch seeds two years of realistic demo data so every screen has something in it.
**Settings → Danger zone → Erase everything** clears it when you're ready for real numbers.

## Where your data lives

Out of the box: in `localStorage`, in one browser, on one machine. Nothing is transmitted
anywhere unless you connect a sync provider. That means:

- **Take backups.** Settings → *Back up JSON* writes a complete, re-importable snapshot.
  Clearing site data destroys everything otherwise.
- A second browser has none of your data, so it opens on the demo fixture — that is
  `loadDB() ?? buildDemoDB()` doing exactly what it says, not a bug.
- Nothing can run on a schedule, because there is no server holding anything to update.

### Syncing across devices

Settings → *Sync across devices* moves the database into Postgres, behind a passphrase.
Every browser then reads and writes the same document, and a nightly job can update it
while nothing is open.

1. Vercel → your project → **Storage** → **Create Database** → **Neon**. It sets `DATABASE_URL`
   for you. Any Postgres works — the driver is plain `pg` — so Supabase is equally fine.
   **Prisma Postgres is not**: it sets `DATABASE_URL` to a `prisma+postgres://` accelerate URL,
   which is a proxy protocol rather than a Postgres connection. The app detects that and says
   so instead of failing inside the driver.
2. Environment variables: **`SYNC_PASSPHRASE`** (what the app asks you for) and
   **`CRON_SECRET`** (a long random string, so only Vercel can trigger the scheduled job).
3. Redeploy, then connect each browser with the passphrase.

How the two copies are kept honest:

- One row, one JSON document, one integer version. Every save states the version it was
  based on; the server refuses it if the document has moved on, under `SELECT … FOR UPDATE`
  so two simultaneous saves cannot both claim the next version.
- On a conflict the **server copy wins**, because that is what the schedule updates and what
  every other device sees. The losing local copy is set aside rather than dropped — Settings
  offers it back as a download.
- The passphrase lives in the browser that typed it, never in the document.

`vercel.json` runs `/api/cron/sync` daily at 09:00 UTC. Vercel's Hobby plan allows one cron
job at daily granularity; the browser-side schedule in Settings → *Bank sync* still fills in
between visits.

## Bank sync

The document is one JSON blob, pushed whole on every save, and **two companies meter that
traffic**: Neon allows 5 GB of network transfer a month and Vercel 10 GB of Fast Origin
Transfer, which counts the request going up as well as the answer coming back. Exceeding
either pauses things rather than billing for them. So saves are coalesced — eight seconds of
quiet, and never more than thirty from the first unsent edit — which turns an evening of
categorising from forty copies of the budget into two. Leaving the tab flushes immediately, so
the longer wait costs another device nothing. Both allowances have a row in the table below,
reading the same measurement against their own ceiling, and both say what one save costs.

Settings → *Integrations* is one table over all of them — the five data providers below plus
the two pieces of infrastructure they run on: what each does, where its key lives, how much of
its free tier this period has spent, when it last ran and whether it is working. **Neon** shows
the bytes this browser has moved over the sync API against the five gigabytes a month the free
plan allows; that is measured here rather than taken from Neon, because the traffic this app
causes is the thing worth watching and the one that ran the allowance out once already. It also
counts requests, since a runaway sync loop shows up there first. **Vercel** is the 9am job: the
number of cron slots is static and uninteresting, but the column beside it says when the job
last ran, because a cron that quietly stops looks exactly like a quiet week. Every allowance here is measured in a different thing over a different period —
institutions that never reset, lookups that reset monthly, questions that reset at midnight —
so each row carries its own unit rather than pretending they are all "calls". The counting is
deliberate rather than inferred, and it lives in the document, so it follows the budget
between devices and includes what the 9am job spent overnight.

Getting transactions in, cheapest first:

| Route | Cost | Notes |
| --- | --- | --- |
| CSV / manual | $0 | Works today, no signup. Mint, Monarch, YNAB and raw bank exports all import. |
| **SimpleFIN Bridge** | **$15/yr** | Implemented. MX-backed, ~16k institutions, 25 max, refreshes daily. |
| **RentCast** | **$0** | Implemented, for property values — see below. 50 lookups/month on the free tier. |
| **Plaid** | **$0** | Implemented. Trial plan: 10 institutions, and the only route here returning holdings. |
| **Tiingo** | **$0** | Implemented, for share prices — see below. Stocks, ETFs and mutual funds. |
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
plan, and paste it into Settings → *Integrations*. That plan allows 50 lookups a month; two
properties refreshed monthly uses two. Settings also has an **Update now** button that walks
every property with an address.

### Holding prices

Balances are what a bank reports; a share price is not, so it comes from somewhere else.
Tiingo quotes the previous session's close for every holding that carries a ticker, and the
refresh rides along with the daily account sync — the same 9am job, so a morning glance has
both moved together rather than one of them a day behind the other.

Tiingo rather than the alternatives for one reason: a retirement account is mostly mutual
funds, and among the free tiers it is the one that quotes them alongside stocks and ETFs.
Sign up at [tiingo.com](https://www.tiingo.com), copy the API token from your account page,
and paste it into Settings → *Integrations*. The free tier allows 500 distinct symbols a
month, 50 requests an hour and 1,000 a day; there is no batch endpoint, so one holding is one
request and the hourly limit is the binding one. Prices are asked for at most once every six
hours, which is as often as a closing price changes.

Two things are deliberately left alone. A symbol Tiingo has nothing for — a private ticker, a
stable-value fund, a 401(k) recordkeeper's own share class — keeps whatever price was typed in
on the holding, and the Investments screen names it rather than leaving you to work out why
one row is stale. And **an encrypted document is not priced by the scheduled job**: the ticker
list is inside the envelope and the server cannot open it, so those prices refresh when the
app is next opened instead. Everything else about encryption is unchanged.

The key is held in the document and passed per call to `/api/prices`, exactly like RentCast's.
A deployment that would rather keep it out of the document can set `TIINGO_API_KEY` in Vercel;
the scheduled job falls back to it.

### Logos

Bank and merchant marks are fetched by `/api/icon` on the browser's behalf, from DuckDuckGo's
icon service and then Google's, whichever has one. Going through the function rather than
straight out fixes two things: the icon services see the deployment instead of the reader, and
the bytes can be looked at before they are passed on. That second one matters more than it
sounds — when those services have no icon for a domain they answer with a placeholder rather
than a 404, so the page's fallback never fired and a couple of well-known brands showed a grey
circle belonging to nobody. The function learns what each service's "nothing" looks like by
asking it for a domain that cannot exist, and turns that into the 404 it should have been.
Both marks are still settings rather than assumptions, and Plaid's own logos never leave the
app at all.

Merchant logos resolve through a built-in list of a few hundred brands, deliberately not a
guess. Turning "Starbucks" into starbucks.com is easy; turning "Dr Ellen Yao Dds" into a domain
is not, and a guess would send every string a bank ever printed — names of people and small
businesses among them — off to be looked up. A merchant that isn't on the list keeps the
lettered avatar it has always had. Card processors are stripped first, so `SQ *BLUE BOTTLE`
resolves to the coffee shop rather than to Square.

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

**Sync needs that function running.** `npm run dev` mounts `api/` on the dev server itself
(see the `apiFunctions` plugin in `vite.config.ts`), invoking each handler with the same
`(req, res)` and parsed `body` Vercel gives it — so what works locally works deployed. Give
it the same environment variables the deployment has.

Syncing pulls a 90-day window (SimpleFIN's per-request maximum), de-duplicates on the
bridge's own transaction ids, and runs every new transaction through your rules.

### Why api/ imports carry a .js extension

Vercel compiles each function to its own ESM `.js` and lets Node resolve the imports
between them, and Node's ESM resolver requires an explicit extension. `import "./_auth"`
compiles cleanly and then fails at runtime with ERR_MODULE_NOT_FOUND, which the platform
reports as FUNCTION_INVOCATION_FAILED — a clean build and a dead endpoint.

So every relative import in `api/`, and in the `src/` modules it reaches, ends in `.js`
even though the file is `.ts`. TypeScript and Vite both resolve that back to the source.
`npm run check:api` compiles the functions and imports each one under Node, which is the
only check that catches this: under `bundler` resolution the extensionless form is
perfectly legal, it just doesn't survive to runtime.

### Adding another provider

Implement `SyncAdapter` in `src/lib/sync/types.ts`, register it in `src/lib/sync/index.ts`.
`mergeSync` and the rest of the app are provider-agnostic.

## Deploying

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Add New → Project**, pick `sovereign`, press Deploy. No settings to change — `vercel.json`
   already handles the SPA rewrites and keeps `/api/*` out of them.
3. You get a URL like `sovereign-xxxx.vercel.app`. That's the app, on every device you own.

After that, every push to `main` redeploys automatically in about a minute — refresh the page
and the change is there. The functions under `api/` run there too, so bank sync and
cross-device sync work without anything running locally.

A static host works for the UI alone, but without somewhere to run `api/` you are on CSV
imports only, and the database stays in whichever browser you opened.

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
- **Clicking what's left** in a category opens a transfer between categories. A surplus is
  offered to the deepest overspend, a shortfall is filled from the largest surplus, and the
  amount defaults to whatever squares both sides. Only the selected month changes — a standing
  amount keeps applying from the next one, which makes this a correction rather than a re-plan.
- **Sparklines on the Accounts screen** cover the period chosen in the range picker, with a
  dashed line at where each account started so the shape reads as up or down at a glance.
  Group headers carry the aggregate of their accounts. Colour follows the *direction* of the
  signed balance, not its sign — a loan paid down moves toward zero, which adds to net worth
  exactly as a rising asset does, so both are green.
- **Rollover** is opt-in per category (⋯ menu on a budget row) and accumulates forward from
  the earliest budgeted month, floored at zero.
- **Recurring detection** wants three or more hits from one merchant, a gap that matches a
  known cadence, *and* consistent gaps — the last part is what stops five random grocery
  runs a month from looking weekly. Amounts may vary (utility bills do).
- **Splits** replace a transaction's own category in every report and budget total.
- Net worth is drawn from per-account balance snapshots, forward-filled, not recomputed
  from transactions — so manual accounts (a house, a car) chart correctly.

## What's deliberately missing

No intraday quotes (prices are the previous session's close), no multi-user households, no
mobile apps, no bill pay. Those are where the $100 goes.

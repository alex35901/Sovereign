# Sovereign

A self-hosted replica of Monarch Money. Vite + React + TypeScript on the front,
Vercel serverless functions in `api/`, one encrypted JSON document in Postgres
(Neon) behind them. Deployed from `main`; a push to `main` is a deploy.

The repo is still named `monarch-replica` in `package.json`. The app is
Sovereign.

## Who this is for

The owner is not comfortable in a terminal and does not want to run git. They
describe what they want in plain English; you implement it, test it, commit it
and push it to `main`. Do not hand back instructions for them to run. Do not
open pull requests unless asked — `main` is the workflow.

Explain what you did in prose, not diffs. When you make a judgement call they
did not ask about, say so in a sentence and say why, so they can push back.

---

## Match verification depth to risk

This is a standing instruction, and the most important line in this file.
Verification is not free: the browser suite alone is ~167 seconds, so a
mutation-testing pass costs three minutes a cycle. Spend it where a silent bug
would actually hurt.

**Light — layout, copy, colour, spacing, icons, anything purely visual.**
Typecheck, run the suites, look at it in a real browser, screenshot it, ship.
No mutation testing.

**Full — money arithmetic, budgets, goal allocation, sync and merge, the
document store, encryption, anything that writes to the user's data.**
Everything above, plus mutation testing: break the rule you just wrote, in
several different ways, and confirm a named test fails for each. A green test
that cannot fail is worse than no test, because it is trusted.

**In between** — pick one, say which you picked and why in a sentence.

## Mutation testing, when it applies

For each rule you added, deliberately break it and confirm the suite catches
it. Restore between mutations. Things learned doing this here:

- **Check the mutation actually compiled.** `npm run build` runs `tsc -b`
  first, so an invalid mutation leaves the *previous* bundle on disk and the
  suite passes against unchanged code. Always branch on the build's exit
  status and say "BUILD FAILED — mutation invalid" rather than reading the
  result as a pass.
- **A mutation that changes no observable behaviour is not a test gap.**
  Opening every editable row at once looked like an uncaught mutation; the
  rows were closing themselves instantly, so the DOM was identical. Probe the
  DOM once before concluding the test is weak.
- **Watch for masking.** A check must run before anything that could hide what
  it measures. "No row is a form field until asked" was measured *after* a
  click that closes any open row, so it could not have failed.
- **Measure the thing, not its container.** "Values sit hard right" was
  measuring a box that spans the row whichever end its contents are at. It
  would have passed with every value hard left.
- **A single unguarded locator call aborts the whole run** with a stack trace
  instead of the list of what passed and failed — which is the moment the list
  matters most. In `breakpoints.mjs`, wrap anything that can be missing in
  `tryStep`, or use `.catch(() => null)`.

---

## Running things

```bash
npm run build          # tsc -b && check:api && vite build   (~16s)
npm test               # selftest + check:api + dbtest
npm run test:ui        # the browser suite; needs a preview server + CHROME_PATH
npm run lint           # oxlint
```

### Unit tests — `scripts/selftest.mjs` (~446)

esbuild bundles the TS modules under test into ESM and asserts against them.
No browser, no database. `localStorage` is shimmed. Runs in seconds; run it
constantly.

To add a test, export what you need from the bundle's `stdin.contents` list at
the top of the file, then `await test("what it should do", () => { … })`.

### Database tests — `scripts/dbtest.mjs` (~42)

Needs a real Postgres and **skips** (does not fail) without `DATABASE_URL`.
Exercises `api/_store.ts`, `api/db.ts`, `api/hopper.ts`, the cron handler and
the rate limiter.

Local Postgres, from a container running as root:

```bash
export PATH="/usr/lib/postgresql/16/bin:$PATH"
mkdir -p /tmp/pgdata && chown postgres:postgres /tmp/pgdata && chmod 700 /tmp/pgdata
su postgres -c "PATH=$PATH initdb -D /tmp/pgdata -U postgres --auth=trust"
su postgres -c "PATH=$PATH pg_ctl -D /tmp/pgdata -o '-p 5433 -k /tmp' -l /tmp/pg.log start"
su postgres -c "PATH=$PATH createdb -h /tmp -p 5433 -U postgres sovereign"
DATABASE_URL="postgresql://postgres@localhost:5433/sovereign?host=/tmp" npm test
```

`initdb` refuses to run as root — hence `su postgres`.

### Browser tests — `scripts/breakpoints.mjs` (~69)

Real Chromium against a built preview server. Asserts *outcomes* — which
columns are visible at which width, whether anything runs off the edge — rather
than which CSS rules exist, because an element-qualified base rule beats a
plain-class override wherever it sits in the file.

```bash
npm run build && npm run preview -- --port 4173 &
CHROME_PATH=/path/to/chrome node scripts/breakpoints.mjs
CHROME_PATH=... node scripts/breakpoints.mjs --only=detail   # one section, ~7s
```

Sections: `tx-columns`, `tx-align`, `category-arrow`, `overflow`,
`phone-account`, `phone-nav`, `nested-menu`, `drilldown-back`,
`drilldown-scroll`, `goals`, `detail`. **`--only` is for the iteration loop;
the verdict always comes from a full run.** A filtered run prints what it
skipped so it cannot be mistaken for a full one.

In the Claude Code web container, Chromium is at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and must be passed as
`executablePath` explicitly. Ad-hoc verification scripts must live **inside**
the project (esbuild and Playwright resolve from there) and should be deleted
afterwards — do not commit them.

### End-to-end — `scripts/e2etest.mjs`

Two browsers, one encrypted budget, a real database and API. Only reachable
scenario for "connect a second device to an encrypted budget". Skips without
`SYNC_PASSPHRASE`.

---

## Invariants

Breaking any of these is a bug, not a style question.

**All money is integer cents.** Outflows negative, inflows positive.
Liabilities are stored negative so net worth is a plain sum. Never floats.

**Every write goes through `apply(fn, label)`** in `src/store.tsx`. It is
immutable — return a new `DB`, never mutate. `label` is what the undo toast
says; **passing no label means no undo entry**, which is correct for adopting a
document from the server and wrong for a user edit. The undo stack holds 12.

**`api/` has two rules that `tsc` cannot enforce**, both checked by
`scripts/check-api.mjs`, which compiles the functions and actually imports
them:

1. Every relative import inside `api/` — and inside anything it reaches, which
   includes `src/lib` — must end in `.js`. Under `bundler` resolution the
   extensionless form type-checks and then throws `ERR_MODULE_NOT_FOUND` at
   runtime: a clean build and `FUNCTION_INVOCATION_FAILED` on every request.
2. Bare specifiers must be imported lazily — `await import("pg")` — not at
   module top level.

Files in `api/` beginning with `_` are helpers, not routes. Handlers use the
Node `(req, res)` signature.

**End-to-end encryption is load-bearing.** The document is stored as `{ct: …}`
and the server genuinely cannot read it. This is why the cron job cannot price
an encrypted document (it queues work for a browser instead), and why Hopper's
agent loop runs in the browser. Nothing may be added that requires the server
to read the document.

**Credentials that authorise every request stay on the server**
(`ANTHROPIC_API_KEY`, `PLAID_CLIENT_ID` / `PLAID_SECRET`, `TIINGO_API_KEY`,
`CRON_SECRET`, `SYNC_PASSPHRASE`). Per-user keys — RentCast, a user's own
Tiingo token, the SimpleFIN access URL — live in the document and are passed
per call. No provider key ever reaches the browser or appears in a response.
`SYNC_PASSPHRASE` guards `/api/hopper` exactly as it guards `/api/db`.

**Anything user-supplied that lands in an outbound URL is validated against a
strict pattern**, not merely escaped — a ticker symbol, a domain. Merchant
logos resolve only through the curated brand list in
`src/lib/merchant-domain.ts`, so arbitrary statement text is never sent to an
icon service.

---

## How it fits together

- `src/store.tsx` — the single `DB` in React context, `apply`, undo, toasts.
- `src/types.ts` — the document's shape. Read the doc comments; they carry the
  reasoning for the odd-looking fields.
- `src/lib/select.ts` — derived figures: balances, net worth, budget rows, cash
  flow, activity. Nothing is stored twice; it is worked out from the document
  as it is now.
- `src/lib/goal-funding.ts` — the goal/account allocation model. `available` is
  signed (negative means over-assigned); `free` is the floored version and
  exists only for allocation ceilings. Never show `free`.
- `src/lib/sync/` — provider sync, merge, and the save schedule.
- `src/lib/history.ts` — balance-history compression.
- `src/lib/hopper/` — the in-browser agent loop; its tools are read-only.
- `src/shell/` — `Sidebar`, `TopBar`, `ScrollToTop`.
- `src/screens/` — one file per screen; `Drilldown.tsx` is the shape category
  and merchant pages share.

Persistence is localStorage (`sovereign.db.v1`) as a cache with **Postgres as
the source of truth**: one row, one JSON document, an integer version, and
`SELECT … FOR UPDATE` optimistic concurrency. Encryption is a one-way ratchet —
once on, it cannot be turned off.

Saving is debounced (`PUSH_QUIET_MS`, `PUSH_MAX_WAIT_MS` in
`src/lib/sync/schedule.ts`) because **the number of saves is the bill, twice
over**: Neon meters transfer and Vercel meters Fast Origin Transfer, and Vercel
counts the request as well as the response. Transactions are ~95% of the
document.

---

## UI conventions

No UI framework. Inline styles plus a hand-written token system in
`src/index.css`: `--bg`, `--surface`, `--surface-2/3`, `--line`, `--line-soft`,
`--text`, `--muted`, `--faint`, `--accent`, `--pos`, `--neg`, their `-soft`
variants, and the categorical palette `--c1`…`--c13`. Light theme via
`:root[data-theme="light"]` overriding the same names. **Never hard-code a
colour**; contrast ratios in both themes were chosen deliberately and are
recorded in comments.

Breakpoints are 1000 / 900 / 720 / 560 / 400px, and **all of them live in one
consolidated section at the end of `src/index.css`**. Adding a media query
elsewhere is how an override loses to its own base rule.

Patterns worth reusing:

- `Modal` takes `wide` and `flush` (drops body padding, for edge-to-edge rows).
- `SelectInput` renders `<optgroup>` runs from an optional `group` field;
  `accountOptions()` in `src/lib/select.ts` groups every account dropdown under
  the same headings the Accounts screen uses.
- `Popover` has a `Nest` context so a menu portalled out of another menu does
  not close its parent.
- `TopBar` takes `back={{ to, label }}` — a fixed destination, not history,
  because you can reach a category from four different screens.
- The detail-screen row (`.drow`) shows a value as text until it is clicked,
  then swaps that one row to a control. This is not decoration: a text box wide
  enough to type into is wider than its words, so an input left in the row
  strands the merchant logo in the middle of it.

## Writing style

Comments explain **why**, especially why an obvious-looking alternative was
rejected. Several in this codebase describe a real bug that a change caused;
keep that habit — they are the reason the bug has not come back. Match the
surrounding density. Commit messages are prose and say what changed, why, and
what was verified.

---

## Environment

Outbound egress is restricted in the Claude Code container. `plaid.com`,
`tiingo.com`, `icons.duckduckgo.com` and `stooq.com` are blocked by the proxy,
so live third-party responses cannot be seen from here — test against stubs.
Web search works; `WebFetch` on those domains does not.

Provider allowances worth staying inside: SimpleFIN $15/yr for 25 institutions;
Plaid trial 10 free Items; Tiingo 500 distinct symbols/month, 50 requests/hour,
1000/day; RentCast 50 lookups/month; Neon 5 GB transfer/month; Vercel Hobby
10 GB Fast Origin Transfer and 2 cron jobs a day.

## Traps

- An icon service that returns a **placeholder instead of a 404** never fires
  `onError`. `api/icon.ts` learns each source's placeholder by requesting a
  `.invalid` domain first.
- Playwright routes: later registrations win, so catch-alls must be registered
  **first**.
- `addInitScript` re-runs on every navigation. Guard seeded state with
  `if (!localStorage.getItem(…))`, and seed *before* the app boots — writing to
  localStorage after load is overwritten by the app's own save.
- Month labels sort alphabetically. Compare `YYYY-MM` keys, not "March 2026".
- On the Transactions screen, `input.cb` is the selection checkbox, not an edit.
- The window is the scroll container for the whole app, not `.main`.

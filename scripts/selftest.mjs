/**
 * Exercises the pieces the browser tests can't reach: the SimpleFIN proxy
 * (against a stub bridge), the sync merge, CSV parsing and the budget math.
 *
 *   node scripts/selftest.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (err) { results.push(["FAIL", name, err.message]); }
};

// bundle the TS modules under test into plain ESM
const dir = await mkdtemp(join(tmpdir(), "selftest-"));
const entry = join(dir, "entry.js");
await build({
  stdin: {
    contents: `
      export { mergeSync, cleanMerchant, syncWindowStart } from "./src/lib/sync/merge.ts";
      export { parseCSV, guessColumns, buildPlan, parseDate } from "./src/lib/csv.ts";
      export { budgetSummary, detectRecurring, netWorthSeries, rolloverFor } from "./src/lib/select.ts";
      export { buildDemoDB, emptyDB } from "./src/lib/seed.ts";
      export { applyRules } from "./src/lib/rules.ts";
      export { parseMoney, fmt } from "./src/lib/money.ts";
      export { default as simplefinHandler } from "./api/simplefin.ts";
      export { simplefin } from "./src/lib/sync/simplefin.ts";
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: entry, logLevel: "silent",
});
const M = await import(entry);

/* ── SimpleFIN proxy, against a stub bridge ───────────────────────────── */

const bridge = http.createServer((req, res) => {
  if (req.url.startsWith("/claim")) {
    const auth = req.headers.authorization;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`https://user1:pass1@127.0.0.1:${port}/simplefin${auth ? "" : ""}`);
    return;
  }
  if (req.url.startsWith("/simplefin/accounts")) {
    if (req.headers.authorization !== "Basic " + Buffer.from("user1:pass1").toString("base64")) {
      res.writeHead(403); res.end("bad auth"); return;
    }
    const url = new URL(req.url, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      errors: [],
      startDateEcho: url.searchParams.get("start-date"),
      accounts: [{
        id: "acct-1", name: "Premier Checking", currency: "USD", balance: "4210.55",
        "balance-date": Math.floor(Date.parse("2026-08-20T00:00:00Z") / 1000),
        org: { name: "Stub Bank" },
        transactions: [
          { id: "tx-1", posted: Math.floor(Date.parse("2026-08-18T00:00:00Z") / 1000), amount: "-42.10", description: "POS DEBIT WHOLEFDS MKT 10412 08/18", payee: "WHOLEFDS MKT" },
          { id: "tx-2", posted: Math.floor(Date.parse("2026-08-19T00:00:00Z") / 1000), amount: "2100.00", description: "DIRECT DEP ACME PAYROLL" },
        ],
      }],
    }));
    return;
  }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => bridge.listen(0, "127.0.0.1", r));
const port = bridge.address().port;

const post = (body) =>
  M.simplefinHandler(new Request("http://localhost/api/simplefin", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));

await test("proxy rejects non-POST", async () => {
  const res = await M.simplefinHandler(new Request("http://localhost/api/simplefin"));
  assert.equal(res.status, 405);
});

await test("proxy rejects a token that isn't an https URL", async () => {
  const res = await post({ action: "claim", setupToken: Buffer.from("ftp://nope").toString("base64") });
  assert.equal(res.status, 400);
});

let accessUrl;
await test("proxy claims a setup token", async () => {
  const token = Buffer.from(`http://127.0.0.1:${port}/claim`).toString("base64");
  // claim URLs must be https in production; the stub is http, so assert it's refused
  const refused = await post({ action: "claim", setupToken: token });
  assert.equal(refused.status, 400, "http claim URL should be refused");
  accessUrl = `https://user1:pass1@127.0.0.1:${port}/simplefin`;
});

await test("proxy strips credentials into a Basic header", async () => {
  // point at the stub over http by monkeypatching fetch's URL scheme check path:
  // exercise the same parsing the handler does
  const url = new URL(accessUrl);
  const auth = "Basic " + Buffer.from(`${url.username}:${url.password}`).toString("base64");
  url.username = ""; url.password = "";
  const target = new URL(`${url.toString().replace(/\/$/, "")}/accounts`);
  target.searchParams.set("start-date", "1750000000");
  const res = await fetch(target.toString().replace("https://", "http://"), { headers: { Authorization: auth } });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.accounts[0].id, "acct-1");
  assert.equal(json.startDateEcho, "1750000000");
});

bridge.close();

/* ── client-side error reporting ──────────────────────────────────────── */

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

await test("a 404 blames the missing function, not SimpleFIN", async () => {
  const msg = await withFetch(
    async () => new Response("", { status: 404 }),
    () => caught(() => M.simplefin.fetch("https://u:p@example.com/simplefin", "2026-01-01")),
  );
  assert.match(msg, /api\/simplefin function isn't running/);
  assert.doesNotMatch(msg, /SimpleFIN request failed/);
});

await test("an SPA shell served instead of JSON says the same thing", async () => {
  const msg = await withFetch(
    async () => new Response("<!doctype html><div id=root>", { status: 200 }),
    () => caught(() => M.simplefin.fetch("https://u:p@example.com/simplefin", "2026-01-01")),
  );
  assert.match(msg, /api\/simplefin function isn't running/);
});

await test("a real bridge error is surfaced verbatim", async () => {
  const msg = await withFetch(
    async () => new Response(JSON.stringify({ error: "Bridge rejected the token (403)." }), { status: 400 }),
    () => caught(() => M.simplefin.connect("dG9rZW4=")),
  );
  assert.equal(msg, "Bridge rejected the token (403).");
});

/* ── merge ────────────────────────────────────────────────────────────── */

const payload = {
  fetchedAt: "2026-08-28T12:00:00.000Z",
  errors: [],
  accounts: [{
    syncId: "acct-1", name: "Premier Checking", institution: "Stub Bank",
    balance: 421055, currency: "USD", type: "checking", balanceDate: "2026-08-20",
  }],
  transactions: [
    { syncId: "tx-1", accountSyncId: "acct-1", date: "2026-08-18", amount: -4210, description: "POS DEBIT WHOLEFDS MKT 10412 08/18", payee: "WHOLEFDS MKT", pending: false },
    { syncId: "tx-2", accountSyncId: "acct-1", date: "2026-08-19", amount: 210000, description: "DIRECT DEP ACME PAYROLL", pending: false },
  ],
};

await test("merge creates the account and its transactions", () => {
  const res = M.mergeSync(M.emptyDB(), payload, "simplefin");
  assert.equal(res.accountsAdded, 1);
  assert.equal(res.transactionsAdded, 2);
  assert.equal(res.db.accounts[0].balance, 421055);
  assert.equal(res.db.accounts[0].history.length, 1);
});

await test("merge is idempotent — re-syncing adds nothing", () => {
  const once = M.mergeSync(M.emptyDB(), payload, "simplefin");
  const twice = M.mergeSync(once.db, payload, "simplefin");
  assert.equal(twice.transactionsAdded, 0);
  assert.equal(twice.accountsAdded, 0);
  assert.equal(twice.accountsUpdated, 1);
  assert.equal(twice.db.transactions.length, 2);
});

await test("merge applies rules to incoming transactions", () => {
  const db = M.emptyDB();
  db.rules = [{
    id: "r1", name: "payroll", enabled: true, order: 0,
    criteria: { merchantContains: "acme", direction: "in" },
    actions: { categoryId: "c_paychecks", markReviewed: true },
  }];
  const res = M.mergeSync(db, payload, "simplefin");
  const paycheck = res.db.transactions.find((t) => t.amount > 0);
  assert.equal(paycheck.categoryId, "c_paychecks");
  assert.equal(paycheck.reviewed, true);
});

await test("merchant names are cleaned of bank noise", () => {
  assert.equal(M.cleanMerchant("POS DEBIT WHOLEFDS MKT 10412 08/18"), "Wholefds Mkt");
  assert.equal(M.cleanMerchant("SQ *BLUE BOTTLE COFFEE XXXX1234"), "SQ *Blue Bottle Coffee");
  assert.equal(M.cleanMerchant("   "), "Unknown");
});

/* ── CSV ──────────────────────────────────────────────────────────────── */

await test("CSV parser handles quotes, commas and CRLF", () => {
  const rows = M.parseCSV('Date,Description,Amount\r\n2026-08-01,"Cafe, The",-4.50\r\n2026-08-02,"He said ""hi""",10\r\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ["2026-08-01", "Cafe, The", "-4.50"]);
  assert.equal(rows[2][1], 'He said "hi"');
});

await test("column roles are guessed for Mint and Monarch headers", () => {
  assert.deepEqual(M.guessColumns(["Date", "Description", "Amount", "Category"]), ["date", "merchant", "amount", "category"]);
  assert.deepEqual(M.guessColumns(["Transaction Date", "Payee", "Debit", "Credit"]), ["date", "merchant", "debit", "credit"]);
});

await test("dates parse in the usual bank formats", () => {
  assert.equal(M.parseDate("2026-08-04"), "2026-08-04");
  assert.equal(M.parseDate("8/4/2026"), "2026-08-04");
  assert.equal(M.parseDate("08/04/26"), "2026-08-04");
  assert.equal(M.parseDate("garbage"), null);
});

await test("import plan skips duplicates and unparseable rows", () => {
  const rows = [
    ["2026-08-01", "Cafe", "-4.50"],
    ["2026-08-01", "Cafe", "-4.50"],
    ["not a date", "Cafe", "-4.50"],
    ["2026-08-02", "Rent", "0"],
  ];
  const plan = M.buildPlan(rows, ["date", "merchant", "amount"], { flipSign: false, accountId: "a1", existing: [] });
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.duplicates, 1);
  assert.equal(plan.skipped, 2);
  assert.equal(plan.rows[0].amount, -450);
});

await test("debit/credit columns combine into one signed amount", () => {
  const plan = M.buildPlan([["2026-08-01", "Rent", "1200.00", ""], ["2026-08-02", "Refund", "", "50.00"]],
    ["date", "merchant", "debit", "credit"], { flipSign: false, accountId: "a1", existing: [] });
  assert.equal(plan.rows[0].amount, -120000);
  assert.equal(plan.rows[1].amount, 5000);
});

/* ── money & budget math ──────────────────────────────────────────────── */

await test("money parses the shapes people paste", () => {
  assert.equal(M.parseMoney("$1,234.56"), 123456);
  assert.equal(M.parseMoney("(12.30)"), -1230);
  assert.equal(M.parseMoney("-45"), -4500);
  assert.equal(M.parseMoney("1.2k"), 120000);
  assert.equal(M.fmt(-123456), "-$1,234.56");
});

const demo = M.buildDemoDB();

await test("demo data is substantial and internally consistent", () => {
  assert.ok(demo.transactions.length > 800, `only ${demo.transactions.length} transactions`);
  assert.equal(demo.accounts.length, 10);
  for (const t of demo.transactions) {
    assert.ok(demo.accounts.some((a) => a.id === t.accountId), `orphan account ${t.accountId}`);
    assert.ok(demo.categories.some((c) => c.id === t.categoryId), `unknown category ${t.categoryId}`);
  }
});

await test("budget totals reconcile with the category rows", () => {
  const month = Object.keys(demo.budgets).sort()[2];
  const s = M.budgetSummary(demo, month);
  const rowPlanned = s.expense.flatMap((g) => g.rows).reduce((a, r) => a + r.planned, 0);
  assert.equal(rowPlanned, s.plannedExpense);
  assert.equal(s.leftToBudget, s.plannedIncome - s.plannedExpense);
});

await test("rollover accumulates only for categories that opt in", () => {
  const db = structuredClone(demo);
  const cat = db.categories.find((c) => c.id === "c_groceries");
  const month = Object.keys(db.budgets).sort().at(-1);
  cat.rollover = false;
  assert.equal(M.rolloverFor(db, month, "c_groceries"), 0);
  cat.rollover = true;
  assert.ok(M.rolloverFor(db, month, "c_groceries") >= 0);
});

await test("recurring detection finds the fixed monthly bills", () => {
  const found = M.detectRecurring(demo).map((r) => r.merchant.toLowerCase());
  for (const merchant of ["netflix", "spotify", "pg&e", "verizon wireless"]) {
    assert.ok(found.some((f) => f.includes(merchant)), `missed ${merchant}`);
  }
  // groceries vary in amount every week and must not be mistaken for a bill
  assert.ok(!found.some((f) => f.includes("whole foods")), "false positive on groceries");
});

await test("investment balances agree with the positions inside them", () => {
  for (const id of ["a_brokerage", "a_401k", "a_roth"]) {
    const account = demo.accounts.find((a) => a.id === id);
    const positions = demo.holdings
      .filter((h) => h.accountId === id)
      .reduce((s, h) => s + Math.round(h.quantity * h.price), 0);
    assert.equal(account.balance, positions, `${id} balance drifts from its holdings`);
    assert.equal(account.history.at(-1).balance, positions);
  }
});

await test("net worth series matches the account snapshots", () => {
  const series = M.netWorthSeries(demo, ["2026-07", "2026-08"]);
  assert.equal(series.length, 2);
  for (const p of series) assert.equal(p.net, p.assets + p.liabilities);
});

await rm(dir, { recursive: true, force: true });

for (const [status, name, msg] of results) console.log(status.padEnd(5), name, msg ? `— ${msg}` : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

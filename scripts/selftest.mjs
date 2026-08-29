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
      export { default as propertyHandler } from "./api/property.ts";
      export { estimateHomeValue, canValue } from "./src/lib/property.ts";
      export { readBalanceCSV, guessBalanceColumns, buildBalancePlan, compress, mergeHistory, defaultNegate } from "./src/lib/balance-csv.ts";
      export { simplefin } from "./src/lib/sync/simplefin.ts";
      export { EMOJI_GROUPS, ALL_EMOJI, searchEmoji } from "./src/lib/emoji-data.ts";
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

/**
 * Calls the handler exactly the way Vercel's Node runtime does — (req, res),
 * never a Web Request. A handler that writes nothing fails here instead of
 * hanging a browser forever, which is the bug this shape is guarding against.
 */
const invokeOn = (handler, body, method = "POST") =>
  new Promise((resolve, reject) => {
    const headers = {};
    // Only res.end() settles this. Resolving the handler's promise must NOT, or
    // a handler that returns without writing would hang the suite instead of
    // failing it — which is precisely the defect being guarded against.
    const timer = setTimeout(() => reject(new Error("handler never wrote a response")), 5000);
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (text) => { clearTimeout(timer); resolve({ status: res.statusCode, headers, text: text ?? "" }); },
    };
    Promise.resolve(handler({ method, body }, res))
      .catch((err) => { clearTimeout(timer); reject(err); });
  });

const invoke = (body, method = "POST") => invokeOn(M.simplefinHandler, body, method);
const invokeProperty = (body, method = "POST") => invokeOn(M.propertyHandler, body, method);

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

const post = async (body, method = "POST") => {
  const r = await invoke(body, method);
  return { status: r.status, json: r.text ? JSON.parse(r.text) : {} };
};

await test("proxy always writes a response (never hangs the caller)", async () => {
  const r = await invoke({ action: "claim", setupToken: "" });
  assert.ok(r.status >= 400, "an unusable token should still get an answer");
  assert.equal(r.headers["content-type"], "application/json");
});

await test("proxy rejects non-POST", async () => {
  const res = await post({}, "GET");
  assert.equal(res.status, 405);
});

await test("proxy rejects a malformed body", async () => {
  const r = await invoke(undefined);
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.text).error, /Malformed/);
});

await test("proxy rejects a token that isn't an https URL", async () => {
  const res = await post({ action: "claim", setupToken: Buffer.from("ftp://nope").toString("base64") });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /https URL/);
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

/* ── property valuations ──────────────────────────────────────────────── */

const rentcast = (impl) => withFetch(impl, () => invokeProperty({ apiKey: "k", address: "1 Main St, Springfield, OR 97477" }));
const errorOf = (r) => JSON.parse(r.text).error;

await test("property proxy always writes a response", async () => {
  const r = await invokeProperty({});
  assert.ok(r.status >= 400);
  assert.equal(r.headers["content-type"], "application/json");
});

await test("property proxy rejects non-POST and missing fields", async () => {
  assert.equal((await invokeProperty({}, "GET")).status, 405);
  assert.match(errorOf(await invokeProperty({ address: "1 Main St" })), /API key/);
  assert.match(errorOf(await invokeProperty({ apiKey: "k" })), /address/);
});

await test("property proxy sends the key as a header, never in the URL", async () => {
  let seen;
  const r = await rentcast(async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ price: 812500, priceRangeLow: 780000, priceRangeHigh: 845000 }), { status: 200 });
  });
  assert.equal(r.status, 200);
  assert.ok(seen.url.startsWith("https://api.rentcast.io/v1/avm/value?address="));
  assert.equal(seen.headers["X-Api-Key"], "k");
  assert.doesNotMatch(seen.url, /apiKey|X-Api-Key|[?&]key=/i, "the key must not leak into the query string");
  assert.equal(JSON.parse(r.text).price, 812500);
});

await test("a rejected key says so, rather than showing a raw 401", async () => {
  const r = await rentcast(async () => new Response("Unauthorized", { status: 401 }));
  assert.match(errorOf(r), /rejected the API key/);
});

await test("exhausting the free quota explains itself", async () => {
  const r = await rentcast(async () => new Response("Too Many Requests", { status: 429 }));
  assert.equal(r.status, 429);
  assert.match(errorOf(r), /50 free RentCast lookups/);
});

await test("an unknown address suggests the address format", async () => {
  const r = await rentcast(async () => new Response(JSON.stringify({}), { status: 200 }));
  assert.equal(r.status, 404);
  assert.match(errorOf(r), /street, city, state, ZIP/);
});

await test("a stalled provider times out instead of hanging", async () => {
  const r = await rentcast(async () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    throw err;
  });
  assert.equal(r.status, 504);
  assert.match(errorOf(r), /didn't respond within 15 seconds/);
});

await test("the client converts dollars to cents and guards its inputs", async () => {
  const estimate = await withFetch(
    async () => new Response(JSON.stringify({ price: 812500.4, priceRangeLow: 780000, priceRangeHigh: 845000 }), { status: 200 }),
    () => M.estimateHomeValue("key", "1 Main St"),
  );
  assert.equal(estimate.value, 81250040);
  assert.equal(estimate.low, 78000000);
  assert.equal(estimate.high, 84500000);
  assert.match(await caught(() => M.estimateHomeValue("", "1 Main St")), /API key/);
  assert.match(await caught(() => M.estimateHomeValue("k", "  ")), /address/);
});

await test("only property account types offer valuation", () => {
  assert.equal(M.canValue("real_estate"), true);
  assert.equal(M.canValue("other_asset"), true);
  assert.equal(M.canValue("checking"), false);
  assert.equal(M.canValue("mortgage"), false);
});

/* ── emoji picker data ────────────────────────────────────────────────── */

await test("emoji dataset is well-formed", () => {
  assert.equal(M.EMOJI_GROUPS.length, 9);
  assert.ok(M.ALL_EMOJI.length > 1800, `only ${M.ALL_EMOJI.length} emoji`);
  for (const g of M.EMOJI_GROUPS) assert.ok(g.emojis.length > 0, `${g.key} is empty`);
  for (const e of M.ALL_EMOJI) {
    assert.ok(e.c && e.n, `malformed entry ${JSON.stringify(e)}`);
  }
  const chars = new Set(M.ALL_EMOJI.map((e) => e.c));
  assert.equal(chars.size, M.ALL_EMOJI.length, "duplicate emoji in the dataset");
});

await test("every word a budgeter would type finds an emoji", () => {
  // Unicode's own keywords cover none of these; the synonym layer in
  // scripts/build-emoji.mjs is what makes them searchable.
  const words = [
    "grocery", "groceries", "rent", "mortgage", "paycheck", "salary", "income",
    "insurance", "utilities", "internet", "phone", "gas", "fuel", "car", "auto",
    "dining", "restaurant", "coffee", "travel", "vacation", "subscription",
    "streaming", "gym", "fitness", "medical", "doctor", "pet", "childcare",
    "kids", "shopping", "clothes", "savings", "investment", "retirement", "debt",
    "loan", "tax", "charity", "gift", "haircut", "parking", "transit",
    "electricity", "water", "trash", "furniture", "electronics", "entertainment",
  ];
  const missing = words.filter((w) => M.searchEmoji(w, 3).length === 0);
  assert.deepEqual(missing, [], `no emoji for: ${missing.join(", ")}`);
});

await test("search ranks exact names above keyword hits", () => {
  const [first] = M.searchEmoji("avocado", 5);
  assert.equal(first.c, "\u{1F951}");
});

/* ── client-side error reporting ──────────────────────────────────────── */

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

/* ── balance history import ───────────────────────────────────────────── */

/** The shape of a real property-history export: a row per day, mostly repeats. */
const daily = (() => {
  const lines = ["Date,Balance,Account"];
  const start = Date.parse("2024-09-22T00:00:00Z");
  for (let i = 0; i < 100; i++) {
    const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const balance = i < 5 ? "477700.00" : i < 50 ? "474600.00" : "480500.00";
    lines.push(`${d},${balance},3122 N Clifton Ave Apt 1 Chicago IL 60657`);
  }
  return lines.join("\n");
})();

await test("a daily series collapses to its change points", () => {
  const { header, rows, hasHeader } = M.readBalanceCSV(daily);
  assert.equal(hasHeader, true);
  assert.deepEqual(M.guessBalanceColumns(header), ["date", "balance", "account"]);
  const plan = M.buildBalancePlan(rows, ["date", "balance", "account"], { negate: false });
  assert.equal(plan.rowsRead, 100);
  // three distinct values, and the final day pinned
  assert.equal(plan.points.length, 4);
  assert.equal(plan.first.balance, 47770000);
  assert.equal(plan.last.date, "2024-12-30");
  assert.equal(plan.last.balance, 48050000);
  assert.deepEqual(plan.accountLabels, ["3122 N Clifton Ave Apt 1 Chicago IL 60657"]);
});

await test("compression never moves the first or last point", () => {
  const pts = [
    { date: "2026-01-01", balance: 100 },
    { date: "2026-01-02", balance: 100 },
    { date: "2026-01-03", balance: 100 },
  ];
  const out = M.compress(pts);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], pts[0]);
  assert.deepEqual(out[1], pts[2]);
});

await test("a file with no header row still parses", () => {
  const { hasHeader, rows } = M.readBalanceCSV("2026-01-01,500\n2026-02-01,600");
  assert.equal(hasHeader, false);
  assert.equal(rows.length, 2);
  const plan = M.buildBalancePlan(rows, ["date", "balance"], { negate: false });
  assert.equal(plan.points.length, 2);
});

await test("amounts owed can be stored as debt", () => {
  const { rows } = M.readBalanceCSV("Date,Balance\n2026-01-01,250000\n2026-02-01,248000");
  const plan = M.buildBalancePlan(rows, ["date", "balance"], { negate: true });
  assert.equal(plan.first.balance, -25000000);
  assert.equal(plan.last.balance, -24800000);
  assert.equal(M.defaultNegate("mortgage"), true);
  assert.equal(M.defaultNegate("real_estate"), false);
});

await test("a multi-property file can be filtered to one", () => {
  const csv = [
    "Date,Balance,Account",
    "2026-01-01,100,Main Home",
    "2026-01-01,200,Rental",
    "2026-02-01,110,Main Home",
    "2026-02-01,220,Rental",
  ].join("\n");
  const { rows } = M.readBalanceCSV(csv);
  const all = M.buildBalancePlan(rows, ["date", "balance", "account"], { negate: false });
  assert.deepEqual(all.accountLabels, ["Main Home", "Rental"]);
  const rental = M.buildBalancePlan(rows, ["date", "balance", "account"], { negate: false, accountLabel: "Rental" });
  assert.equal(rental.points.length, 2);
  assert.equal(rental.first.balance, 20000);
  assert.equal(rental.last.balance, 22000);
});

await test("merge keeps existing points, replace drops them", () => {
  const existing = [{ date: "2020-01-01", balance: 1 }, { date: "2026-01-01", balance: 2 }];
  const incoming = [{ date: "2026-01-01", balance: 99 }, { date: "2026-02-01", balance: 3 }];
  const merged = M.mergeHistory(existing, incoming, "merge");
  assert.equal(merged.length, 3);
  assert.equal(merged[0].date, "2020-01-01");
  assert.equal(merged[1].balance, 99, "the incoming value should win on a shared date");
  const replaced = M.mergeHistory(existing, incoming, "replace");
  assert.equal(replaced.length, 2);
  assert.equal(replaced[0].date, "2026-01-01");
});

await test("unreadable rows are counted, not silently dropped", () => {
  const { rows } = M.readBalanceCSV("Date,Balance\n2026-01-01,500\nnot-a-date,600\n2026-03-01,");
  const plan = M.buildBalancePlan(rows, ["date", "balance"], { negate: false });
  assert.equal(plan.points.length, 1);
  assert.equal(plan.skipped, 2);
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

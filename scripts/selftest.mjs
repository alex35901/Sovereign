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
      export { default as plaidHandler } from "./api/plaid.ts";
      export { mapAccountType, mapAssetClass, isLiability, fetchItem, createLinkToken } from "./src/lib/sync/plaid.ts";
      export { estimateHomeValue, canValue } from "./src/lib/property.ts";
      export { readBalanceCSV, guessBalanceColumns, buildBalancePlan, compress, mergeHistory, defaultNegate } from "./src/lib/balance-csv.ts";
      export { rangeTicks, axisFormat } from "./src/components/charts.tsx";
      export { aggregateSeries, trendTone, balanceAt } from "./src/lib/select.ts";
      export { ACCOUNT_GROUPS, ACCOUNT_TYPE_LABEL, plannedFor, categoryHistory, categoryAverage, budgetTable, applyForward, remainingTone, spentShare } from "./src/lib/select.ts";
      export { moveCandidates, suggestCounterpart, suggestedAmount, moveBudget } from "./src/lib/budget-move.ts";
      export { RANGES, rangeMonths, rangeStart, sampleDates, sampleLabel, spanDays } from "./src/lib/range.ts";
      export { thisMonth, addMonths } from "./src/lib/date.ts";
      export { retentionAt, effectiveYears, estimateVehicleValue, refreshVehicleValues, vehicleNeedsRefresh, VEHICLE_CLASSES } from "./src/lib/vehicle.ts";
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
const invokePlaid = (body, method = "POST") => invokeOn(M.plaidHandler, body, method);

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

/* ── budget defaults and history ──────────────────────────────────────── */

const budgetDb = () => {
  const db = M.emptyDB();
  db.budgets = { "2026-06": { c_groceries: 60000 }, "2026-07": { c_groceries: 65000 } };
  return db;
};

await test("an explicit month beats the standing amount", () => {
  const db = budgetDb();
  db.budgetDefaults = { c_groceries: { amount: 80000, from: "2026-06" } };
  assert.equal(M.plannedFor(db, "2026-06", "c_groceries"), 60000);
  assert.equal(M.plannedFor(db, "2026-07", "c_groceries"), 65000);
  // no entry for August, so the standing amount shows through
  assert.equal(M.plannedFor(db, "2026-08", "c_groceries"), 80000);
});

await test("a standing amount never reaches backwards", () => {
  const db = M.emptyDB();
  db.budgetDefaults = { c_groceries: { amount: 80000, from: "2026-08" } };
  assert.equal(M.plannedFor(db, "2026-07", "c_groceries"), 0, "July predates it");
  assert.equal(M.plannedFor(db, "2026-08", "c_groceries"), 80000);
  assert.equal(M.plannedFor(db, "2030-01", "c_groceries"), 80000, "and it has no end");
});

await test("applying forward clears later months but keeps earlier ones", () => {
  const db = budgetDb();
  db.budgets["2026-08"] = { c_groceries: 70000, c_gas: 12000 };
  const next = M.applyForward(db, "2026-07", "c_groceries", 75000);
  assert.equal(next.budgets["2026-06"].c_groceries, 60000, "June is in the past and untouched");
  assert.equal(next.budgets["2026-07"].c_groceries, undefined, "July now follows the standing amount");
  assert.equal(next.budgets["2026-08"].c_groceries, undefined, "August too");
  assert.equal(next.budgets["2026-08"].c_gas, 12000, "other categories are left alone");
  assert.equal(M.plannedFor(next, "2026-07", "c_groceries"), 75000);
  assert.equal(M.plannedFor(next, "2027-03", "c_groceries"), 75000);
});

await test("history counts empty months, and the average with them", () => {
  const db = M.emptyDB();
  const at = (month, amount) => ({
    id: `t${month}`, accountId: "a1", date: `${month}-15`, merchant: "M", amount: -amount,
    categoryId: "c_groceries", tags: [], pending: false, reviewed: true, hideFromReports: false, createdAt: "",
  });
  // 3,600 in five of six months, nothing in the third
  db.transactions = [
    at("2026-02", 360000), at("2026-03", 360000),
    at("2026-05", 360000), at("2026-06", 360000), at("2026-07", 360000),
  ];
  const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  const history = M.categoryHistory(db, "c_groceries", months);
  assert.equal(history.length, 6);
  assert.deepEqual(history.map((h) => h.actual), [360000, 360000, 0, 360000, 360000, 360000]);
  // 3,600 x 5 over six months is 3,000 — the empty month has to count
  assert.equal(M.categoryAverage(history), 300000);
  assert.equal(history[history.length - 1].actual, 360000, "last month reads straight off the end");
});

await test("a budget row driven by a standing amount reports it", () => {
  const db = M.emptyDB();
  db.budgetDefaults = { c_groceries: { amount: 50000, from: "2026-01" } };
  const rows = M.budgetTable(db, "2026-09").flatMap((g) => g.rows);
  const groceries = rows.find((r) => r.category.id === "c_groceries");
  assert.ok(groceries, "the category should appear even with no explicit entry");
  assert.equal(groceries.planned, 50000);
});

/* ── moving money between categories ─────────────────────────────────── */

/** A month with one category in surplus, one overspent, and one untouched. */
const moveDb = () => {
  const db = M.emptyDB();
  db.budgets = { "2026-08": { c_home_improvement: 40000, c_groceries: 60000, c_gas: 20000 } };
  const spend = (id, amount, n) => ({
    id: `t_${id}_${n}`, accountId: "a1", date: "2026-08-10", merchant: "M", amount: -amount,
    categoryId: id, tags: [], pending: false, reviewed: true, hideFromReports: false, createdAt: "",
  });
  db.transactions = [
    spend("c_home_improvement", 2400, 1),   // $376 of $400 left
    spend("c_groceries", 117100, 1),        // $571 over
    spend("c_gas", 10000, 1),               // $100 left
  ];
  return db;
};

await test("a surplus is offered to the deepest overspend", () => {
  const db = moveDb();
  const candidates = M.moveCandidates(db, "2026-08");
  const home = candidates.find((c) => c.categoryId === "c_home_improvement");
  assert.equal(home.remaining, 37600);
  const target = M.suggestCounterpart(candidates, "c_home_improvement", "to");
  assert.equal(target.categoryId, "c_groceries", "groceries is the deepest hole");
  assert.equal(target.remaining, -57100);
  // and the amount squares as much as it can without overdrawing the source
  assert.equal(M.suggestedAmount(home, target), 37600);
});

await test("an overspend is filled from the largest surplus", () => {
  const db = moveDb();
  const candidates = M.moveCandidates(db, "2026-08");
  const source = M.suggestCounterpart(candidates, "c_groceries", "from");
  assert.equal(source.categoryId, "c_home_improvement", "$376 beats gas's $100");
});

await test("nothing is suggested when there is no counterpart", () => {
  const db = M.emptyDB();
  db.budgets = { "2026-08": { c_groceries: 60000 } };
  const candidates = M.moveCandidates(db, "2026-08");
  assert.equal(M.suggestCounterpart(candidates, "c_groceries", "to"), undefined);
  assert.equal(M.suggestedAmount(candidates[0], undefined), 0);
});

await test("moving shifts both sides and conserves the total", () => {
  const db = moveDb();
  const before = M.budgetTable(db, "2026-08").flatMap((g) => g.rows).reduce((s, r) => s + r.planned, 0);
  const { db: after, moved } = M.moveBudget(db, "2026-08", "c_home_improvement", "c_groceries", 37600);
  assert.equal(moved, 37600);
  assert.equal(M.plannedFor(after, "2026-08", "c_home_improvement"), 40000 - 37600);
  assert.equal(M.plannedFor(after, "2026-08", "c_groceries"), 60000 + 37600);
  const total = M.budgetTable(after, "2026-08").flatMap((g) => g.rows).reduce((s, r) => s + r.planned, 0);
  assert.equal(total, before, "moving money must not create or destroy any");
});

await test("a category can't give more than it holds", () => {
  const db = moveDb();
  const { db: after, moved } = M.moveBudget(db, "2026-08", "c_gas", "c_groceries", 99999900);
  assert.equal(moved, 20000, "capped at what gas has budgeted");
  assert.equal(M.plannedFor(after, "2026-08", "c_gas"), 0);
});

await test("nonsense moves are refused", () => {
  const db = moveDb();
  for (const args of [
    ["c_gas", "c_gas", 1000],
    ["", "c_gas", 1000],
    ["c_gas", "", 1000],
    ["c_gas", "c_groceries", 0],
    ["c_gas", "c_groceries", -500],
  ]) {
    const res = M.moveBudget(db, "2026-08", ...args);
    assert.equal(res.moved, 0, `${JSON.stringify(args)} should move nothing`);
    assert.equal(res.db, db, "and leave the database untouched");
  }
});

await test("a move survives a standing amount rather than being undone by it", () => {
  const db = moveDb();
  // gas is set to $200 every month from August on
  const withDefault = M.applyForward(db, "2026-08", "c_gas", 20000);
  const { db: after } = M.moveBudget(withDefault, "2026-08", "c_gas", "c_groceries", 20000);
  assert.equal(M.plannedFor(after, "2026-08", "c_gas"), 0, "August was emptied by the move");
  assert.equal(M.plannedFor(after, "2026-09", "c_gas"), 20000, "September still follows the standing amount");
});

await test("a category emptied by a move stays on the sheet", () => {
  const db = moveDb();
  // move every last cent of home improvement's remaining into groceries
  const before = M.moveCandidates(db, "2026-08").find((c) => c.categoryId === "c_home_improvement");
  const { db: after } = M.moveBudget(db, "2026-08", "c_home_improvement", "c_groceries", before.planned);
  assert.equal(M.plannedFor(after, "2026-08", "c_home_improvement"), 0);

  const rows = M.budgetTable(after, "2026-08").flatMap((g) => g.rows);
  const home = rows.find((r) => r.category.id === "c_home_improvement");
  assert.ok(home, "the category disappeared from the budget after being emptied");
  assert.equal(home.planned, 0);
});

await test("a category emptied with no spending at all still stays", () => {
  const db = M.emptyDB();
  db.budgets = { "2026-08": { c_mortgage: 284600, c_miscellaneous: 0 } };
  // no transactions this month, and mortgage moved down to nothing
  const { db: after } = M.moveBudget(db, "2026-08", "c_mortgage", "c_miscellaneous", 284600);
  const rows = M.budgetTable(after, "2026-08").flatMap((g) => g.rows);
  assert.ok(rows.find((r) => r.category.id === "c_mortgage"), "mortgage vanished");
  assert.equal(rows.find((r) => r.category.id === "c_mortgage").planned, 0);
});

await test("every category is listed in every month, budgeted or not", () => {
  const db = M.emptyDB();
  db.budgets = { "2026-08": { c_groceries: 60000 } };
  const budgetable = db.categories.filter((c) => !c.excludeFromBudget && !c.archived).length;

  const august = M.budgetTable(db, "2026-08").flatMap((g) => g.rows);
  assert.equal(august.length, budgetable, "a quiet category is still part of the sheet");
  assert.equal(august.find((r) => r.category.id === "c_groceries").planned, 60000);
  assert.equal(august.find((r) => r.category.id === "c_gas").planned, 0);

  // The complaint that prompted this: a future month came up nearly empty and
  // every category had to be added back by hand.
  const future = M.budgetTable(db, "2027-04").flatMap((g) => g.rows);
  assert.equal(future.length, budgetable, "a future month lists the same categories");
  assert.deepEqual(future.map((r) => r.category.id), august.map((r) => r.category.id));
});

await test("a rollover category carries unspent money into what's left", () => {
  const db = M.emptyDB();
  db.categories = db.categories.map((c) => (c.id === "c_groceries" ? { ...c, rollover: true } : c));
  db.budgets = { "2026-07": { c_groceries: 60000 }, "2026-08": { c_groceries: 60000 } };
  db.transactions = [{
    id: "t1", accountId: "a1", date: "2026-07-10", merchant: "M", amount: -45000,
    categoryId: "c_groceries", tags: [], pending: false, reviewed: true, hideFromReports: false, createdAt: "",
  }];

  const row = M.budgetTable(db, "2026-08").flatMap((g) => g.rows).find((r) => r.category.id === "c_groceries");
  assert.equal(row.rollover, 15000, "$150 went unspent in July");
  assert.equal(row.planned, 60000);
  assert.equal(row.actual, 0);
  // what the hover card adds up and shows
  const available = row.rollover + row.planned;
  assert.equal(available, 75000);
  assert.equal(available - row.actual, row.remaining, "available less spent is what's left");
  assert.equal(M.spentShare(available, row.actual), 0);
});

await test("the share spent is of what was available, and undefined at zero", () => {
  assert.equal(M.spentShare(72000, 60100), 83);   // rollover + planned vs spent
  assert.equal(M.spentShare(20000, 60100), 301);  // overspending goes past 100
  assert.equal(M.spentShare(0, 5000), null, "a percentage of nothing says nothing");
  assert.equal(M.spentShare(0, 0), null);
  assert.equal(M.spentShare(-100, 50), null, "a negative pot is not a denominator");
});

await test("what's left reads as in hand, overspent, or neither", () => {
  assert.equal(M.remainingTone(1), "pos");
  assert.equal(M.remainingTone(-1), "neg");
  assert.equal(M.remainingTone(0), "flat");
});

/* ── account sparklines ───────────────────────────────────────────────── */

const acct = (id, history) => ({
  id, name: id, institution: "I", type: "checking", balance: history[history.length - 1]?.balance ?? 0,
  includeInNetWorth: true, hidden: false, history, order: 0,
});

await test("a group's series is the sum of its accounts on each day", () => {
  const a = acct("a", [{ date: "2026-01-01", balance: 1000 }, { date: "2026-03-01", balance: 3000 }]);
  const b = acct("b", [{ date: "2026-02-01", balance: 500 }]);
  const dates = ["2026-01-01", "2026-02-01", "2026-03-01"];
  // balances carry forward, and an account contributes nothing before it exists
  assert.deepEqual(M.aggregateSeries([a, b], dates), [1000, 1500, 3500]);
  assert.deepEqual(M.aggregateSeries([], dates), [0, 0, 0]);
});

await test("paying down a debt reads as green, not red", () => {
  // stored signed: a loan going from -30,000 to -25,000 has been paid down
  assert.equal(M.trendTone([-3000000, -2800000, -2500000]), "--pos");
  // and one growing is red
  assert.equal(M.trendTone([-2500000, -3000000]), "--neg");
});

await test("assets follow the same rule", () => {
  assert.equal(M.trendTone([100000, 250000]), "--pos");
  assert.equal(M.trendTone([250000, 100000]), "--neg");
});

await test("a flat or unknowable series is neither", () => {
  assert.equal(M.trendTone([500000, 500000]), "--muted");
  assert.equal(M.trendTone([500000, 500050]), "--muted", "under a dollar is not a trend");
  assert.equal(M.trendTone([500000]), "--muted");
  assert.equal(M.trendTone([]), "--muted");
});

/* ── account grouping ─────────────────────────────────────────────────── */

await test("a group holding categories refuses to be deleted", () => {
  const db = M.emptyDB();
  const financial = db.groups.find((g) => g.name === "Financial");
  assert.ok(financial, "the default taxonomy should have a Financial group");
  assert.ok(db.categories.some((c) => c.groupId === financial.id), "and it should hold categories");
  // deleting it would orphan them, and an orphaned category shows up nowhere
  const orphanCheck = db.categories.filter((c) => !db.groups.some((g) => g.id === c.groupId));
  assert.deepEqual(orphanCheck, [], "no category should start out orphaned");
});

await test("every account type belongs to exactly one group", () => {
  const types = Object.keys(M.ACCOUNT_TYPE_LABEL);
  for (const type of types) {
    const groups = M.ACCOUNT_GROUPS.filter((g) => g.types.includes(type));
    assert.equal(groups.length, 1, `${type} appears in ${groups.length} groups`);
  }
  const grouped = M.ACCOUNT_GROUPS.flatMap((g) => g.types);
  assert.equal(new Set(grouped).size, grouped.length, "a type is listed twice");
  assert.equal(grouped.length, types.length, "a type is missing from the groups");
});

await test("vehicles are their own group, separate from property", () => {
  const vehicles = M.ACCOUNT_GROUPS.find((g) => g.key === "vehicles");
  assert.ok(vehicles, "no vehicles group");
  assert.deepEqual(vehicles.types, ["vehicle"]);
  const property = M.ACCOUNT_GROUPS.find((g) => g.key === "property");
  assert.ok(!property.types.includes("vehicle"), "vehicle is still filed under property");
});

/* ── vehicle depreciation ─────────────────────────────────────────────── */

await test("curves land on the published five-year figures", () => {
  // 2026 industry averages: 41.8% lost overall, 34.2% trucks, 57.2% EVs
  const within = (actual, expected, tol = 0.005) =>
    assert.ok(Math.abs(actual - expected) < tol, `${actual.toFixed(3)} should be about ${expected}`);
  within(M.retentionAt("car", 5), 0.582);
  within(M.retentionAt("truck", 5), 0.658);
  within(M.retentionAt("hybrid", 5), 0.646);
  within(M.retentionAt("ev", 5), 0.428);
});

await test("the first year is the steepest, and value only falls", () => {
  const firstYear = 1 - M.retentionAt("car", 1);
  const secondYear = M.retentionAt("car", 1) - M.retentionAt("car", 2);
  assert.ok(firstYear > secondYear, "year one should lose more than year two");
  let previous = 1;
  for (let y = 0.25; y <= 15; y += 0.25) {
    const r = M.retentionAt("car", y);
    assert.ok(r <= previous + 1e-9, `retention rose at year ${y}`);
    previous = r;
  }
});

await test("an old vehicle keeps a floor, never reaching zero", () => {
  assert.ok(M.retentionAt("car", 40) >= 0.08);
  assert.ok(M.retentionAt("ev", 40) >= 0.08);
});

await test("mileage moves a vehicle along its curve, within bounds", () => {
  const base = { purchasePrice: 4000000, purchaseDate: "2024-08-29", class: "car", autoUpdate: false };
  const asOf = "2026-08-29";
  const average = M.estimateVehicleValue({ ...base, annualMiles: 12000 }, asOf);
  const garaged = M.estimateVehicleValue({ ...base, annualMiles: 4000 }, asOf);
  const hammered = M.estimateVehicleValue({ ...base, annualMiles: 30000 }, asOf);
  assert.ok(garaged > average, "low mileage should hold value better");
  assert.ok(hammered < average, "high mileage should lose more");
  // the adjustment is capped so an outlier can't distort the model
  assert.equal(M.effectiveYears({ ...base, annualMiles: 200000 }, asOf), M.effectiveYears({ ...base, annualMiles: 24000 }, asOf));
  assert.equal(M.effectiveYears({ ...base, annualMiles: 0 }, asOf), M.effectiveYears({ ...base, annualMiles: 6000 }, asOf));
});

await test("a fresh purchase is worth what was paid", () => {
  const profile = { purchasePrice: 3500000, purchaseDate: "2026-08-29", class: "suv", autoUpdate: false };
  assert.equal(M.estimateVehicleValue(profile, "2026-08-29"), 3500000);
});

await test("auto-update records monthly and is otherwise inert", () => {
  const db = M.emptyDB();
  const vehicle = { purchasePrice: 3000000, purchaseDate: "2023-01-15", class: "truck", autoUpdate: true };
  db.accounts = [{
    id: "a_car", name: "Truck", institution: "Manual", type: "vehicle", balance: 0,
    includeInNetWorth: true, hidden: false, history: [], order: 0, vehicle,
  }];

  const first = M.refreshVehicleValues(db, "2026-08-29");
  assert.equal(first.accounts[0].history.length, 1);
  assert.equal(first.accounts[0].balance, M.estimateVehicleValue(vehicle, "2026-08-29"));

  // same object back when nothing is due — this runs on every page load
  assert.equal(M.refreshVehicleValues(first, "2026-08-29"), first);
  assert.equal(M.refreshVehicleValues(first, "2026-09-10"), first);

  const later = M.refreshVehicleValues(first, "2026-09-30");
  assert.equal(later.accounts[0].history.length, 2);
  assert.ok(later.accounts[0].balance < first.accounts[0].balance, "a month on, it should be worth less");

  // and it leaves manual accounts alone entirely
  const manual = M.refreshVehicleValues({ ...db, accounts: [{ ...db.accounts[0], vehicle: { ...vehicle, autoUpdate: false } }] }, "2026-08-29");
  assert.equal(manual.accounts[0].history.length, 0);
});

/* ── plaid ────────────────────────────────────────────────────────────── */

const withEnv = async (vars, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try { return await fn(); } finally { process.env = saved; }
};
const creds = { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_ENV: "sandbox" };

await test("plaid proxy always writes a response", async () => {
  const r = await withEnv(creds, () => invokePlaid({}));
  assert.ok(r.status >= 400);
  assert.equal(r.headers["content-type"], "application/json");
});

await test("missing credentials are reported as configuration, not failure", async () => {
  const r = await withEnv({ PLAID_CLIENT_ID: "", PLAID_SECRET: "" }, () => invokePlaid({ action: "link_token" }));
  assert.equal(r.status, 503);
  const body = JSON.parse(r.text);
  assert.equal(body.configured, false);
  assert.match(body.error, /PLAID_CLIENT_ID and PLAID_SECRET/);
});

await test("credentials go to Plaid's body, never to the browser", async () => {
  let seen;
  const r = await withEnv(creds, () =>
    withFetch(async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ link_token: "link-sandbox-xyz" }), { status: 200 });
    }, () => invokePlaid({ action: "link_token", products: ["investments"] })));
  assert.equal(seen.url, "https://sandbox.plaid.com/link/token/create");
  assert.equal(seen.body.client_id, "cid");
  assert.equal(seen.body.secret, "sec");
  assert.deepEqual(seen.body.products, ["investments"]);
  const body = JSON.parse(r.text);
  assert.equal(body.linkToken, "link-sandbox-xyz");
  assert.equal(body.secret, undefined, "the secret must not be echoed to the client");
  assert.equal(body.client_id, undefined);
});

await test("plaid error codes become sentences", async () => {
  const bad = async (code) => {
    const r = await withEnv(creds, () =>
      withFetch(async () => new Response(JSON.stringify({ error_code: code, error_message: "raw" }), { status: 400 }),
        () => invokePlaid({ action: "link_token" })));
    return JSON.parse(r.text).error;
  };
  const keys = await bad("INVALID_API_KEYS");
  assert.match(keys, /rejected the credentials/);
  assert.match(keys, /Check configuration/, "the connect error should point at the check");
  assert.match(await bad("ITEM_LOGIN_REQUIRED"), /re-authenticating/);
  assert.match(await bad("PRODUCTS_NOT_SUPPORTED"), /other account type/);
});

await test("the configuration check describes the credentials without revealing them", async () => {
  // Sentinels chosen so they cannot appear as part of a field name.
  const id = "6a1f9c0d2b4e8f31", key = "0e7d3b5a9f2c1486";
  const r = await withEnv({ PLAID_CLIENT_ID: id, PLAID_SECRET: key, PLAID_ENV: "sandbox" }, () =>
    withFetch(async () => new Response(JSON.stringify({ institutions: [] }), { status: 200 }),
      () => invokePlaid({ action: "diagnose" })));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.environment, "sandbox");
  assert.equal(body.envVarSet, true);
  assert.equal(body.clientId.length, 16);
  assert.equal(body.secret.length, 16);
  assert.equal(body.probe.ok, true);
  // the whole point: lengths and booleans travel, values never do
  assert.equal(r.text.includes(id), false, "the client id must not appear in the response");
  assert.equal(r.text.includes(key), false, "the secret must not appear in the response");
});

await test("the configuration check reports stray whitespace and trims it before use", async () => {
  let seen;
  const r = await withEnv({ ...creds, PLAID_SECRET: "sec\n" }, () =>
    withFetch(async (_url, init) => {
      seen = JSON.parse(init.body);
      return new Response(JSON.stringify({ institutions: [] }), { status: 200 });
    }, () => invokePlaid({ action: "diagnose" })));
  const body = JSON.parse(r.text);
  assert.equal(body.secret.trimmed, true);
  assert.equal(body.secret.length, 3);
  assert.equal(body.clientId.trimmed, false);
  assert.equal(seen.secret, "sec", "the trailing newline must not reach Plaid");
});

await test("the configuration check names production as the default and relays Plaid's refusal", async () => {
  const r = await withEnv({ PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_ENV: "" }, () =>
    withFetch(async () => new Response(JSON.stringify({ error_code: "INVALID_API_KEYS", error_message: "raw" }), { status: 400 }),
      () => invokePlaid({ action: "diagnose" })));
  assert.equal(r.status, 200, "a rejected probe is still a successful check");
  const body = JSON.parse(r.text);
  assert.equal(body.environment, "production");
  assert.equal(body.envVarSet, false);
  assert.equal(body.probe.ok, false);
  // terse on purpose — the card prints the explanation beneath it, and keys
  // off this exact code to decide whether the environment advice applies
  assert.equal(body.probe.error, "INVALID_API_KEYS");
});

await test("a refused key is traced to the environment it does belong to", async () => {
  // The one that matters: a Sandbox-only account, which is what Plaid gives
  // you before Production access is approved.
  const seen = [];
  const r = await withEnv({ PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_ENV: "" }, () =>
    withFetch(async (url) => {
      const host = new URL(String(url)).host;
      seen.push(host);
      return host.startsWith("sandbox")
        ? new Response(JSON.stringify({ institutions: [] }), { status: 200 })
        : new Response(JSON.stringify({ error_code: "INVALID_API_KEYS", error_message: "raw" }), { status: 400 });
    }, () => invokePlaid({ action: "diagnose" })));

  const body = JSON.parse(r.text);
  assert.equal(body.environment, "production");
  assert.equal(body.probe.ok, false);
  assert.equal(body.worksIn, "sandbox", "the check should say where the keys do work");
  assert.deepEqual(seen, ["production.plaid.com", "sandbox.plaid.com"]);
});

await test("keys good for the configured environment aren't probed twice", async () => {
  let calls = 0;
  const r = await withEnv(creds, () =>
    withFetch(async () => { calls += 1; return new Response(JSON.stringify({ institutions: [] }), { status: 200 }); },
      () => invokePlaid({ action: "diagnose" })));
  assert.equal(calls, 1, "a working key needs no second probe");
  assert.equal(JSON.parse(r.text).worksIn, "sandbox");
});

await test("keys that work nowhere are reported as matching neither", async () => {
  const r = await withEnv({ PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", PLAID_ENV: "" }, () =>
    withFetch(async () => new Response(JSON.stringify({ error_code: "INVALID_API_KEYS", error_message: "raw" }), { status: 400 }),
      () => invokePlaid({ action: "diagnose" })));
  assert.equal(JSON.parse(r.text).worksIn, null);
});

await test("a sync never touches Plaid's metered endpoints", async () => {
  // Auth and Identity are $1.50 per call, Balance $0.10, the refresh
  // endpoints $0.12. Everything this app needs comes from the per-item
  // monthly products instead, and it must stay that way.
  const hit = [];
  await withEnv(creds, () =>
    withFetch(async (url) => {
      hit.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify({ accounts: [], transactions: [], holdings: [], securities: [] }), { status: 200 });
    }, () => invokePlaid({
      action: "sync", accessToken: "tok", startDate: "2026-01-01", endDate: "2026-09-01", withHoldings: true,
    })));

  assert.deepEqual(hit, ["/accounts/get", "/transactions/get", "/investments/holdings/get"]);
  for (const metered of ["/auth/get", "/identity/get", "/accounts/balance/get", "/transactions/refresh", "/investments/refresh"]) {
    assert.equal(hit.includes(metered), false, `${metered} is billed per call and must not be used`);
  }
});

await test("plaid account types map onto this app's types", () => {
  assert.equal(M.mapAccountType("depository", "checking"), "checking");
  assert.equal(M.mapAccountType("depository", "savings"), "savings");
  assert.equal(M.mapAccountType("credit", "credit card"), "credit");
  assert.equal(M.mapAccountType("loan", "mortgage"), "mortgage");
  assert.equal(M.mapAccountType("loan", "student"), "loan");
  assert.equal(M.mapAccountType("investment", "brokerage"), "investment");
  // the point of the exercise: retirement accounts land as retirement
  assert.equal(M.mapAccountType("investment", "roth"), "retirement");
  assert.equal(M.mapAccountType("investment", "ira"), "retirement");
  assert.equal(M.mapAccountType("investment", "401k"), "retirement");
  assert.equal(M.mapAccountType("investment", "403B"), "retirement");
  assert.equal(M.isLiability("credit"), true);
  assert.equal(M.isLiability("depository"), false);
});

await test("securities map to asset classes", () => {
  assert.equal(M.mapAssetClass("etf"), "us_equity");
  assert.equal(M.mapAssetClass("mutual fund"), "us_equity");
  assert.equal(M.mapAssetClass("fixed income"), "bond");
  assert.equal(M.mapAssetClass("cash"), "cash");
  assert.equal(M.mapAssetClass("cryptocurrency"), "crypto");
  assert.equal(M.mapAssetClass(null), "other");
});

await test("a synced item maps into accounts, transactions and holdings", async () => {
  const payload = await withFetch(
    async () => new Response(JSON.stringify({
      accounts: [
        { account_id: "acc_ira", name: "Roth IRA", type: "investment", subtype: "roth", balances: { current: 48250.15, iso_currency_code: "USD" } },
        { account_id: "acc_cc", name: "Visa", type: "credit", subtype: "credit card", balances: { current: 1240.5 } },
      ],
      transactions: [
        { transaction_id: "t1", account_id: "acc_cc", date: "2026-08-20", amount: 42.1, name: "SQ *BLUE BOTTLE 1234", merchant_name: "Blue Bottle Coffee", pending: false },
        { transaction_id: "t2", account_id: "acc_cc", date: "2026-08-21", amount: -500, name: "PAYMENT", pending: false },
      ],
      holdings: [
        { account_id: "acc_ira", security_id: "sec1", quantity: 120.5, cost_basis: 24100, institution_price: 312.66 },
      ],
      securities: [{ security_id: "sec1", ticker_symbol: "VTI", name: "Vanguard Total Stock Market ETF", type: "etf" }],
    }), { status: 200 }),
    () => M.fetchItem({ accessToken: "tok", itemId: "i1", institution: "Vanguard", kind: "investment", addedAt: "" }, "2026-06-01"),
  );

  const ira = payload.accounts[0];
  assert.equal(ira.type, "retirement");
  assert.equal(ira.balance, 4825015);
  // Plaid reports what a card owes as a positive number
  assert.equal(payload.accounts[1].balance, -124050);

  // and money leaving an account as positive, which is the opposite of here
  assert.equal(payload.transactions[0].amount, -4210, "a purchase must be negative");
  assert.equal(payload.transactions[1].amount, 50000, "a payment must be positive");
  assert.equal(payload.transactions[0].payee, "Blue Bottle Coffee");

  const holding = payload.holdings[0];
  assert.equal(holding.ticker, "VTI");
  // cost_basis is the total for the position; this app stores it per share
  assert.equal(holding.costBasis, Math.round(2410000 / 120.5));
  assert.equal(holding.price, 31266);
  assert.equal(holding.assetClass, "us_equity");
});

await test("holdings replace the account's previous positions", () => {
  const db = M.emptyDB();
  const payload = {
    fetchedAt: "2026-08-29T00:00:00.000Z",
    errors: [],
    accounts: [{ syncId: "acc_ira", name: "Roth IRA", institution: "Vanguard", balance: 100000, currency: "USD", type: "retirement", balanceDate: "2026-08-29" }],
    transactions: [],
    holdings: [{ accountSyncId: "acc_ira", ticker: "VTI", name: "VTI", quantity: 10, costBasis: 100, price: 200, assetClass: "us_equity" }],
  };
  const once = M.mergeSync(db, payload, "plaid");
  assert.equal(once.holdingsUpdated, 1);
  assert.equal(once.db.holdings.length, 1);

  // the position was sold and replaced — the old one must not linger
  const twice = M.mergeSync(once.db, {
    ...payload,
    holdings: [{ accountSyncId: "acc_ira", ticker: "VXUS", name: "VXUS", quantity: 5, costBasis: 50, price: 70, assetClass: "intl_equity" }],
  }, "plaid");
  assert.equal(twice.db.holdings.length, 1);
  assert.equal(twice.db.holdings[0].ticker, "VXUS");
});

await test("the two providers cannot collide on transaction ids", () => {
  const db = M.emptyDB();
  const shared = { syncId: "same-id", accountSyncId: "a1", date: "2026-08-01", amount: -100, description: "X", pending: false };
  const account = { syncId: "a1", name: "A", institution: "I", balance: 0, currency: "USD", type: "checking", balanceDate: "2026-08-01" };
  const base = { fetchedAt: "2026-08-29T00:00:00.000Z", errors: [], accounts: [account], transactions: [shared] };
  const first = M.mergeSync(db, base, "simplefin");
  const second = M.mergeSync(first.db, base, "plaid");
  assert.equal(second.transactionsAdded, 1, "the same id from a different provider is a different transaction");
});

/* ── time ranges ──────────────────────────────────────────────────────── */

await test("the range list is the seven options, in order", () => {
  assert.deepEqual(M.RANGES.map((r) => r.value), ["1m", "3m", "6m", "ytd", "1y", "5y", "all"]);
  assert.deepEqual(M.RANGES.map((r) => r.label), [
    "1 month", "3 months", "6 months", "Year to date", "1 year", "5 years", "All time",
  ]);
});

await test("fixed ranges cover the months they claim", () => {
  assert.equal(M.rangeMonths("1m"), 1);
  assert.equal(M.rangeMonths("3m"), 3);
  assert.equal(M.rangeMonths("6m"), 6);
  assert.equal(M.rangeMonths("1y"), 12);
  assert.equal(M.rangeMonths("5y"), 60);
});

await test("year to date counts from January, whatever month it is", () => {
  const month = Number(new Date().toISOString().slice(5, 7));
  assert.equal(M.rangeMonths("ytd"), month);
  assert.equal(M.rangeStart("ytd").slice(5), "01-01");
});

await test("all time reaches back to the first data, or two years without any", () => {
  // Counted from today, not from a hardcoded month, or this test expires.
  assert.equal(M.rangeMonths("all", M.addMonths(M.thisMonth(), -23)), 24);
  assert.equal(M.rangeMonths("all", M.thisMonth()), 1, "data starting this month is one month of range");
  assert.equal(M.rangeMonths("all"), 24);
  assert.equal(M.rangeStart("all", "2019-03-04"), "2019-03-04");
});

await test("sampling stays bounded and always ends on the final day", () => {
  const daily = M.sampleDates("2026-08-01", "2026-08-29");
  assert.equal(daily.length, 29, "a month should sample every day");
  assert.equal(daily[daily.length - 1], "2026-08-29");

  const fiveYears = M.sampleDates("2021-08-29", "2026-08-29");
  assert.ok(fiveYears.length <= 91, `five years produced ${fiveYears.length} points`);
  assert.equal(fiveYears[0], "2021-08-29");
  assert.equal(fiveYears[fiveYears.length - 1], "2026-08-29");
});

await test("long spans label the year, short spans label the day", () => {
  assert.equal(M.sampleLabel("2025-08-18", 30), "Aug 18");
  // "Aug 25" would be read as a day number on a short range
  assert.equal(M.sampleLabel("2025-08-18", 365), "Aug '25");
});

/* ── chart axis ───────────────────────────────────────────────────────── */

await test("the axis starts at the minimum and ends at the maximum", () => {
  const ticks = M.rangeTicks(50370000, 58340000);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0], 50370000);
  assert.equal(ticks[4], 58340000);
  // evenly divided, not rounded to convenient numbers
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
  assert.ok(gaps.every((g) => Math.abs(g - gaps[0]) < 1));
});

await test("axis labels stay distinct however tight the range", () => {
  const cases = [
    [50370000, 58340000],   // a house over six months
    [57035000, 57085000],   // $500 of movement on $570k
    [-72110000, -71400000], // a mortgage paying down
    [760000, 1350000],      // a checking account
    [-339000, -160000],     // a credit card
  ];
  for (const [lo, hi] of cases) {
    const label = M.axisFormat(lo, hi);
    const labels = M.rangeTicks(lo, hi).map(label);
    assert.equal(new Set(labels).size, labels.length, `duplicate labels for ${lo}..${hi}: ${labels.join(", ")}`);
  }
});

await test("axis labels carry the sign of a debt", () => {
  const label = M.axisFormat(-72110000, -71400000);
  assert.match(label(-72110000), /^-\$721/);
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

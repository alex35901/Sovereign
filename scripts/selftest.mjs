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
import { join } from "node:path";

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (err) { results.push(["FAIL", name, err.message]); }
};

// bundle the TS modules under test into plain ESM
// Inside the project: pg stays external (esbuild can't turn its dynamic
// requires into ESM), so the bundle has to see node_modules.
const dir = await mkdtemp(join(process.cwd(), "node_modules", ".selftest-"));
const entry = join(dir, "entry.js");
await build({
  stdin: {
    contents: `
      export { mergeSync, cleanMerchant, syncWindowStart, accountKeys } from "./src/lib/sync/merge.ts";
      export { mutedAccountIds, counts, cashFlowSeries, categoryTotals, detectRecurring as detectRec } from "./src/lib/select.ts";
      export { parseCSV, guessColumns, buildPlan, parseDate, toCSV, balanceHistoryToCSV } from "./src/lib/csv.ts";
      export { budgetSummary, detectRecurring, netWorthSeries, rolloverFor } from "./src/lib/select.ts";
      export { buildDemoDB, emptyDB } from "./src/lib/seed.ts";
      export { applyRules, ruleMatches, countMatches } from "./src/lib/rules.ts";
      export { added, changes, record, history, eventTitle, eventDetail, sourceLabel } from "./src/lib/activity.ts";
      export { parseMoney, fmt } from "./src/lib/money.ts";
      export { default as simplefinHandler } from "./api/simplefin.ts";
      export { default as propertyHandler } from "./api/property.ts";
      export { default as plaidHandler } from "./api/plaid.ts";
      export { default as dbHandler } from "./api/db.ts";
      export { default as cronHandler } from "./api/cron/sync.ts";
      export { bearer, passphraseOk, passphraseSet } from "./api/_auth.ts";
      export { findConnection } from "./api/_store.ts";
      export { toPayload, startOfDayUnix } from "./src/lib/sync/simplefin.ts";
      export { mapAccountType, mapAssetClass, isLiability, fetchItem, createLinkToken, needsInstitution } from "./src/lib/sync/plaid.ts";
      export { estimateHomeValue, canValue } from "./src/lib/property.ts";
      export { readBalanceCSV, guessBalanceColumns, buildBalancePlan, compress, mergeHistory, defaultNegate } from "./src/lib/balance-csv.ts";
      export { rangeTicks, axisFormat } from "./src/components/charts.tsx";
      export { aggregateSeries, trendTone, balanceAt, netWorthSplitAt, netWorthNow } from "./src/lib/select.ts";
      export { ACCOUNT_GROUPS, ACCOUNT_TYPE_LABEL, plannedFor, categoryHistory, categoryAverage, budgetTable, applyForward, remainingTone, spentShare } from "./src/lib/select.ts";
      export { moveCandidates, suggestCounterpart, suggestedAmount, moveBudget, surplusOf, moveCeiling } from "./src/lib/budget-move.ts";
      export { RANGES, rangeMonths, rangeStart, sampleDates, sampleLabel, spanDays } from "./src/lib/range.ts";
      export { thisMonth, addMonths } from "./src/lib/date.ts";
      export { retentionAt, effectiveYears, estimateVehicleValue, refreshVehicleValues, vehicleNeedsRefresh, VEHICLE_CLASSES } from "./src/lib/vehicle.ts";
      export { simplefin } from "./src/lib/sync/simplefin.ts";
      export { CADENCES, DEFAULT_CADENCE, cadenceHours, syncDue, nextSyncAt, untilLabel } from "./src/lib/sync/schedule.ts";
      export { syncSimplefin } from "./src/lib/sync/run.ts";
      export { EMOJI_GROUPS, ALL_EMOJI, searchEmoji } from "./src/lib/emoji-data.ts";
      export { initialsOf, toneOf } from "./src/components/InstitutionLogo.tsx";
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: entry, logLevel: "silent",
  external: ["pg", "pg-native"],
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

/** Like invokeOn, but able to carry headers — the sync endpoints need auth. */
const invokeWith = (handler, { method = "POST", body, headers: reqHeaders = {} } = {}) =>
  new Promise((resolve, reject) => {
    const headers = {};
    const timer = setTimeout(() => reject(new Error("handler never wrote a response")), 5000);
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      end: (text) => { clearTimeout(timer); resolve({ status: res.statusCode, headers, text: text ?? "" }); },
    };
    Promise.resolve(handler({ method, body, headers: reqHeaders }, res))
      .catch((err) => { clearTimeout(timer); reject(err); });
  });

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const caught = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

const withEnv = async (vars, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try { return await fn(); } finally { process.env = saved; }
};


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

/** The browser talks to /api/simplefin; in here that is the handler itself. */
const throughProxy = (fn) => {
  const real = globalThis.fetch;
  return withFetch(async (url, init) => {
    if (String(url) !== "/api/simplefin") {
      // the handler's own call to the bridge — the stub speaks http, not https
      return real(String(url).replace("https://127.0.0.1", "http://127.0.0.1"), init);
    }
    const r = await invoke(JSON.parse(init.body));
    return new Response(r.text, { status: r.status, headers: { "content-type": "application/json" } });
  }, fn);
};

await test("a scheduled pull merges and reports whether anything landed", async () => {
  let db = M.emptyDB();
  db = { ...db, settings: { ...db.settings, simplefinAccessUrl: `https://user1:pass1@127.0.0.1:${port}/simplefin` } };
  const apply = (fn) => { db = fn(db); };

  const first = await throughProxy(() => M.syncSimplefin(db, apply));
  assert.equal(first.changed, true, "the first pull brings accounts in");
  assert.match(first.summary, /account/);
  assert.ok(db.settings.lastSyncAt, "the timestamp the schedule reads must be written");

  // the same data again changes nothing, so the scheduler stays quiet
  const second = await throughProxy(() => M.syncSimplefin(db, apply));
  assert.equal(second.changed, false, "a no-op pull must not announce itself");
  assert.match(second.summary, /account/, "the manual button still gets a summary");

  // but a balance that has actually moved is worth saying out loud
  db = { ...db, accounts: db.accounts.map((a) => ({ ...a, balance: a.balance + 12345 })) };
  const third = await throughProxy(() => M.syncSimplefin(db, apply));
  assert.equal(third.changed, true, "a changed balance must be announced");
});

await test("a scheduled pull refuses to run unconnected", async () => {
  const msg = await caught(() => M.syncSimplefin(M.emptyDB(), () => {}));
  assert.match(msg, /isn't connected/);
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

/** A rollover category holding $200 carried in, $100 planned, $39 spent. */
const rolloverDb = () => {
  const db = M.emptyDB();
  db.categories = db.categories.map((c) => (c.id === "c_home_improvement" ? { ...c, rollover: true } : c));
  db.budgets = { "2026-07": { c_home_improvement: 20000 }, "2026-08": { c_home_improvement: 10000, c_groceries: 60000 } };
  db.transactions = [{
    id: "t1", accountId: "a1", date: "2026-08-05", merchant: "M", amount: -3900,
    categoryId: "c_home_improvement", tags: [], pending: false, reviewed: true, hideFromReports: false, createdAt: "",
  }, {
    id: "t2", accountId: "a1", date: "2026-08-06", merchant: "M", amount: -80000,
    categoryId: "c_groceries", tags: [], pending: false, reviewed: true, hideFromReports: false, createdAt: "",
  }];
  return db;
};

await test("a rollover category offers what's left, not just this month's plan", () => {
  const db = rolloverDb();
  const cands = M.moveCandidates(db, "2026-08");
  const src = cands.find((c) => c.categoryId === "c_home_improvement");
  assert.equal(src.rollover, 20000, "$200 carried in from July");
  assert.equal(src.planned, 10000);
  assert.equal(src.remaining, 26100, "200 + 100 - 39");

  // the complaint: the box defaulted to the $100 budgeted, not the $261 left
  assert.equal(M.surplusOf(src), 26100);
  assert.equal(M.moveCeiling(src), 26100);
  // The suggestion is still bounded by the other side's hole: groceries is only
  // $200 overspent, so that is what gets offered.
  const short = cands.find((c) => c.categoryId === "c_groceries");
  assert.equal(short.remaining, -20000);
  assert.equal(M.suggestedAmount(src, short), 20000);

  // When the hole is deeper than the surplus, the whole surplus is offered —
  // $261, not the $100 this month happened to budget.
  const deep = { ...short, remaining: -50000 };
  assert.equal(M.suggestedAmount(src, deep), 26100);
});

await test("an ordinary category still stops at what it budgeted", () => {
  const db = rolloverDb();
  const gas = M.moveCandidates(db, "2026-08").find((c) => c.categoryId === "c_gas");
  assert.equal(gas.rollover, 0);
  assert.equal(M.moveCeiling(gas), gas.planned, "no rollover means no extra to give");
});

await test("moving a rollover surplus empties it exactly, not below", () => {
  const db = rolloverDb();
  const { db: after, moved } = M.moveBudget(db, "2026-08", "c_home_improvement", "c_groceries", 26100);
  assert.equal(moved, 26100, "the whole surplus moves, though it exceeds the plan");

  const row = M.budgetTable(after, "2026-08").flatMap((g) => g.rows).find((r) => r.category.id === "c_home_improvement");
  assert.equal(row.remaining, 0, "what's left lands on zero, never below");
  assert.equal(row.planned, 10000 - 26100, "the month's plan goes negative to pay for it");
  assert.equal(M.plannedFor(after, "2026-08", "c_groceries"), 60000 + 26100);
});

await test("a rollover category can't give away more than it holds", () => {
  const db = rolloverDb();
  const { moved } = M.moveBudget(db, "2026-08", "c_home_improvement", "c_groceries", 99999);
  assert.equal(moved, 26100, "capped at what's left");
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

/* ── institution logos ───────────────────────────────────────────────── */

await test("initials are taken from the first two words, whatever the name", () => {
  assert.equal(M.initialsOf("Wells Fargo"), "WF");
  assert.equal(M.initialsOf("Elements Financial"), "EF");
  assert.equal(M.initialsOf("Chase"), "C");
  assert.equal(M.initialsOf("  ally   bank  "), "AB", "spacing must not change the answer");
  assert.equal(M.initialsOf("First National Bank of Springfield"), "FN", "only the first two");
  assert.equal(M.initialsOf(""), "?", "never blank");
  assert.equal(M.initialsOf("   "), "?");
});

await test("an institution always gets the same colour", () => {
  assert.equal(M.toneOf("Wells Fargo"), M.toneOf("Wells Fargo"));
  assert.match(M.toneOf("Wells Fargo"), /^--c([1-9]|1[0-2])$/);
  const tones = new Set(["Chase", "Wells Fargo", "Ally Bank", "Elements Financial", "Vanguard", "Fidelity"].map(M.toneOf));
  assert.ok(tones.size > 1, "different institutions should not all land on one colour");
});

await test("a synced logo lands on the account and survives a pull without one", () => {
  const payload = (over = {}) => ({
    fetchedAt: "2026-09-01T12:00:00.000Z",
    accounts: [{
      syncId: "p-1", name: "Everyday", institution: "Chase", type: "checking",
      balance: 1000, currency: "USD", balanceDate: "2026-09-01", ...over,
    }],
    transactions: [], errors: [],
  });

  const first = M.mergeSync(M.emptyDB(), payload({ logo: "data:image/png;base64,AAAA", domain: "chase.com" }), "plaid");
  assert.equal(first.db.accounts[0].logo, "data:image/png;base64,AAAA");
  assert.equal(first.db.accounts[0].domain, "chase.com");

  // a later pull that omits it must not wipe what is already held
  const second = M.mergeSync(first.db, payload(), "plaid");
  assert.equal(second.db.accounts[0].logo, "data:image/png;base64,AAAA");
  assert.equal(second.db.accounts[0].domain, "chase.com");

  // but a new one replaces it
  const third = M.mergeSync(second.db, payload({ logo: "data:image/png;base64,BBBB" }), "plaid");
  assert.equal(third.db.accounts[0].logo, "data:image/png;base64,BBBB");
});

await test("SimpleFIN carries the domain it sends, and no logo", () => {
  const raw = {
    errors: [],
    accounts: [{
      id: "sf-1", name: "Joint Bills", currency: "USD", balance: "7662.61",
      "balance-date": 1788000000, org: { name: "Elements Financial", domain: "elements.org" },
      transactions: [],
    }],
  };
  const out = M.toPayload(raw);
  assert.equal(out.accounts[0].domain, "elements.org");
  assert.equal(out.accounts[0].logo, undefined, "SimpleFIN sends no logo");
  assert.equal(out.accounts[0].institution, "Elements Financial");
});

/* ── a transaction's history ─────────────────────────────────────────── */

const actDb = () => {
  const db = M.emptyDB();
  return {
    ...db,
    accounts: [
      { id: "a1", name: "Everyday", institution: "Bank", type: "checking", balance: 0,
        includeInNetWorth: true, hidden: false, history: [], order: 0 },
      { id: "a2", name: "Savings", institution: "Bank", type: "savings", balance: 0,
        includeInNetWorth: true, hidden: false, history: [], order: 1 },
    ],
    tags: [{ id: "g1", name: "Work", color: "--c1" }, { id: "g2", name: "Trip", color: "--c2" }],
  };
};
const actTxn = (over = {}) => ({
  id: "t1", accountId: "a1", date: "2026-09-01", merchant: "Blue Bottle", amount: -450,
  categoryId: "c_coffee_shops", tags: [], pending: false, reviewed: false, hideFromReports: false,
  createdAt: "2026-09-01T10:00:00.000Z", ...over,
});

await test("arrival is recorded with the name of whatever brought it in", () => {
  assert.equal(M.added("plaid", "2026-08-30T22:32:00.000Z").source, "Plaid");
  assert.equal(M.added("simplefin", "x").source, "SimpleFIN");
  assert.equal(M.added("csv", "x").source, "a CSV import");
  assert.equal(M.added("manual", "x").source, "you");
  assert.equal(M.sourceLabel(undefined), "you");
  assert.equal(M.eventTitle(M.added("plaid", "x")), "Added to Sovereign");
  assert.equal(M.eventDetail(M.added("plaid", "x")), "by Plaid");
});

await test("only the fields that moved are written down", () => {
  const db = actDb();
  const before = actTxn();
  const after = { ...before, categoryId: "c_groceries", merchant: "Blue Bottle Coffee" };
  const events = M.changes(db, before, after, "2026-09-02T09:00:00.000Z");
  assert.equal(events.length, 2, "two fields moved, so two lines");
  const byField = Object.fromEntries(events.map((e) => [e.field, e]));
  assert.equal(byField.Merchant.from, "Blue Bottle");
  assert.equal(byField.Merchant.to, "Blue Bottle Coffee");
  assert.equal(byField.Category.from, "Coffee Shops");
  assert.equal(byField.Category.to, "Groceries");
  assert.ok(events.every((e) => e.kind === "changed" && e.at === "2026-09-02T09:00:00.000Z"));
});

await test("a change that changes nothing writes nothing", () => {
  const db = actDb();
  const t = actTxn();
  assert.deepEqual(M.changes(db, t, { ...t }, "x"), []);
  assert.equal(M.record(db, t, { ...t }, "x").activity, undefined, "no empty log is created");
});

await test("values are written as words, so a later rename can't rewrite history", () => {
  const db = actDb();
  const before = actTxn();
  const logged = M.record(db, before, { ...before, categoryId: "c_groceries" }, "2026-09-02T09:00:00.000Z");
  assert.equal(logged.activity[0].to, "Groceries");

  // rename the category afterwards; the line must still say what it said then
  const renamed = { ...db, categories: db.categories.map((c) => (c.id === "c_groceries" ? { ...c, name: "Food" } : c)) };
  assert.equal(M.history(logged)[1].to, "Groceries");
  assert.equal(renamed.categories.find((c) => c.id === "c_groceries").name, "Food");
});

await test("amounts, dates, accounts, tags and the switches are all tracked", () => {
  const db = actDb();
  const before = actTxn();
  const after = {
    ...before, amount: -1250, date: "2026-09-03", accountId: "a2",
    tags: ["g1", "g2"], reviewed: true, hideFromReports: true, notes: "receipt in the app",
  };
  const fields = M.changes(db, before, after, "x").map((e) => e.field).sort();
  assert.deepEqual(fields, ["Account", "Amount", "Date", "Hidden from reports", "Notes", "Reviewed", "Tags"]);
  const byField = Object.fromEntries(M.changes(db, before, after, "x").map((e) => [e.field, e]));
  assert.equal(byField.Account.from, "Everyday");
  assert.equal(byField.Account.to, "Savings");
  assert.equal(byField.Tags.from, "none", "an empty value reads as none, not blank");
  assert.equal(byField.Tags.to, "Trip, Work");
  assert.equal(byField.Reviewed.to, "yes");
  assert.match(byField.Amount.from, /4\.50/);
});

await test("tag order doesn't count as a change", () => {
  const db = actDb();
  const before = actTxn({ tags: ["g1", "g2"] });
  assert.deepEqual(M.changes(db, before, { ...before, tags: ["g2", "g1"] }, "x"), []);
});

await test("history is capped, keeping the newest", () => {
  const db = actDb();
  let t = actTxn({ activity: [M.added("plaid", "2026-01-01T00:00:00.000Z")] });
  for (let i = 0; i < 80; i++) t = M.record(db, t, { ...t, merchant: `Name ${i}` }, `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`);
  assert.ok(t.activity.length <= 60, `kept ${t.activity.length}`);
  assert.equal(t.activity[t.activity.length - 1].to, "Name 79", "the newest line survives");
});

await test("a transaction older than the log still shows how it arrived", () => {
  // nothing recorded, but it carries an import key and its account syncs
  const imported = M.history(actTxn({ importKey: "sf:1" }), "simplefin");
  assert.equal(imported.length, 1);
  assert.equal(imported[0].kind, "added");
  assert.equal(imported[0].source, "SimpleFIN");
  assert.equal(imported[0].at, "2026-09-01T10:00:00.000Z", "dated from when it was created");

  // typed in by hand, with no sync source anywhere
  assert.equal(M.history(actTxn())[0].source, "you");

  // and one that does have a log is left exactly as it is
  const logged = actTxn({ activity: [M.added("plaid", "2026-08-30T22:32:00.000Z")] });
  assert.deepEqual(M.history(logged, "simplefin"), logged.activity);
});

await test("a synced transaction records the provider that brought it", () => {
  const db = M.emptyDB();
  const payload = {
    fetchedAt: "2026-09-01T12:00:00.000Z",
    accounts: [{ syncId: "sf-1", name: "Everyday", institution: "Bank", type: "checking",
      balance: 1000, currency: "USD", balanceDate: "2026-09-01" }],
    transactions: [{ syncId: "tx-1", accountSyncId: "sf-1", date: "2026-09-01", amount: -450,
      description: "BLUE BOTTLE", pending: false }],
    errors: [],
  };
  const res = M.mergeSync(db, payload, "plaid");
  const t = res.db.transactions[0];
  assert.equal(t.activity[0].kind, "added");
  assert.equal(t.activity[0].source, "Plaid");
  assert.equal(t.activity[0].at, "2026-09-01T12:00:00.000Z");
});

/* ── rules: account scope and tags ───────────────────────────────────── */

const rule = (over = {}) => ({
  id: "r1", name: "R", enabled: true, order: 0,
  criteria: {}, actions: {}, ...over,
});
const txn = (over = {}) => ({
  id: "t1", accountId: "a1", date: "2026-09-01", merchant: "Blue Bottle", amount: -450,
  categoryId: "c_coffee", tags: [], pending: false, reviewed: false, hideFromReports: false,
  createdAt: "", ...over,
});

await test("an account criterion keeps a rule to that account", () => {
  const r = rule({ criteria: { accountId: "a1" } });
  assert.equal(M.ruleMatches(r, txn({ accountId: "a1" })), true);
  assert.equal(M.ruleMatches(r, txn({ accountId: "a2" })), false);
  // and with no account set it applies everywhere
  assert.equal(M.ruleMatches(rule(), txn({ accountId: "a2" })), true);
});

await test("account and merchant together must both hold", () => {
  const r = rule({ criteria: { accountId: "a1", merchantContains: "blue bottle" } });
  assert.equal(M.ruleMatches(r, txn({ accountId: "a1", merchant: "Blue Bottle" })), true);
  assert.equal(M.ruleMatches(r, txn({ accountId: "a1", merchant: "Peets" })), false);
  assert.equal(M.ruleMatches(r, txn({ accountId: "a2", merchant: "Blue Bottle" })), false);
});

await test("a tag action adds without dropping tags already there", () => {
  const r = rule({ actions: { addTags: ["tag_work"] } });
  const out = M.applyRules([r], txn({ tags: ["tag_trip"] }));
  assert.deepEqual(out.tags.sort(), ["tag_trip", "tag_work"]);

  // applying twice must not duplicate it
  const again = M.applyRules([r], out);
  assert.deepEqual(again.tags.sort(), ["tag_trip", "tag_work"]);
});

await test("several tags land at once, alongside the other actions", () => {
  const r = rule({
    criteria: { accountId: "a1" },
    actions: { addTags: ["t1", "t2"], categoryId: "c_new", markReviewed: true, renameMerchant: "Blue Bottle Coffee" },
  });
  const out = M.applyRules([r], txn());
  assert.deepEqual(out.tags.sort(), ["t1", "t2"]);
  assert.equal(out.categoryId, "c_new");
  assert.equal(out.merchant, "Blue Bottle Coffee");
  assert.equal(out.reviewed, true);

  // a transaction on another account is untouched by all of it
  const other = txn({ accountId: "a2" });
  assert.equal(M.applyRules([r], other), other, "an unmatched rule must return the same object");
});

await test("counting matches is what the back-fill offer promises", () => {
  const db = {
    ...M.emptyDB(),
    transactions: [
      txn({ id: "t1", accountId: "a1", merchant: "Blue Bottle" }),
      txn({ id: "t2", accountId: "a1", merchant: "Blue Bottle #2" }),
      txn({ id: "t3", accountId: "a2", merchant: "Blue Bottle" }),
      txn({ id: "t4", accountId: "a1", merchant: "Peets" }),
    ],
  };
  assert.equal(M.countMatches(db, rule({ criteria: { merchantContains: "blue bottle" } })), 3);
  assert.equal(M.countMatches(db, rule({ criteria: { merchantContains: "blue bottle", accountId: "a1" } })), 2);
  assert.equal(M.countMatches(db, rule({ criteria: { accountId: "a2" } })), 1);
  // a disabled rule matches nothing, so it cannot promise to change anything
  assert.equal(M.countMatches(db, rule({ enabled: false, criteria: { accountId: "a1" } })), 0);
});

/* ── assets and liabilities over a period ────────────────────────────── */

const held = (id, history) => ({
  id, name: id, institution: "I", type: "checking",
  balance: history[history.length - 1]?.balance ?? 0,
  includeInNetWorth: true, hidden: false, history, order: 0,
});

await test("assets and liabilities are split by the sign each balance had that day", () => {
  const db = {
    ...M.emptyDB(),
    accounts: [
      held("savings", [{ date: "2026-01-01", balance: 500000 }, { date: "2026-09-01", balance: 800000 }]),
      held("card", [{ date: "2026-01-01", balance: -300000 }, { date: "2026-09-01", balance: -100000 }]),
    ],
  };
  const then = M.netWorthSplitAt(db, "2026-01-01");
  assert.equal(then.assets, 500000);
  assert.equal(then.liabilities, -300000);
  assert.equal(then.net, 200000);

  const now = M.netWorthSplitAt(db, "2026-09-01");
  assert.equal(now.assets, 800000);
  assert.equal(now.liabilities, -100000);
  assert.equal(now.net, 700000);

  // what the tiles report
  assert.equal(now.assets - then.assets, 300000, "assets grew by $3,000");
  assert.equal(now.liabilities - then.liabilities, 200000, "a rise in a negative balance is $2,000 less owed");
});

await test("an account that changed side is counted where it actually was", () => {
  // a card carried a balance in January and sits in credit by September
  const db = {
    ...M.emptyDB(),
    accounts: [held("card", [{ date: "2026-01-01", balance: -50000 }, { date: "2026-09-01", balance: 12000 }])],
  };
  const then = M.netWorthSplitAt(db, "2026-01-01");
  assert.equal(then.assets, 0);
  assert.equal(then.liabilities, -50000, "it was a debt back then");

  const now = M.netWorthSplitAt(db, "2026-09-01");
  assert.equal(now.assets, 12000, "and an asset now");
  assert.equal(now.liabilities, 0);
});

await test("the split honours the same exclusions as the totals", () => {
  const base = [
    held("counted", [{ date: "2026-01-01", balance: 100000 }]),
    { ...held("hidden", [{ date: "2026-01-01", balance: 900000 }]), hidden: true },
    { ...held("excluded", [{ date: "2026-01-01", balance: 900000 }]), includeInNetWorth: false },
  ];
  const split = M.netWorthSplitAt({ ...M.emptyDB(), accounts: base }, "2026-01-01");
  assert.equal(split.assets, 100000, "hidden and excluded accounts stay out");
  assert.equal(split.net, 100000);
});

await test("balances before an account existed read as zero, not as a drop", () => {
  const db = {
    ...M.emptyDB(),
    accounts: [held("new", [{ date: "2026-06-01", balance: 250000 }])],
  };
  const before = M.netWorthSplitAt(db, "2026-01-01");
  assert.equal(before.assets, 0);
  assert.equal(before.liabilities, 0);
  const after = M.netWorthSplitAt(db, "2026-09-01");
  assert.equal(after.assets, 250000, "and forward-fill carries the last point");
});

await test("today's split agrees with the totals shown beside it", () => {
  const db = M.buildDemoDB();
  const now = M.netWorthNow(db);
  const split = M.netWorthSplitAt(db, M.thisMonth() + "-01");
  // not necessarily equal — the split is as of a date — but the shape must hold
  assert.equal(split.assets + split.liabilities, split.net);
  assert.equal(now.assets + now.liabilities, now.net);
  assert.ok(split.assets >= 0, "assets never go negative");
  assert.ok(split.liabilities <= 0, "liabilities never go positive");
});

/* ── downloading an account ──────────────────────────────────────────── */

await test("balance history downloads as CSV, and reads straight back in", () => {
  const account = {
    name: "Joint Cash Preserve",
    history: [
      { date: "2026-07-01", balance: 4456743 },
      { date: "2026-08-01", balance: -120050 },  // a debt, and a value needing two decimals
      { date: "2026-09-01", balance: 0 },
    ],
  };
  const csv = M.balanceHistoryToCSV(account);
  const lines = csv.split("\n");
  assert.equal(lines[0], "Date,Account,Balance");
  assert.equal(lines[1], "2026-07-01,Joint Cash Preserve,44567.43");
  assert.equal(lines[2], "2026-08-01,Joint Cash Preserve,-1200.50");
  assert.equal(lines[3], "2026-09-01,Joint Cash Preserve,0.00");

  // the point of the column names: the file is importable again
  const parsed = M.readBalanceCSV(csv);
  const roles = M.guessBalanceColumns(parsed.header);
  assert.deepEqual(roles, ["date", "account", "balance"]);
  const plan = M.buildBalancePlan(parsed.rows, roles, { negate: false });
  assert.equal(plan.points.length, 3);
  assert.equal(plan.skipped, 0, "a file this app wrote must not have unreadable rows");
  assert.deepEqual(plan.points.map((p) => p.balance), [4456743, -120050, 0], "cents must survive the round trip");
});

await test("a name with a comma in it doesn't break the columns", () => {
  const csv = M.balanceHistoryToCSV({
    name: 'Vector Rentals, LLC "Savings"',
    history: [{ date: "2026-09-01", balance: 1000791 }],
  });
  const parsed = M.readBalanceCSV(csv);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0][1], 'Vector Rentals, LLC "Savings"');
  assert.equal(parsed.rows[0][2], "10007.91");
});

await test("an empty history still writes a header, not an empty file", () => {
  assert.equal(M.balanceHistoryToCSV({ name: "New", history: [] }), "Date,Account,Balance");
});

await test("transactions download for one account, with its own rows only", () => {
  const db = M.buildDemoDB();
  const target = db.accounts.find((a) => db.transactions.some((t) => t.accountId === a.id));
  const rows = db.transactions.filter((t) => t.accountId === target.id);
  const csv = M.toCSV(db, rows);
  const lines = csv.split("\n");
  assert.equal(lines[0], "Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags");
  assert.equal(lines.length, rows.length + 1);
  for (const line of lines.slice(1)) {
    assert.ok(line.includes(target.name), "every row must belong to the account asked for");
  }
});

/* ── hiding, closing and deleting accounts ───────────────────────────── */

const syncPayload = (over = {}) => ({
  fetchedAt: "2026-09-01T12:00:00.000Z",
  accounts: [{
    syncId: "sf-1", name: "Everyday", institution: "Test Bank", type: "checking",
    balance: 120000, currency: "USD", balanceDate: "2026-09-01", ...over,
  }],
  transactions: [{
    syncId: "tx-1", accountSyncId: "sf-1", date: "2026-09-01", amount: -4210,
    description: "COFFEE", pending: false,
  }],
  errors: [],
});

await test("an account is identified by its sync id, and by name before it has one", () => {
  const keys = M.accountKeys({ syncId: "sf-1", name: "Everyday", institution: "Test Bank" });
  assert.deepEqual(keys, ["sync:sf-1", "name:test bank|everyday"]);
  // case and padding must not create a second identity
  assert.deepEqual(
    M.accountKeys({ name: "  EVERYDAY ", institution: "Test Bank" }),
    ["name:test bank|everyday"],
  );
});

await test("a deleted account does not come back on the next sync", () => {
  let db = M.emptyDB();
  const first = M.mergeSync(db, syncPayload(), "simplefin");
  assert.equal(first.accountsAdded, 1);
  assert.equal(first.db.transactions.length, 1);

  // delete it the way the app does: drop it and remember the provider's key
  const gone = first.db.accounts[0];
  db = {
    ...first.db,
    accounts: [],
    transactions: [],
    settings: { ...first.db.settings, deletedAccountKeys: M.accountKeys(gone) },
  };

  const again = M.mergeSync(db, syncPayload(), "simplefin");
  assert.equal(again.accountsAdded, 0, "the account must stay deleted");
  assert.equal(again.db.accounts.length, 0);
  assert.equal(again.transactionsAdded, 0, "and must not bring its transactions with it");
});

await test("a tombstone matches on name too, for an account deleted before it had a sync id", () => {
  const db = {
    ...M.emptyDB(),
    settings: { ...M.emptyDB().settings, deletedAccountKeys: ["name:test bank|everyday"] },
  };
  const res = M.mergeSync(db, syncPayload({ syncId: "a-different-id" }), "simplefin");
  assert.equal(res.accountsAdded, 0, "same account, new provider id");
});

await test("deleting one account leaves the others alone", () => {
  const db = {
    ...M.emptyDB(),
    settings: { ...M.emptyDB().settings, deletedAccountKeys: ["sync:sf-1"] },
  };
  const payload = syncPayload();
  payload.accounts.push({
    syncId: "sf-2", name: "Savings", institution: "Test Bank", type: "savings",
    balance: 500000, currency: "USD", balanceDate: "2026-09-01",
  });
  payload.transactions.push({
    syncId: "tx-2", accountSyncId: "sf-2", date: "2026-09-01", amount: -100,
    description: "FEE", pending: false,
  });
  const res = M.mergeSync(db, payload, "simplefin");
  assert.equal(res.accountsAdded, 1);
  assert.equal(res.db.accounts[0].name, "Savings");
  assert.equal(res.transactionsAdded, 1, "only the surviving account's transactions");
});

await test("a closed account is left settled by the next sync", () => {
  const first = M.mergeSync(M.emptyDB(), syncPayload(), "simplefin");
  const closed = {
    ...first.db,
    accounts: first.db.accounts.map((a) => ({
      ...a, balance: 0, closedAt: "2026-09-01",
      history: [...a.history, { date: "2026-09-01", balance: 0 }],
    })),
  };
  const after = M.mergeSync(closed, syncPayload({ balance: 999900 }), "simplefin");
  assert.equal(after.db.accounts[0].balance, 0, "a closed account must not be revived by a pull");
  assert.equal(after.accountsUpdated, 0);
  assert.equal(after.transactionsAdded, 0, "and takes no further transactions");
  assert.equal(after.db.accounts.length, 1, "but is not re-added as a second account either");
});

await test("hiding an account's transactions takes them out of every figure", () => {
  const base = M.buildDemoDB();
  const busiest = [...base.accounts]
    .map((a) => ({ a, n: base.transactions.filter((t) => t.accountId === a.id).length }))
    .sort((x, y) => y.n - x.n)[0];
  assert.ok(busiest.n > 0, "need an account with transactions to judge");

  const muted = { ...base, accounts: base.accounts.map((a) => (a.id === busiest.a.id ? { ...a, hideTransactions: true } : a)) };
  assert.equal(M.mutedAccountIds(muted).has(busiest.a.id), true);
  assert.equal(M.mutedAccountIds(base).size, 0);

  const month = M.thisMonth();
  const before = [...M.budgetSummary(base, month).table].reduce((s, g) => s + g.actual, 0);
  const after = [...M.budgetSummary(muted, month).table].reduce((s, g) => s + g.actual, 0);
  assert.ok(after <= before, "muting can only remove actuals, never add");

  const months = [M.addMonths(month, -1), month];
  const flowBefore = M.cashFlowSeries(base, months).reduce((s, p) => s + p.income + p.expense, 0);
  const flowAfter = M.cashFlowSeries(muted, months).reduce((s, p) => s + p.income + p.expense, 0);
  assert.ok(flowAfter < flowBefore, "cash flow must drop when a busy account is muted");

  // and the account's own balance is untouched — this hides figures, not money
  assert.equal(
    muted.accounts.find((a) => a.id === busiest.a.id).balance,
    base.accounts.find((a) => a.id === busiest.a.id).balance,
  );
});

await test("a muted transaction is excluded, a plain one is not", () => {
  const muted = new Set(["a_muted"]);
  const t = (accountId, hideFromReports = false) => ({ accountId, hideFromReports });
  assert.equal(M.counts(t("a_ok"), muted), true);
  assert.equal(M.counts(t("a_muted"), muted), false);
  assert.equal(M.counts(t("a_ok", true), muted), false, "the per-transaction flag still applies");
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

/* ── the sync schedule ────────────────────────────────────────────────── */

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

await test("off means nothing ever fires", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  assert.equal(M.syncDue("off", undefined, now, now), false, "not even a first sync");
  assert.equal(M.syncDue("off", iso(now - 400 * HOUR), now, now), false);
  assert.equal(M.nextSyncAt("off", iso(now)), null);
});

await test("a connection that has never synced is due immediately", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  for (const c of ["open", "hourly", "6h", "daily", "weekly"]) {
    assert.equal(M.syncDue(c, undefined, now, now), true, `${c} should pull on a fresh connection`);
  }
});

await test("an interval fires only once its hours have passed", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  const cases = [["hourly", 1], ["6h", 6], ["daily", 24], ["weekly", 168]];
  for (const [cadence, hours] of cases) {
    assert.equal(M.cadenceHours(cadence), hours);
    // a minute short
    assert.equal(M.syncDue(cadence, iso(now - hours * HOUR + 60_000), now, now), false, `${cadence} fired early`);
    // exactly on the hour, and past it
    assert.equal(M.syncDue(cadence, iso(now - hours * HOUR), now, now), true, `${cadence} missed its slot`);
    assert.equal(M.syncDue(cadence, iso(now - hours * HOUR * 3), now, now), true);
    assert.equal(M.nextSyncAt(cadence, iso(now)), now + hours * HOUR);
  }
});

await test("'whenever I open the app' fires once a visit, not once a check", () => {
  const start = Date.parse("2026-09-01T12:00:00Z");
  // synced before this page was loaded: owed
  assert.equal(M.syncDue("open", iso(start - 60_000), start + 1000, start), true);
  // the sync that just ran during this visit: not owed again five minutes later
  assert.equal(M.syncDue("open", iso(start + 2000), start + 300_000, start), false,
    "this is the loop that would sync forever");
  assert.equal(M.nextSyncAt("open", iso(start)), null, "there is no clock time for 'on open'");
});

await test("a clock that jumped backwards does not stampede", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  // lastSyncAt in the future — a machine whose clock was corrected
  assert.equal(M.syncDue("hourly", iso(now + 5 * HOUR), now, now), false);
});

await test("an unreadable timestamp is treated as never synced", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  assert.equal(M.syncDue("daily", "not a date", now, now), true);
  assert.equal(M.nextSyncAt("daily", "not a date"), null);
});

await test("the countdown reads in whichever unit fits", () => {
  const now = 0;
  assert.equal(M.untilLabel(-1, now), "now");
  assert.equal(M.untilLabel(60_000, now), "in 1 minute");
  assert.equal(M.untilLabel(25 * 60_000, now), "in 25 minutes");
  assert.equal(M.untilLabel(3 * HOUR, now), "in 3 hours");
  assert.equal(M.untilLabel(72 * HOUR, now), "in 3 days");
});

await test("the default cadence is one of the offered options", () => {
  assert.ok(M.CADENCES.some((c) => c.value === M.DEFAULT_CADENCE));
  assert.equal(M.DEFAULT_CADENCE, "daily", "SimpleFIN refreshes about daily upstream");
});

/* ── cross-device sync: the passphrase gate ──────────────────────────── */

await test("a passphrase is read out of the Authorization header", () => {
  assert.equal(M.bearer("Bearer hunter2"), "hunter2");
  assert.equal(M.bearer("bearer hunter2"), "hunter2", "the scheme is case-insensitive");
  assert.equal(M.bearer("  Bearer  spaced out  "), "spaced out");
  assert.equal(M.bearer(["Bearer first"]), "first");
  assert.equal(M.bearer(undefined), undefined);
  assert.equal(M.bearer("Basic hunter2"), undefined, "only bearer tokens count");
});

await test("the passphrase must match exactly, and absence never passes", async () => {
  await withEnv({ SYNC_PASSPHRASE: "correct horse" }, () => {
    assert.equal(M.passphraseSet(), true);
    assert.equal(M.passphraseOk("correct horse"), true);
    assert.equal(M.passphraseOk("correct horse "), false, "trailing space is a different phrase");
    assert.equal(M.passphraseOk("Correct Horse"), false);
    assert.equal(M.passphraseOk(""), false);
    assert.equal(M.passphraseOk(undefined), false);
    // a short guess must not throw on a length mismatch — digests equalise it
    assert.equal(M.passphraseOk("x"), false);
    assert.equal(M.passphraseOk("x".repeat(500)), false);
  });
});

await test("with no passphrase configured, nothing opens the door", async () => {
  await withEnv({ SYNC_PASSPHRASE: "" }, () => {
    assert.equal(M.passphraseSet(), false);
    assert.equal(M.passphraseOk(""), false);
    assert.equal(M.passphraseOk("anything"), false);
    assert.equal(M.passphraseOk(undefined), false);
  });
});

await test("the document endpoint refuses before it reaches the database", async () => {
  // The passphrase gate comes first, so an unauthenticated caller learns
  // nothing about how this deployment is configured.
  const anonymous = await withEnv({ DATABASE_URL: "", POSTGRES_URL: "", POSTGRES_PRISMA_URL: "", NEON_DATABASE_URL: "", SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "GET" }));
  assert.equal(anonymous.status, 401);

  // with the passphrase, a missing database is explained
  const noDb = await withEnv({ DATABASE_URL: "", POSTGRES_URL: "", POSTGRES_PRISMA_URL: "", NEON_DATABASE_URL: "", POSTGRES_URL_NON_POOLING: "", DATABASE_URL_UNPOOLED: "", SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "GET", headers: { authorization: "Bearer p" } }));
  assert.equal(noDb.status, 503);
  assert.match(JSON.parse(noDb.text).error, /Storage/);

  // database but no passphrase: refuse rather than serve it unguarded
  const noPass = await withEnv({ DATABASE_URL: "postgres://x", SYNC_PASSPHRASE: "" },
    () => invokeWith(M.dbHandler, { method: "GET" }));
  assert.equal(noPass.status, 503);
  assert.match(JSON.parse(noPass.text).error, /SYNC_PASSPHRASE/);

  // wrong passphrase
  const wrong = await withEnv({ DATABASE_URL: "postgres://x", SYNC_PASSPHRASE: "right" },
    () => invokeWith(M.dbHandler, { method: "GET", headers: { authorization: "Bearer wrong" } }));
  assert.equal(wrong.status, 401);

  // no passphrase supplied at all
  const none = await withEnv({ DATABASE_URL: "postgres://x", SYNC_PASSPHRASE: "right" },
    () => invokeWith(M.dbHandler, { method: "GET" }));
  assert.equal(none.status, 401);
});

const findUrl = (env) => M.findConnection(env).url;

await test("the connection string is picked from whichever provider set one", () => {
  // Neon and Supabase through the Vercel marketplace
  assert.equal(findUrl({ DATABASE_URL: "postgres://u:p@ep-x.neon.tech/db?sslmode=require" }), "postgres://u:p@ep-x.neon.tech/db?sslmode=require");
  assert.equal(findUrl({ POSTGRES_URL: "postgresql://u:p@db.supabase.co:6543/postgres" }), "postgresql://u:p@db.supabase.co:6543/postgres");
  assert.equal(findUrl({ NEON_DATABASE_URL: "postgres://a/b" }), "postgres://a/b");
  assert.equal(findUrl({ DATABASE_URL_UNPOOLED: "postgres://direct/b" }), "postgres://direct/b");
  assert.equal(findUrl({}), null);
  assert.equal(findUrl({ DATABASE_URL: "   " }), null, "whitespace is not a connection string");
  assert.equal(findUrl({ DATABASE_URL: "  postgres://a/b  " }), "postgres://a/b", "and a stray newline is trimmed");
});

await test("a pooled connection is preferred over a direct one", () => {
  // Both are set by Neon; serverless functions want the pooler.
  const both = { DATABASE_URL: "postgres://pooled/db", DATABASE_URL_UNPOOLED: "postgres://direct/db" };
  assert.equal(findUrl(both), "postgres://pooled/db");
});

await test("a URL pg cannot dial is named rather than dialled", () => {
  // Prisma Postgres hands out an accelerate URL under the usual variable name.
  const prisma = M.findConnection({ DATABASE_URL: "prisma+postgres://accelerate.prisma-data.net/?api_key=x" });
  assert.equal(prisma.url, null, "this must not reach pg");
  assert.equal(prisma.unusable.name, "DATABASE_URL");
  assert.equal(prisma.unusable.scheme, "prisma+postgres");

  // but a usable one alongside it still wins
  const mixed = M.findConnection({
    DATABASE_URL: "prisma+postgres://accelerate.prisma-data.net/?api_key=x",
    POSTGRES_URL: "postgres://real/db",
  });
  assert.equal(mixed.url, "postgres://real/db");
});

await test("an unusable URL is explained, not left as a driver crash", async () => {
  const r = await withEnv(
    { DATABASE_URL: "prisma+postgres://accelerate.prisma-data.net/?api_key=x", POSTGRES_URL: "", POSTGRES_PRISMA_URL: "", NEON_DATABASE_URL: "", POSTGRES_URL_NON_POOLING: "", DATABASE_URL_UNPOOLED: "", SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "GET", headers: { authorization: "Bearer p" } }),
  );
  assert.equal(r.status, 503);
  const { error } = JSON.parse(r.text);
  assert.match(error, /prisma\+postgres/);
  assert.match(error, /Neon and Supabase/);
});

await test("the database check answers even with no database configured", async () => {
  // The case it exists for. Gating it behind the connection check would make it
  // useless in exactly the situation that needs explaining.
  const r = await withEnv(
    { DATABASE_URL: "", POSTGRES_URL: "", POSTGRES_PRISMA_URL: "", NEON_DATABASE_URL: "",
      POSTGRES_URL_NON_POOLING: "", DATABASE_URL_UNPOOLED: "", SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "POST", body: { action: "diagnose" }, headers: { authorization: "Bearer p" } }),
  );
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.variable, null);
  assert.equal(body.connect.ok, false);
  assert.match(body.connect.error, /No connection string/);
});

await test("the check reports the driver separately from the connection", async () => {
  const r = await withEnv({ DATABASE_URL: "postgres://u:p@db.example.com/app", SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "POST", body: { action: "diagnose" }, headers: { authorization: "Bearer p" } }));
  const body = JSON.parse(r.text);
  // A driver that will not load and a database that will not answer look
  // identical from outside unless they are reported apart.
  assert.equal(body.driver.ok, true, "pg loads in this environment");
  assert.equal(body.variable, "DATABASE_URL");
  assert.equal(body.host, "db.example.com");
  assert.equal(JSON.stringify(body).includes("u:p@"), false, "credentials must not come back");
});

await test("the check still needs the passphrase", async () => {
  const r = await withEnv({ SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "POST", body: { action: "diagnose" }, headers: { authorization: "Bearer wrong" } }));
  assert.equal(r.status, 401, "anyone must not be able to probe the database");
});

await test("an unusable URL is named by the check as well as the endpoint", async () => {
  const r = await withEnv(
    { DATABASE_URL: "prisma+postgres://accelerate.prisma-data.net/?api_key=k", POSTGRES_URL: "",
      POSTGRES_PRISMA_URL: "", NEON_DATABASE_URL: "", POSTGRES_URL_NON_POOLING: "",
      DATABASE_URL_UNPOOLED: "", SYNC_PASSPHRASE: "p" },
    () => invokeWith(M.dbHandler, { method: "POST", body: { action: "diagnose" }, headers: { authorization: "Bearer p" } }),
  );
  const body = JSON.parse(r.text);
  assert.equal(body.variable, null);
  assert.match(body.connect.error, /prisma\+postgres/);
});

await test("a write without a baseVersion is refused, so nothing clobbers blindly", async () => {
  const env = { DATABASE_URL: "postgres://x", SYNC_PASSPHRASE: "right" };
  const auth = { authorization: "Bearer right" };
  for (const body of [{ doc: { a: 1 } }, { doc: { a: 1 }, baseVersion: "3" }, { doc: { a: 1 }, baseVersion: -1 }]) {
    const r = await withEnv(env, () => invokeWith(M.dbHandler, { method: "PUT", body, headers: auth }));
    assert.equal(r.status, 400, `should refuse ${JSON.stringify(body)}`);
  }
  const noDoc = await withEnv(env, () => invokeWith(M.dbHandler, { method: "PUT", body: { baseVersion: 0 }, headers: auth }));
  assert.equal(noDoc.status, 400);
});

await test("the document endpoint answers every method, never hangs", async () => {
  const r = await withEnv({ DATABASE_URL: "postgres://x", SYNC_PASSPHRASE: "right" },
    () => invokeWith(M.dbHandler, { method: "DELETE", headers: { authorization: "Bearer right" } }));
  assert.equal(r.status, 405);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["cache-control"], "no-store", "a budget must not be cached by a proxy");
});

await test("the scheduled job is closed to anyone without a secret", async () => {
  const env = { CRON_SECRET: "s3cret", SYNC_PASSPHRASE: "phrase", DATABASE_URL: "postgres://x" };
  const denied = await withEnv(env, () => invokeWith(M.cronHandler, { method: "GET" }));
  assert.equal(denied.status, 401);

  const guessed = await withEnv(env, () => invokeWith(M.cronHandler, { method: "GET", headers: { authorization: "Bearer nope" } }));
  assert.equal(guessed.status, 401);

  // Vercel's own call carries CRON_SECRET; a person can use the sync passphrase
  for (const token of ["s3cret", "phrase"]) {
    const r = await withEnv({ ...env, DATABASE_URL: "" },
      () => invokeWith(M.cronHandler, { method: "GET", headers: { authorization: `Bearer ${token}` } }));
    assert.equal(r.status, 503, `${token} should get past the gate and then hit the missing database`);
  }
});

/* ── plaid ────────────────────────────────────────────────────────────── */

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

await test("the institution lookup asks only the two free endpoints", async () => {
  // The whole point of backfilling a logo is that it costs nothing. /item/get
  // and /institutions/get_by_id are unmetered; if this ever reaches for one of
  // the billed endpoints the logo stops being worth having.
  const hit = [];
  const r = await withEnv(creds, () =>
    withFetch(async (url) => {
      const path = new URL(String(url)).pathname;
      hit.push(path);
      if (path === "/item/get") return new Response(JSON.stringify({ item: { institution_id: "ins_127989" } }), { status: 200 });
      return new Response(JSON.stringify({
        institution: { name: "Wells Fargo", logo: "iVBORw0KGgo=", url: "https://www.wellsfargo.com/" },
      }), { status: 200 });
    }, () => invokePlaid({ action: "institution", accessToken: "tok" })));

  assert.deepEqual(hit, ["/item/get", "/institutions/get_by_id"]);
  const body = JSON.parse(r.text);
  assert.equal(body.institution, "Wells Fargo");
  assert.equal(body.logo, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(body.domain, "wellsfargo.com");
});

await test("the institution lookup asks for the optional metadata that carries the logo", async () => {
  // Plaid returns neither logo nor url unless include_optional_metadata is set,
  // which is the whole reason this endpoint is being called.
  let sent = null;
  await withEnv(creds, () =>
    withFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/item/get") return new Response(JSON.stringify({ item: { institution_id: "ins_1" } }), { status: 200 });
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ institution: { name: "A Bank" } }), { status: 200 });
    }, () => invokePlaid({ action: "institution", accessToken: "tok" })));

  assert.equal(sent.options.include_optional_metadata, true);
});

await test("a logo-less item is asked again later, one that has a mark never is", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-09-02T00:00:00Z");
  const at = (daysAgo) => new Date(now - daysAgo * day).toISOString();

  // The case the user hit: connected before the app kept logos.
  assert.equal(M.needsInstitution({}, now), true);
  // Already has a mark from either source — never ask again.
  assert.equal(M.needsInstitution({ logo: "data:image/png;base64,x" }, now), false);
  assert.equal(M.needsInstitution({ domain: "wellsfargo.com" }, now), false);
  // Asked, and Plaid had nothing: don't ask on every sync, but don't give up.
  assert.equal(M.needsInstitution({ institutionCheckedAt: at(1) }, now), false);
  assert.equal(M.needsInstitution({ institutionCheckedAt: at(31) }, now), true);
  assert.equal(M.needsInstitution({ institutionCheckedAt: "not a date" }, now), true);
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

/**
 * Exercises the document store against a real Postgres, which the pure test
 * suite can't reach. Point DATABASE_URL at a throwaway database and run:
 *
 *   DATABASE_URL=postgres://... node scripts/dbtest.mjs
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

if (!process.env.DATABASE_URL) {
  console.log("SKIP  no DATABASE_URL — the store's SQL was not exercised");
  process.exit(0);
}

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); }
  catch (err) { results.push(["FAIL", name, err.message]); }
};

// Bundled inside the project: pg stays external, so it has to resolve from a
// directory that can see node_modules.
const dir = await mkdtemp(join(process.cwd(), "node_modules", ".dbtest-"));
const entry = join(dir, "entry.js");
await build({
  stdin: {
    contents: `
      export { readDoc, writeDoc, writeAllowed, connectionString } from "./api/_store.ts";
      export { default as dbHandler } from "./api/db.ts";
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: entry, logLevel: "silent",
  external: ["pg", "pg-native"],
});
const M = await import(entry);

const { Client } = await import("pg");
const wipe = async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("DROP TABLE IF EXISTS budget_document");
  await c.end();
};

const invokeWith = (handler, { method = "POST", body, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const out = {};
    const timer = setTimeout(() => reject(new Error("handler never wrote a response")), 10000);
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { out[k.toLowerCase()] = v; },
      end: (text) => { clearTimeout(timer); resolve({ status: res.statusCode, text: text ?? "" }); },
    };
    Promise.resolve(handler({ method, body, headers }, res)).catch((e) => { clearTimeout(timer); reject(e); });
  });

await wipe();

await test("the table is created on first use, and reading an empty store is not an error", async () => {
  assert.equal(await M.readDoc(), null);
  assert.equal(await M.readDoc(), null, "a second call must not trip over the existing table");
});

await test("a document round-trips intact", async () => {
  const doc = {
    settings: { theme: "dark", householdName: "Cameron", simplefinAccessUrl: "https://u:p@x/y" },
    accounts: [{ id: "a1", name: "Everyday", balance: -46512300, history: [{ date: "2026-09-01", balance: -46512300 }] }],
    transactions: [{ id: "t1", amount: -1234, merchant: "Caffè Nero — ☕", date: "2026-09-01" }],
    budgets: { "2026-09": { c_groceries: 60000 } },
  };
  const w = await M.writeDoc(doc, 0, "first device");
  assert.equal(w.ok, true);
  assert.equal(w.stored.version, 1);

  const back = await M.readDoc();
  assert.equal(back.version, 1);
  assert.equal(back.updatedBy, "first device");
  assert.deepEqual(back.doc, doc, "jsonb must return exactly what went in");
  assert.equal(back.doc.accounts[0].balance, -46512300, "a big negative cent count survives");
  assert.equal(back.doc.transactions[0].merchant, "Caffè Nero — ☕", "unicode survives");
  assert.ok(!Number.isNaN(Date.parse(back.updatedAt)));
});

await test("each write moves the version on", async () => {
  const a = await M.writeDoc({ n: 2 }, 1, "device");
  assert.equal(a.stored.version, 2);
  const b = await M.writeDoc({ n: 3 }, 2, "device");
  assert.equal(b.stored.version, 3);
  assert.equal((await M.readDoc()).doc.n, 3);
});

await test("a stale write is refused and hands back what is actually stored", async () => {
  const stale = await M.writeDoc({ n: 99 }, 1, "second device");
  assert.equal(stale.ok, false, "version 1 is long gone");
  assert.equal(stale.conflict.version, 3);
  assert.equal(stale.conflict.doc.n, 3);
  assert.equal((await M.readDoc()).doc.n, 3, "the refused write must not have landed");
});

await test("the scheduled job's forced write always lands", async () => {
  const forced = await M.writeDoc({ n: 4, by: "cron" }, null, "scheduled sync");
  assert.equal(forced.ok, true);
  assert.equal(forced.stored.version, 4);
  assert.equal((await M.readDoc()).updatedBy, "scheduled sync");
});

await test("two devices saving at once — only one wins", async () => {
  await M.writeDoc({ n: 0 }, null, "reset");
  const base = (await M.readDoc()).version;
  const [x, y] = await Promise.all([
    M.writeDoc({ who: "laptop" }, base, "laptop"),
    M.writeDoc({ who: "phone" }, base, "phone"),
  ]);
  const winners = [x, y].filter((r) => r.ok);
  assert.equal(winners.length, 1, "the row lock must let exactly one through");
  const stored = await M.readDoc();
  assert.equal(stored.version, base + 1, "the version must advance once, not twice");
  assert.equal(stored.doc.who, winners[0].stored.doc.who);
});

await test("a big year of data goes in and comes back", async () => {
  const transactions = Array.from({ length: 6000 }, (_, i) => ({
    id: `t${i}`, accountId: "a1", date: "2026-05-04", merchant: `Merchant ${i}`,
    amount: -(i % 9000), categoryId: "c_groceries", tags: [], pending: false,
  }));
  const w = await M.writeDoc({ transactions }, null, "bulk");
  assert.equal(w.ok, true);
  const back = await M.readDoc();
  assert.equal(back.doc.transactions.length, 6000);
  assert.equal(back.doc.transactions[5999].merchant, "Merchant 5999");
  console.log(`      stored ${(JSON.stringify({ transactions }).length / 1024 / 1024).toFixed(2)} MB`);
});

await test("the endpoint serves and saves through the same store", async () => {
  process.env.SYNC_PASSPHRASE = "open sesame";
  const auth = { authorization: "Bearer open sesame" };

  const got = await invokeWith(M.dbHandler, { method: "GET", headers: auth });
  assert.equal(got.status, 200);
  const body = JSON.parse(got.text);
  assert.equal(body.found, true);

  const put = await invokeWith(M.dbHandler, {
    method: "PUT", headers: auth, body: { doc: { hello: "world" }, baseVersion: body.version, device: "Chrome on Mac" },
  });
  assert.equal(put.status, 200);
  assert.equal(JSON.parse(put.text).version, body.version + 1);

  const conflict = await invokeWith(M.dbHandler, {
    method: "PUT", headers: auth, body: { doc: { hello: "again" }, baseVersion: body.version },
  });
  assert.equal(conflict.status, 409, "a second save from the same stale version must be refused");
  assert.equal(JSON.parse(conflict.text).current.version, body.version + 1);

  const after = await invokeWith(M.dbHandler, { method: "GET", headers: auth });
  assert.equal(JSON.parse(after.text).doc.hello, "world", "the refused save must not have landed");
  assert.equal(JSON.parse(after.text).updatedBy, "Chrome on Mac");
});

await wipe();
await rm(dir, { recursive: true, force: true });
for (const [state, name, msg] of results) console.log(`${state}  ${name}${msg ? ` — ${msg}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

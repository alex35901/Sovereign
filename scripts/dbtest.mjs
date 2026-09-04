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
      export { readDoc, readMeta, writeDoc, writeAllowed, connectionString } from "./api/_store.ts";
      export { default as dbHandler } from "./api/db.ts";
      export { default as hopperHandler } from "./api/hopper.ts";
      export { claimMessage, spentToday, noteTokens, forgetTable, DAILY_MESSAGES } from "./api/_budget.ts";
      export { default as cronHandler } from "./api/cron/sync.ts";
      export { readAttempt, noteFailure, clearFailures, lockedOutNow, callerKey, MAX_FAILURES } from "./api/_ratelimit.ts";
      export { queuePull, readQueue, clearQueue, trimQueue } from "./api/_store.ts";
      export { default as cronHandler2 } from "./api/cron/sync.ts";
      export * as C from "./src/lib/crypto.ts";
      export { applyQueue, drainSummary } from "./src/lib/sync/drain.ts";
      export { mergeSync } from "./src/lib/sync/merge.ts";
      export { buildDemoDB, emptyDB } from "./src/lib/seed.ts";
      export { tickersOf } from "./src/lib/prices.ts";
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
  await c.query("DROP TABLE IF EXISTS auth_attempt");
  await c.query("DROP TABLE IF EXISTS sync_queue");
  await c.end();
};

const invokeWith = (handler, { method = "POST", body, headers = {}, url = "/api/db" } = {}) =>
  new Promise((resolve, reject) => {
    const out = {};
    const timer = setTimeout(() => reject(new Error("handler never wrote a response")), 10000);
    // Streaming handlers write in pieces and end with nothing, so the chunks
    // are collected — a test that only reads the final argument would see an
    // empty body and pass whatever was streamed.
    let streamed = "";
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { out[k.toLowerCase()] = v; },
      write: (chunk) => { streamed += chunk; return true; },
      end: (text) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, text: (text ?? "") + streamed, headers: out });
      },
    };
    Promise.resolve(handler({ method, url, body, headers }, res)).catch((e) => { clearTimeout(timer); reject(e); });
  });

const clearAttempts = async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("DROP TABLE IF EXISTS auth_attempt");
  await c.query("DROP TABLE IF EXISTS sync_queue");
  await c.end();
};

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

/* ── the cheap read the polling loop uses ─────────────────────────────── */

await test("the metadata read answers the poll's question without moving the document", async () => {
  const doc = { filler: "x".repeat(200000) };
  const before = await M.readDoc();
  await M.writeDoc(doc, before.version, "the big device");

  const meta = await M.readMeta();
  const full = await M.readDoc();
  assert.equal(meta.version, full.version, "the version must agree with the full read");
  assert.equal(meta.updatedBy, "the big device");
  assert.equal(meta.updatedAt, full.updatedAt);
  assert.equal(meta.sealed, false, "a plain document is not sealed");
  assert.equal(meta.doc, undefined, "the document itself must not come back — that is the whole point");
  assert.equal(JSON.stringify(meta).length < 200, true, "the metadata reply must stay tiny");
});

await test("the metadata read says whether the document is sealed, without opening it", async () => {
  await wipe();
  await M.writeDoc({ plain: true }, 0, "plain device");
  assert.equal((await M.readMeta()).sealed, false, "a plain document reads as unsealed");

  const at = await M.readMeta();
  await M.writeDoc({ v: 1, alg: "AES-GCM", kdf: "PBKDF2", iter: 600000, salt: "s", iv: "i", ct: "sealed-bytes" }, at.version, "sealed device");
  const sealed = await M.readMeta();
  assert.equal(sealed.sealed, true, "sealing must be visible without fetching the envelope");
  assert.equal(sealed.updatedBy, "sealed device");
});

await test("the metadata read on an empty store is not an error", async () => {
  await wipe();
  assert.equal(await M.readMeta(), null);
  await M.writeDoc({ hello: 1 }, 0, "device");
  assert.equal((await M.readMeta()).version, 1);
});

await test("GET ?meta=1 serves the metadata and nothing else", async () => {
  process.env.SYNC_PASSPHRASE = "open sesame";
  const auth = { authorization: "Bearer open sesame" };

  const fullRes = await invokeWith(M.dbHandler, { method: "GET", headers: auth });
  const full = JSON.parse(fullRes.text);
  const r = await invokeWith(M.dbHandler, { method: "GET", headers: auth, url: "/api/db?meta=1" });
  assert.equal(r.status, 200);
  const meta = JSON.parse(r.text);
  assert.equal(meta.found, true);
  assert.equal(meta.version, full.version);
  assert.equal(meta.doc, undefined, "?meta=1 must not carry the document");
  assert.ok(r.text.length < fullRes.text.length, "the metadata reply must be smaller than the full one");

  const wrong = await invokeWith(M.dbHandler, {
    method: "GET", headers: { authorization: "Bearer not-it" }, url: "/api/db?meta=1", 
  });
  assert.equal(wrong.status, 401, "?meta=1 is behind the same passphrase as everything else");
});

/* ── what Hopper costs, and who may ask ───────────────────────────────── */

const wipeUsage = async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("DROP TABLE IF EXISTS hopper_usage");
  await c.end();
  M.forgetTable();
};

await test("the day's allowance is claimed atomically, so a burst cannot overspend it", async () => {
  await wipeUsage();
  const day = "2026-09-04";
  // Every question asked at the same moment. If the check and the increment
  // were two statements they would all read the same count and all be let
  // through, which is exactly how a nightly loop runs up a bill.
  const claims = await Promise.all(
    Array.from({ length: M.DAILY_MESSAGES + 25 }, () => M.claimMessage(day)),
  );
  const allowed = claims.filter((c) => c.ok).length;
  assert.equal(allowed, M.DAILY_MESSAGES, `${allowed} got through a limit of ${M.DAILY_MESSAGES}`);
  assert.equal((await M.spentToday(day)).messages, M.DAILY_MESSAGES);

  const after = await M.claimMessage(day);
  assert.equal(after.ok, false, "the limit must hold once it is reached");
});

await test("each day gets its own allowance", async () => {
  await wipeUsage();
  await M.claimMessage("2026-09-04");
  assert.equal((await M.spentToday("2026-09-05")).messages, 0);
  assert.equal((await M.spentToday("2026-09-04")).messages, 1);
});

await test("what a turn actually used is recorded, and a missing day is not an error", async () => {
  await wipeUsage();
  const day = "2026-09-04";
  await M.claimMessage(day);
  await M.noteTokens(4200, 900, day);
  await M.noteTokens(3100, 400, day);
  const spend = await M.spentToday(day);
  assert.equal(spend.inputTokens, 7300);
  assert.equal(spend.outputTokens, 1300);
  assert.deepEqual(await M.spentToday("2026-01-01"), { day: "2026-01-01", messages: 0, inputTokens: 0, outputTokens: 0 });
});

await test("Hopper is behind the same passphrase as the document", async () => {
  process.env.SYNC_PASSPHRASE = "open sesame";
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
  await clearAttempts();

  const nobody = await invokeWith(M.hopperHandler, {
    method: "POST", body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(nobody.status, 401, "no passphrase must not reach the model");

  const wrong = await invokeWith(M.hopperHandler, {
    method: "POST", headers: { authorization: "Bearer nope" },
    body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(wrong.status, 401);

  const get = await invokeWith(M.hopperHandler, {
    method: "GET", headers: { authorization: "Bearer open sesame" },
  });
  assert.equal(get.status, 405, "only POST carries a question");
});

await test("no API key is a plain answer, not a broken chat", async () => {
  process.env.SYNC_PASSPHRASE = "open sesame";
  delete process.env.ANTHROPIC_API_KEY;
  const r = await invokeWith(M.hopperHandler, {
    method: "POST", headers: { authorization: "Bearer open sesame" },
    body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 503);
  const body = JSON.parse(r.text);
  assert.match(body.error, /API key/i);
  assert.match(body.hint, /ANTHROPIC_API_KEY/, "it has to say which variable to set");
});

await test("the API key never leaves the server", async () => {
  // Every refusal path, checked for the secret. The SDK's own errors carry the
  // request that caused them, and the request carries the key in a header —
  // so an error passed through unread is how a key escapes.
  const secret = "sk-ant-SUPERSECRET-do-not-leak";
  process.env.SYNC_PASSPHRASE = "open sesame";
  process.env.ANTHROPIC_API_KEY = secret;
  await clearAttempts();

  const calls = [
    { method: "GET", headers: { authorization: "Bearer open sesame" } },
    { method: "POST", headers: { authorization: "Bearer wrong" }, body: { messages: [] } },
    { method: "POST", headers: { authorization: "Bearer open sesame" }, body: { messages: [] } },
    { method: "POST", headers: { authorization: "Bearer open sesame" }, body: { nonsense: true } },
  ];
  for (const call of calls) {
    const r = await invokeWith(M.hopperHandler, call);
    assert.ok(!r.text.includes(secret), `the key came back from ${call.method} ${r.status}`);
    assert.ok(!r.text.includes("SUPERSECRET"), "part of the key came back");
  }
  delete process.env.ANTHROPIC_API_KEY;
});

await test("an upstream failure comes back as words, and never as the key", async () => {
  // The path that matters most: the SDK's own errors carry the request that
  // caused them, and the request carries the key in a header. Pointed at a
  // closed port so the model call fails for certain.
  const secret = "sk-ant-SUPERSECRET-do-not-leak";
  process.env.SYNC_PASSPHRASE = "open sesame";
  process.env.ANTHROPIC_API_KEY = secret;
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  await wipeUsage();
  await clearAttempts();

  const r = await invokeWith(M.hopperHandler, {
    method: "POST", headers: { authorization: "Bearer open sesame" },
    body: { messages: [{ role: "user", content: "hello" }] },
  });

  assert.equal(r.status, 200, "the stream had already started, so the status is 200");
  assert.match(r.headers["content-type"], /event-stream/);
  assert.ok(r.text.includes('"type":"error"'), `no error event came back: ${r.text.slice(0, 200)}`);
  assert.ok(!r.text.includes(secret), "the key came back in the error event");
  assert.ok(!r.text.includes("SUPERSECRET"), "part of the key came back");
  assert.match(r.text, /could not be reached/, "it should say what happened in words");

  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

await test("a question with nothing in it is refused before it costs anything", async () => {
  process.env.SYNC_PASSPHRASE = "open sesame";
  process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key";
  await wipeUsage();
  const r = await invokeWith(M.hopperHandler, {
    method: "POST", headers: { authorization: "Bearer open sesame" }, body: { messages: [] },
  });
  assert.equal(r.status, 400);
  assert.equal((await M.spentToday()).messages, 0, "a malformed request must not spend the allowance");
  delete process.env.ANTHROPIC_API_KEY;
});


/* ── the guessing limit, against real SQL ─────────────────────────────── */

const guess = (pass, ip = "203.0.113.7") =>
  invokeWith(M.dbHandler, { method: "GET", headers: { authorization: `Bearer ${pass}`, "x-real-ip": ip } });

await test("the eighth wrong passphrase is refused with 429 and a Retry-After", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await clearAttempts();

  for (let i = 1; i < M.MAX_FAILURES; i++) {
    const r = await guess("nope" + i);
    assert.equal(r.status, 401, `guess ${i} should still be an ordinary refusal`);
  }
  const shut = await guess("nope8");
  assert.equal(shut.status, 429);
  const body = JSON.parse(shut.text);
  assert.match(body.error, /Too many wrong passphrases/);
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 15 * 60, `retryAfter was ${body.retryAfter}`);
});

await test("a locked-out caller is refused even with the right passphrase", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await clearAttempts();
  for (let i = 0; i < M.MAX_FAILURES; i++) await guess("wrong" + i);

  const r = await guess("the-right-one");
  assert.equal(r.status, 429, "the lock has to hold, or it buys nothing");
});

await test("one caller's lockout does not shut anyone else out", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await clearAttempts();
  for (let i = 0; i < M.MAX_FAILURES; i++) await guess("wrong" + i, "198.51.100.1");

  assert.equal((await guess("the-right-one", "198.51.100.1")).status, 429, "the guesser is locked");
  const other = await guess("the-right-one", "203.0.113.200");
  assert.notEqual(other.status, 429, "a different address must still get in");
});

await test("the right passphrase wipes the wrong ones, so a typo costs nothing later", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await clearAttempts();
  const ip = "192.0.2.55";
  for (let i = 0; i < M.MAX_FAILURES - 1; i++) await guess("typo" + i, ip);
  assert.equal((await M.readAttempt(M.callerKey("db", { "x-real-ip": ip }))).failures, M.MAX_FAILURES - 1);

  assert.notEqual((await guess("the-right-one", ip)).status, 429);
  assert.equal(await M.readAttempt(M.callerKey("db", { "x-real-ip": ip })), null, "the slate is clean");

  // and the next seven typos are therefore free again
  for (let i = 0; i < M.MAX_FAILURES - 1; i++) {
    assert.equal((await guess("typo" + i, ip)).status, 401);
  }
});

await test("the count survives a cold start, which is the whole reason it is in the database", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await clearAttempts();
  const ip = "192.0.2.99";
  for (let i = 0; i < 5; i++) await guess("wrong" + i, ip);

  // a fresh import is a fresh module instance: exactly what a cold start gives
  const cold = await import(entry + "?cold=1");
  const seen = await cold.readAttempt(cold.callerKey("db", { "x-real-ip": ip }));
  assert.equal(seen.failures, 5, "an in-memory counter would have read 0 here");
});

await test("the scheduled job's secret is limited too, and its own counter", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  await clearAttempts();
  const ip = "203.0.113.77";

  for (let i = 1; i < M.MAX_FAILURES; i++) {
    const r = await invokeWith(M.cronHandler, { headers: { authorization: `Bearer bad${i}`, "x-real-ip": ip } });
    assert.equal(r.status, 401, `cron guess ${i}`);
  }
  const shut = await invokeWith(M.cronHandler, { headers: { authorization: "Bearer bad8", "x-real-ip": ip } });
  assert.equal(shut.status, 429);

  // the document endpoint keeps a separate tally for the same address
  assert.notEqual((await guess("the-right-one", ip)).status, 429);
});

await test("the diagnostics report how many callers are shut out", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await clearAttempts();
  assert.equal(await M.lockedOutNow(), 0);
  for (let i = 0; i < M.MAX_FAILURES; i++) await guess("wrong" + i, "198.51.100.9");
  assert.equal(await M.lockedOutNow(), 1);

  const r = await invokeWith(M.dbHandler, {
    method: "POST", body: { action: "diagnose" },
    headers: { authorization: "Bearer the-right-one", "x-real-ip": "203.0.113.250" },
  });
  assert.equal(JSON.parse(r.text).lockedOut, 1);
});


await wipe();
await rm(dir, { recursive: true, force: true });

/* ── end-to-end encryption, through the real endpoint and real SQL ────── */

const C = M.C;
const PASS = "a long enough encryption passphrase";

const asServer = (body, method = "POST") =>
  invokeWith(M.dbHandler, { method, body, headers: { authorization: "Bearer the-right-one", "x-real-ip": "203.0.113.42" } });

/** The whole browser side: derive, encrypt, save. */
const unlockCheap = async (env) => {
  if (env) {
    const key = await C.deriveKey(PASS, C.fromB64(env.kdf.salt), env.kdf.iterations);
    const jwk = await C.unseal(key, env.wrappedPriv);
    const priv = await crypto.subtle.importKey("jwk", JSON.parse(jwk), C.KEY_ALGO, true, ["deriveBits"]);
    return { key, kdf: env.kdf, pub: env.pub, priv, wrappedPriv: env.wrappedPriv };
  }
  const kdf = { name: "PBKDF2", hash: "SHA-256", iterations: 1000, salt: C.toB64(C.newSalt()) };
  const key = await C.deriveKey(PASS, C.fromB64(kdf.salt), kdf.iterations);
  const { pub, priv } = await C.newKeypair();
  const wrappedPriv = await C.seal(key, JSON.stringify(await crypto.subtle.exportKey("jwk", priv)));
  return { key, kdf, pub, priv, wrappedPriv };
};

await test("a real budget migrates from plaintext to encrypted without losing anything", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await wipe(); await clearAttempts();

  // where they are today: the whole demo budget, stored in the clear
  const before = M.buildDemoDB();
  const seeded = await asServer({ doc: before, baseVersion: 0 }, "PUT");
  assert.equal(seeded.status, 200);

  // and what the database actually holds — readable to anyone who reaches it
  const plain = JSON.parse((await asServer(undefined, "GET")).text);
  assert.equal(JSON.stringify(plain.doc).includes("Philz Coffee"), true,
    "before encrypting, the merchant names really are sitting there in the open");

  // now they turn it on
  const at = await unlockCheap(null);
  const env = await C.encryptDocument(before, at);
  const saved = await asServer({ doc: env, baseVersion: plain.version }, "PUT");
  assert.equal(saved.status, 200);

  // what the database holds now
  const stored = JSON.parse((await asServer(undefined, "GET")).text);
  const wire = JSON.stringify(stored.doc);
  assert.equal(C.isEnvelope(stored.doc), true);
  for (const secret of ["Philz Coffee", "Wells Fargo", "Everyday Checking", "simplefinAccessUrl"]) {
    assert.equal(wire.includes(secret), false, `"${secret}" survived into the stored ciphertext`);
  }

  // and it still comes back byte for byte
  const after = await C.decryptDocument(stored.doc, await unlockCheap(stored.doc));
  assert.deepEqual(after, before, "the whole budget has to survive the round trip exactly");
  assert.equal(after.transactions.length, before.transactions.length);
  assert.ok(before.transactions.length > 100, "and it is a real amount of data, not a toy");
});

await test("the scheduled job queues a pull it cannot itself read, and a browser merges it", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await wipe(); await clearAttempts();

  const at = await unlockCheap(null);
  const base = M.emptyDB();
  base.accounts = [{
    id: "a1", syncId: "acct-1", name: "Everyday Checking", institution: "Wells Fargo",
    type: "checking", balance: 100000, currency: "USD", syncSource: "simplefin",
    balanceDate: "2026-09-01", history: [{ date: "2026-09-01", balance: 100000 }],
  }];
  const env = await C.encryptDocument(base, at);
  await asServer({ doc: env, baseVersion: 0 }, "PUT");

  // the job's side: it has the public key from the envelope and nothing else
  const payload = {
    fetchedAt: new Date().toISOString(),
    accounts: [{ syncId: "acct-1", name: "Everyday Checking", institution: "Wells Fargo",
      type: "checking", balance: 95000, currency: "USD", balanceDate: "2026-09-02" }],
    transactions: [{ syncId: "tx-9", accountSyncId: "acct-1", date: "2026-09-02",
      amount: -5000, description: "COSTCO GAS #1234", pending: false }],
    errors: [],
  };
  const id = await M.queuePull(await C.sealTo(env.pub, JSON.stringify(payload)));
  assert.ok(id > 0);

  // what the server can see of it
  const rows = await M.readQueue();
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("COSTCO GAS"), false,
    "the queued pull must be opaque to the server that stored it");

  // the browser's side
  const drained = await M.applyQueue(base, rows, at.priv);
  assert.equal(drained.unreadable, 0);
  assert.equal(drained.transactionsAdded, 1);
  assert.deepEqual(drained.ids, [id]);
  assert.equal(drained.db.transactions.some((t) => /costco/i.test(t.merchant)), true);
  assert.match(M.drainSummary(drained), /1 new transaction/);

  // and once saved, the queue is cleared
  assert.equal(await M.clearQueue(drained.ids), 1);
  assert.deepEqual(await M.readQueue(), []);
});

await test("a queued pull applied twice does not double up", async () => {
  // The queue is only acknowledged after the save lands, so a failure in
  // between means the same rows are applied again on the next poll.
  await wipe();
  const at = await unlockCheap(null);
  const base = M.emptyDB();
  base.accounts = [{
    id: "a1", syncId: "acct-1", name: "Checking", institution: "Bank",
    type: "checking", balance: 100000, currency: "USD", syncSource: "simplefin",
    balanceDate: "2026-09-01", history: [{ date: "2026-09-01", balance: 100000 }],
  }];
  const payload = {
    fetchedAt: new Date().toISOString(), errors: [],
    accounts: [{ syncId: "acct-1", name: "Checking", institution: "Bank",
      type: "checking", balance: 95000, currency: "USD", balanceDate: "2026-09-02" }],
    transactions: [{ syncId: "tx-9", accountSyncId: "acct-1", date: "2026-09-02", amount: -5000, description: "COSTCO GAS #1234", pending: false }],
  };
  const rows = [{ id: 1, createdAt: "", ...(await C.sealTo(at.pub, JSON.stringify(payload))) }];

  const once = await M.applyQueue(base, rows, at.priv);
  const twice = await M.applyQueue(once.db, rows, at.priv);
  assert.equal(once.transactionsAdded, 1);
  assert.equal(twice.transactionsAdded, 0, "the second pass must add nothing");
  assert.equal(twice.db.transactions.length, 1);
});

await test("a queued pull nobody can open is left alone rather than thrown away", async () => {
  await wipe();
  const mine = await unlockCheap(null);
  const stranger = await unlockCheap(null);
  const rows = [{ id: 7, createdAt: "", ...(await C.sealTo(stranger.pub, JSON.stringify({ transactions: [], accounts: [], errors: [] }))) }];

  const out = await M.applyQueue(M.emptyDB(), rows, mine.priv);
  assert.equal(out.unreadable, 1);
  assert.deepEqual(out.ids, [], "an unreadable row must not be acknowledged, or it would be deleted");
});

await test("the queue endpoints round-trip through the real handler", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await wipe(); await clearAttempts();
  const at = await unlockCheap(null);
  const id = await M.queuePull(await C.sealTo(at.pub, "overnight"));

  const listed = JSON.parse((await asServer({ action: "queue" })).text);
  assert.equal(listed.queued.length, 1);
  assert.equal(await C.openFrom(at.priv, listed.queued[0]), "overnight");

  const acked = JSON.parse((await asServer({ action: "queue_ack", ids: [id] })).text);
  assert.equal(acked.cleared, 1);
  assert.deepEqual(JSON.parse((await asServer({ action: "queue" })).text).queued, []);
});

await test("the queue does not grow without bound if nobody opens the app", async () => {
  await wipe();
  const at = await unlockCheap(null);
  await M.queuePull(await C.sealTo(at.pub, "recent"));
  const old = await M.queuePull(await C.sealTo(at.pub, "ancient"));

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("UPDATE sync_queue SET created_at = now() - interval '60 days' WHERE id = $1", [old]);
  await c.end();

  assert.equal(await M.trimQueue(30), 1);
  const left = await M.readQueue();
  assert.equal(left.length, 1);
  assert.equal(await C.openFrom(at.priv, left[0]), "recent");
});


const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};

const BRIDGE = JSON.stringify({
  errors: [],
  accounts: [{
    id: "sfin-1", name: "Everyday Checking", currency: "USD", balance: "950.00",
    "balance-date": Math.floor(Date.parse("2026-09-02T00:00:00Z") / 1000),
    org: { name: "Wells Fargo", domain: "wellsfargo.com" },
    transactions: [{ id: "sfin-tx-1", posted: Math.floor(Date.parse("2026-09-02T00:00:00Z") / 1000), amount: "-50.00", description: "COSTCO GAS #1234" }],
  }],
});

await test("the scheduled job never writes over an encrypted document", async () => {
  // The one outcome that would be unrecoverable: merging a plaintext document
  // on top of the envelope and destroying it.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  process.env.SIMPLEFIN_ACCESS_URL = "https://u:p@bridge.example/accounts";
  await wipe(); await clearAttempts();

  const at = await unlockCheap(null);
  const env = await C.encryptDocument(M.buildDemoDB(), at);
  await asServer({ doc: env, baseVersion: 0 }, "PUT");
  const versionBefore = JSON.parse((await asServer(undefined, "GET")).text).version;

  const r = await withFetch(
    async () => new Response(BRIDGE, { status: 200 }),
    () => invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.1" } }));

  const body = JSON.parse(r.text);
  assert.equal(r.status, 200);
  assert.equal(body.encrypted, true, "the job has to notice the document is sealed");
  assert.ok(body.queued > 0, "and leave its pull in the queue instead");

  // the document itself must be exactly as it was
  const after = JSON.parse((await asServer(undefined, "GET")).text);
  assert.equal(after.version, versionBefore, "the job must not have written the document at all");
  assert.deepEqual(after.doc, env, "byte for byte the same envelope");

  // and what it queued is readable only with the key
  const rows = await M.readQueue();
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("COSTCO"), false, "the queued pull must be opaque");
  const pulled = JSON.parse(await C.openFrom(at.priv, rows[0]));
  assert.equal(pulled.transactions.length, 1);
  assert.equal(pulled.transactions[0].description, "COSTCO GAS #1234");
});

await test("the job says what is missing rather than failing silently", async () => {
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  delete process.env.SIMPLEFIN_ACCESS_URL;
  await wipe(); await clearAttempts();

  const at = await unlockCheap(null);
  await asServer({ doc: await C.encryptDocument(M.emptyDB(), at), baseVersion: 0 }, "PUT");

  const r = await invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.2" } });
  const body = JSON.parse(r.text);
  assert.equal(body.ran, false);
  assert.match(body.reason, /SIMPLEFIN_ACCESS_URL/, "it must name the variable to set");
});

await test("an installation that never encrypted still syncs the old way", async () => {
  // Nothing here may break for someone who has not turned encryption on.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  await wipe(); await clearAttempts();

  const plain = M.emptyDB();
  plain.settings = { ...plain.settings, simplefinAccessUrl: "https://u:p@bridge.example/accounts" };
  await asServer({ doc: plain, baseVersion: 0 }, "PUT");

  const r = await withFetch(
    async () => new Response(BRIDGE, { status: 200 }),
    () => invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.3" } }));
  const body = JSON.parse(r.text);
  assert.equal(body.ran, true);
  assert.equal(body.encrypted, undefined, "the plaintext path is unchanged");
  assert.equal(body.transactionsAdded, 1, "and it still merges straight into the document");
  assert.deepEqual(await M.readQueue(), [], "with nothing queued");
});

await test("the scheduled job prices the holdings as well as the balances", async () => {
  // The point of doing it here: it works with every browser shut, at the same
  // hour the balances move, so a morning glance has both current.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  delete process.env.TIINGO_API_KEY;
  await wipe(); await clearAttempts();

  const plain = M.emptyDB();
  plain.settings = {
    ...plain.settings,
    simplefinAccessUrl: "https://u:p@bridge.example/accounts",
    tiingoApiKey: "tok",
  };
  plain.holdings = [
    { id: "h1", accountId: "a1", ticker: "VTI", name: "Total Market", quantity: 10, costBasis: 20000, price: 30000, assetClass: "us_equity" },
    { id: "h2", accountId: "a1", ticker: "ACME401K", name: "Company stock", quantity: 5, costBasis: 1000, price: 12345, assetClass: "us_equity" },
  ];
  await asServer({ doc: plain, baseVersion: 0 }, "PUT");

  const asked = [];
  const r = await withFetch(async (url) => {
    const href = String(url);
    if (href.includes("bridge.example")) return new Response(BRIDGE, { status: 200 });
    asked.push(href);
    return href.includes("/vti/")
      ? new Response(JSON.stringify([{ date: "2026-09-03T00:00:00.000Z", close: 312.44, adjClose: 156.22 }]), { status: 200 })
      : new Response("Not found", { status: 404 });
  }, () => invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.7" } }));

  const body = JSON.parse(r.text);
  assert.equal(r.status, 200);
  assert.equal(body.transactionsAdded, 1, "the balances still land");
  assert.equal(body.pricesUpdated, 1);
  assert.deepEqual(body.pricesMissed, ["ACME401K"]);
  assert.equal(asked.length, 2, "one request per symbol, no more");

  const after = JSON.parse((await asServer(undefined, "GET")).text).doc;
  assert.equal(after.holdings.find((h) => h.id === "h1").price, 31244, "the quoted holding moved");
  assert.equal(after.holdings.find((h) => h.id === "h2").price, 12345, "the unquoted one kept what was typed in");
  assert.ok(after.settings.lastPricesAt, "and the clock was stamped");
});

await test("a bridge that is down still gets the day's prices written", async () => {
  // The two halves fail independently: one provider being unreachable must not
  // silently cost the other. The run still answers 502 so it shows in the log.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  await wipe(); await clearAttempts();

  const plain = M.emptyDB();
  plain.settings = {
    ...plain.settings,
    simplefinAccessUrl: "https://u:p@bridge.example/accounts",
    tiingoApiKey: "tok",
  };
  plain.holdings = [{ id: "h1", accountId: "a1", ticker: "VTI", name: "Total Market", quantity: 10, costBasis: 20000, price: 30000, assetClass: "us_equity" }];
  await asServer({ doc: plain, baseVersion: 0 }, "PUT");

  const r = await withFetch(async (url) => {
    if (String(url).includes("bridge.example")) throw new Error("bridge unreachable");
    return new Response(JSON.stringify([{ date: "2026-09-03T00:00:00.000Z", close: 312.44 }]), { status: 200 });
  }, () => invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.8" } }));

  const body = JSON.parse(r.text);
  assert.equal(r.status, 502, "the bridge failure must still be visible");
  assert.match(body.error, /bridge unreachable/);
  assert.equal(body.pricesUpdated, 1, "and the prices must have landed anyway");

  const after = JSON.parse((await asServer(undefined, "GET")).text).doc;
  assert.equal(after.holdings[0].price, 31244);
});

await test("a rejected price token does not stamp the clock", async () => {
  // Stamping it would put the next attempt a day away from noticing the token
  // had been fixed.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  await wipe(); await clearAttempts();

  const plain = M.emptyDB();
  plain.settings = { ...plain.settings, tiingoApiKey: "revoked" };
  plain.holdings = [{ id: "h1", accountId: "a1", ticker: "VTI", name: "Total Market", quantity: 10, costBasis: 20000, price: 30000, assetClass: "us_equity" }];
  await asServer({ doc: plain, baseVersion: 0 }, "PUT");
  const versionBefore = JSON.parse((await asServer(undefined, "GET")).text).version;

  const r = await withFetch(
    async () => new Response("Unauthorized", { status: 401 }),
    () => invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.9" } }));

  const body = JSON.parse(r.text);
  assert.equal(body.ran, false);
  assert.match(body.reason, /rejected the API key/);

  const after = JSON.parse((await asServer(undefined, "GET")).text);
  assert.equal(after.version, versionBefore, "a run that did nothing must not write");
  assert.equal(after.doc.settings.lastPricesAt, undefined);
  assert.equal(after.doc.holdings[0].price, 30000);
});

await test("the job leaves an encrypted document's prices to the browser", async () => {
  // Same reason the pull is queued rather than merged: the ticker list is
  // inside the envelope, and this job cannot open it.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  process.env.CRON_SECRET = "cron-secret-value";
  process.env.SIMPLEFIN_ACCESS_URL = "https://u:p@bridge.example/accounts";
  process.env.TIINGO_API_KEY = "tok";
  await wipe(); await clearAttempts();

  const at = await unlockCheap(null);
  const env = await C.encryptDocument(M.buildDemoDB(), at);
  await asServer({ doc: env, baseVersion: 0 }, "PUT");

  let pricesAsked = 0;
  const r = await withFetch(async (url) => {
    if (String(url).includes("bridge.example")) return new Response(BRIDGE, { status: 200 });
    pricesAsked += 1;
    return new Response("[]", { status: 200 });
  }, () => invokeWith(M.cronHandler2, { headers: { authorization: "Bearer cron-secret-value", "x-real-ip": "10.0.0.10" } }));

  assert.equal(JSON.parse(r.text).encrypted, true);
  assert.equal(pricesAsked, 0, "it cannot know the tickers, so it must not guess");
  delete process.env.TIINGO_API_KEY;
});

await test("a browser without the key cannot overwrite the encrypted document", async () => {
  // The dangerous case: a device that is connected to the API but has never
  // been unlocked still holds a plaintext copy in localStorage. If an edit
  // there could be saved as-is, it would strip the encryption off everyone
  // else's document and replace it with whatever that device happened to have.
  process.env.SYNC_PASSPHRASE = "the-right-one";
  await wipe(); await clearAttempts();

  const at = await unlockCheap(null);
  const real = M.buildDemoDB();
  await asServer({ doc: await C.encryptDocument(real, at), baseVersion: 0 }, "PUT");
  const before = JSON.parse((await asServer(undefined, "GET")).text);

  const refused = await asServer({ doc: { transactions: [], accounts: [] }, baseVersion: before.version }, "PUT");
  assert.equal(refused.status, 409, "a plaintext save over an envelope has to be refused");
  assert.match(JSON.parse(refused.text).error, /encrypted/i);

  const after = JSON.parse((await asServer(undefined, "GET")).text);
  assert.deepEqual(after.doc, before.doc, "and the envelope must be untouched");
  assert.equal(after.version, before.version);
});

/* ── results, always last so every test above is reported ─────────────── */
for (const [state, name, msg] of results) console.log(`${state}  ${name}${msg ? ` — ${msg}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
/**
 * Two devices, one encrypted budget.
 *
 * The one scenario nothing else here can reach: it needs a real database, the
 * real API, a real browser, and a *second* browser that has never seen the
 * first. Every piece was individually tested and the join between them was
 * still broken — connecting a new phone to an encrypted budget wiped the sync
 * passphrase it had just accepted, which left the Encryption card saying to go
 * and connect and the Sync card saying to go and decrypt, with no way out of
 * either. The unit tests were green throughout.
 *
 *   createdb sovereign_e2e
 *   DATABASE_URL=... SYNC_PASSPHRASE=... npm run dev -- --port 5273
 *   DATABASE_URL=... APP_URL=http://localhost:5273 SYNC_PASSPHRASE=... npm run test:e2e
 *
 * Skipped, not failed, when any of that is missing — the same as the database
 * tests, so it costs a contributor nothing to run the rest.
 */
const APP = process.env.APP_URL ?? "http://localhost:5273";
const SYNC = process.env.SYNC_PASSPHRASE ?? "";
const CHROME = process.env.CHROME_PATH;
const CRYPT = "correct horse battery staple";

const skip = (why, how) => { console.log(`SKIP  ${why}`); if (how) console.log(`      ${how}`); process.exit(0); };

if (!SYNC) skip("no SYNC_PASSPHRASE — the two-device flow was not checked", "SYNC_PASSPHRASE=... npm run test:e2e");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  skip("playwright is not installed — the two-device flow was not checked", "npm i -D playwright");
}

try {
  const res = await fetch(APP, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  skip(`nothing is serving ${APP} — the two-device flow was not checked`, "npm run dev -- --port 5273");
}

// The document has to start empty, or the first device joins someone else's
// budget and encrypts nothing.
if (process.env.DATABASE_URL) {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { await pool.query("TRUNCATE budget_document"); } catch { /* not created yet */ }
  await pool.end();
} else {
  skip("no DATABASE_URL — cannot clear the document, so the flow was not checked");
}

const results = [];
const check = (name, ok, detail = "") => results.push([ok ? "PASS" : "FAIL", name, ok ? "" : detail]);

/**
 * A step that is allowed to be impossible.
 *
 * Against the broken version there is no unlock box to click, and a locator
 * timing out would abandon the run with a stack trace instead of the list of
 * what passed and what did not — which is exactly the moment the list matters.
 */
const tryStep = async (what, fn) => {
  try { await fn(); return true; } catch (err) {
    results.push(["FAIL", what, (err instanceof Error ? err.message : String(err)).split("\n")[0]]);
    return false;
  }
};

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

/** A card by its heading — "Bank sync" has a Connect button too. */
const card = (page, heading) =>
  page.locator(".card").filter({ has: page.locator("h2,h3", { hasText: new RegExp(`^${heading}$`) }) });

const textOf = (page, heading) => page.evaluate((h) => {
  const c = [...document.querySelectorAll(".card")].find((x) => x.querySelector("h2,h3")?.textContent?.trim() === h);
  return c ? c.innerText.replace(/\s+/g, " ").trim() : "";
}, heading);

const settings = async (ctx) => {
  const page = await ctx.newPage();
  await page.goto(`${APP}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return page;
};

try {
  // ── the first device: connect, then turn encryption on ──
  const first = await browser.newContext({ viewport: { width: 900, height: 1300 } });
  const a = await settings(first);
  await card(a, "Sync across devices").locator('input[type="password"]').fill(SYNC);
  await card(a, "Sync across devices").locator('button:text-is("Connect")').click();
  await a.waitForTimeout(1800);

  const boxes = await card(a, "Encryption").locator('input[type="password"]').all();
  check("the first device is offered encryption once it is connected", boxes.length === 2,
    `saw ${boxes.length} passphrase boxes`);
  for (const f of boxes) await f.fill(CRYPT);
  await tryStep("the first device can start encrypting", () =>
    card(a, "Encryption").locator("button").filter({ hasText: /Encrypt everything/i }).first()
      .click({ timeout: 5000 }));
  await a.waitForTimeout(2500);
  check("the first device reports end-to-end encryption",
    (await textOf(a, "Encryption")).includes("End-to-end encrypted"),
    (await textOf(a, "Encryption")).slice(0, 90));

  // ── the second device: a phone that has never connected ──
  const second = await browser.newContext({ viewport: { width: 390, height: 1500 } });
  const p = await settings(second);

  // Claiming a document is in the clear without having looked at one is worse
  // than saying nothing, because the thing being claimed is someone's privacy.
  const before = await textOf(p, "Encryption");
  check("a device that has not looked does not claim the budget is unencrypted",
    !before.includes("Stored in the clear"), before.slice(0, 90));

  await card(p, "Sync across devices").locator('input[type="password"]').fill(SYNC);
  await card(p, "Sync across devices").locator('button:text-is("Connect")').click();
  await p.waitForTimeout(2500);

  // The whole bug: the sync passphrase was right and was thrown away anyway.
  const kept = await p.evaluate(() => localStorage.getItem("sovereign.cloud.pass"));
  check("connecting to an encrypted budget keeps the sync passphrase it accepted", !!kept,
    "the passphrase was cleared, which is what made this a dead end");

  const locked = await textOf(p, "Encryption");
  check("the second device says it is locked rather than telling you to connect",
    locked.includes("Locked on this browser") && !locked.includes("Connect this browser"),
    locked.slice(0, 120));

  const unlockBox = card(p, "Encryption").locator('input[type="password"]');
  check("there is somewhere on this device to type the encryption passphrase",
    await unlockBox.count() > 0, "no unlock box was rendered");

  // And it has to survive a reload, or the way out lasts one render.
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  check("the way in is still there after a reload",
    (await textOf(p, "Encryption")).includes("Locked on this browser"),
    (await textOf(p, "Encryption")).slice(0, 90));

  // ── and it actually opens ──
  await tryStep("the second device can be unlocked from its own screen", async () => {
    await card(p, "Encryption").locator('input[type="password"]').first().fill(CRYPT, { timeout: 5000 });
    await card(p, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click({ timeout: 5000 });
  });
  await p.waitForTimeout(3000);

  check("the encryption passphrase opens the budget on the second device",
    (await textOf(p, "Encryption")).includes("End-to-end encrypted"),
    (await textOf(p, "Encryption")).slice(0, 90));
  check("syncing resumes once it is unlocked",
    (await textOf(p, "Sync across devices")).includes("This browser is syncing"),
    (await textOf(p, "Sync across devices")).slice(0, 120));

  const loaded = await p.evaluate(() => {
    const raw = localStorage.getItem("sovereign.db.v1");
    return raw ? JSON.parse(raw).transactions.length : 0;
  });
  check("the budget itself arrived, not just the padlock", loaded > 0, `${loaded} transactions`);

  // ── a right passphrase must not be reported as a wrong one ──
  //
  // Everything after the decryption can fail for reasons that have nothing to
  // do with the passphrase — the network dropped, the address is being timed
  // out — and all of it used to come back as "that passphrase doesn't open
  // this document", while discarding the key it had just correctly derived.
  const flaky = await browser.newContext({ viewport: { width: 390, height: 1500 } });
  const f = await settings(flaky);
  await card(f, "Sync across devices").locator('input[type="password"]').fill(SYNC);
  await card(f, "Sync across devices").locator('button:text-is("Connect")').click();
  await f.waitForTimeout(2500);
  await tryStep("a passphrase can be typed on the flaky device", () =>
    card(f, "Encryption").locator('input[type="password"]').first().fill(CRYPT, { timeout: 5000 }));
  // The peek has already happened; everything from the unlock onwards fails.
  await f.route("**/api/db", (route) => route.fulfill({
    status: 429, contentType: "application/json",
    body: JSON.stringify({ error: "Too many attempts from this address. Try again in 15 minutes." }),
  }));
  await tryStep("the flaky device can press unlock", () =>
    card(f, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click({ timeout: 5000 }));
  await f.waitForTimeout(3000);

  const flakyText = await textOf(f, "Encryption");
  check("a correct passphrase is not blamed when the server is the problem",
    !flakyText.includes("That passphrase doesn't open this document"), flakyText.slice(0, 140));
  check("it says what actually went wrong instead",
    flakyText.includes("could not be fetched") && flakyText.includes("Too many attempts"),
    flakyText.slice(0, 160));
  check("the key it correctly derived is kept rather than thrown away",
    await f.evaluate(() => new Promise((res) => {
      const r = indexedDB.open("sovereign.vault", 1);
      r.onsuccess = () => {
        const q = r.result.transaction("keys", "readonly").objectStore("keys").get("current");
        q.onsuccess = () => res(!!q.result);
        q.onerror = () => res(false);
      };
      r.onerror = () => res(false);
    })), "the vault was emptied after a successful decryption");

  // A wrong passphrase must not look like a right one.
  const third = await browser.newContext({ viewport: { width: 390, height: 1500 } });
  const w = await settings(third);
  await card(w, "Sync across devices").locator('input[type="password"]').fill(SYNC);
  await card(w, "Sync across devices").locator('button:text-is("Connect")').click();
  await w.waitForTimeout(2500);
  await tryStep("a wrong passphrase can at least be typed in", async () => {
    await card(w, "Encryption").locator('input[type="password"]').first()
      .fill("not the passphrase at all", { timeout: 5000 });
    await card(w, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click({ timeout: 5000 });
  });
  await w.waitForTimeout(2000);
  const wrong = await textOf(w, "Encryption");
  check("a wrong encryption passphrase is refused and says so",
    wrong.includes("doesn't open this document") && !wrong.includes("End-to-end encrypted"),
    wrong.slice(0, 120));
  // ── a forgotten passphrase is not a lost budget ──
  //
  // The server's ratchet will not let a readable document replace a sealed
  // one, which is right, and which is exactly why there has to be a way to
  // seal it again — otherwise someone whose passphrase is gone is left looking
  // at their own budget with nowhere to save it.
  const RESEAL = "a brand new one they will write down";
  const forgot = await browser.newContext({ viewport: { width: 950, height: 1500 } });
  const g = await settings(forgot);
  await card(g, "Sync across devices").locator('input[name="sovereign-sync"]').fill(SYNC);
  await card(g, "Sync across devices").locator('button:text-is("Connect")').click();
  await g.waitForTimeout(2500);
  await tryStep("the forgetful device can unlock once", async () => {
    await card(g, "Encryption").locator('input[name="sovereign-encryption-unlock"]').fill(CRYPT, { timeout: 5000 });
    await card(g, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click({ timeout: 5000 });
  });
  await g.waitForTimeout(2500);

  const held = await g.evaluate(() => JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions.length);
  await tryStep("the key can be forgotten", async () => {
    await card(g, "Encryption").locator("button").filter({ hasText: /Forget the key/i }).click({ timeout: 5000 });
    await card(g, "Encryption").locator("button").filter({ hasText: /Click again to forget/i }).click({ timeout: 5000 });
  });
  await g.waitForTimeout(1500);

  // The reassurance the whole recovery rests on.
  check("forgetting the key does not touch this browser's own copy",
    await g.evaluate(() => JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions.length) === held,
    "the local budget changed when the key was forgotten");

  await tryStep("there is a way out offered", () =>
    card(g, "Encryption").locator("summary", { hasText: "Lost the passphrase" }).click({ timeout: 5000 }));
  await tryStep("a new passphrase can be set from a locked browser", async () => {
    await card(g, "Encryption").locator('input[name="sovereign-encryption-reseal"]').fill(RESEAL, { timeout: 5000 });
    await card(g, "Encryption").locator('input[name="sovereign-encryption-reseal-again"]').fill(RESEAL, { timeout: 5000 });
    await card(g, "Encryption").locator("button").filter({ hasText: /^Seal again/ }).click({ timeout: 5000 });
    await card(g, "Encryption").locator("button").filter({ hasText: /the old copy goes/ }).click({ timeout: 5000 });
  });
  await g.waitForTimeout(3000);
  check("sealing again succeeds even though the old copy could not be read",
    (await textOf(g, "Encryption")).includes("End-to-end encrypted"),
    (await textOf(g, "Encryption")).slice(0, 110));
  check("the budget survived being sealed again",
    await g.evaluate(() => JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions.length) === held,
    "the local budget changed while re-sealing");

  // And the new passphrase is the one that works now, on a device that has
  // never seen either.
  const after = await browser.newContext({ viewport: { width: 390, height: 1500 } });
  const n = await settings(after);
  await card(n, "Sync across devices").locator('input[name="sovereign-sync"]').fill(SYNC);
  await card(n, "Sync across devices").locator('button:text-is("Connect")').click();
  await n.waitForTimeout(2500);
  await tryStep("the old passphrase can be tried", async () => {
    await card(n, "Encryption").locator('input[name="sovereign-encryption-unlock"]').fill(CRYPT, { timeout: 5000 });
    await card(n, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click({ timeout: 5000 });
  });
  await n.waitForTimeout(2500);
  check("the passphrase that sealed the old copy no longer opens the new one",
    (await textOf(n, "Encryption")).includes("That passphrase doesn't open this document"),
    (await textOf(n, "Encryption")).slice(0, 110));
  await tryStep("the new passphrase can be tried", async () => {
    await card(n, "Encryption").locator('input[name="sovereign-encryption-unlock"]').fill(RESEAL, { timeout: 5000 });
    await card(n, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click({ timeout: 5000 });
  });
  await n.waitForTimeout(3000);
  check("the new passphrase opens it on a device that has seen neither",
    (await textOf(n, "Encryption")).includes("End-to-end encrypted"),
    (await textOf(n, "Encryption")).slice(0, 110));
  check("and that device gets the whole budget",
    await n.evaluate(() => JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions.length) === held,
    "the recovered budget is a different size");
} finally {
  await browser.close();
}

for (const [status, name, msg] of results) console.log(status.padEnd(5), name, msg ? `— ${msg}` : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

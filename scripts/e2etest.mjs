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

  // ── the setup flow: four steps, and the gates between them ──
  check("setting up encryption starts by saying which passphrase this is not",
    (await textOf(a, "Encryption")).includes("Do not reuse your SYNC_PASSPHRASE"),
    (await textOf(a, "Encryption")).slice(0, 120));

  await tryStep("the first step can be got past", () =>
    card(a, "Encryption").locator('button:has-text("Understood")').click({ timeout: 5000 }));
  await a.waitForTimeout(400);

  // The backup was a suggestion beside the confirm button, and went unpressed.
  check("the backup is a gate, not a suggestion",
    await card(a, "Encryption").locator('button:text-is("Next")').isDisabled(),
    "Next was available without taking a backup");
  const downloaded = a.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await tryStep("the backup can be taken", () =>
    card(a, "Encryption").locator('button:has-text("Download the backup")').click({ timeout: 5000 }));
  const file = await downloaded;
  check("pressing it really downloads a file", !!file, "no download happened");
  await a.waitForTimeout(400);
  check("and that opens the way on",
    !(await card(a, "Encryption").locator('button:text-is("Next")').isDisabled()),
    "Next stayed disabled after a backup");

  await tryStep("the choose step is reachable", () =>
    card(a, "Encryption").locator('button:text-is("Next")').click({ timeout: 5000 }));
  await a.waitForTimeout(400);
  await tryStep("a phrase is offered", () =>
    card(a, "Encryption").locator("code.statement").waitFor({ timeout: 5000 }));
  const offered = await card(a, "Encryption").locator("code.statement").textContent().catch(() => "");
  check("the offered phrase is six words nobody had to invent",
    (offered ?? "").split("-").length === 6, `saw "${offered}"`);

  await tryStep("the confirm step is reachable", () =>
    card(a, "Encryption").locator('button:has-text("I have written it down")').click({ timeout: 5000 }));
  await a.waitForTimeout(400);
  check("the confirmation box starts empty rather than pre-filled",
    (await card(a, "Encryption").locator('input[name="sovereign-encryption-confirm"]')
      .inputValue().catch(() => "x")) === "",
    "the box was pre-filled, which would confirm nothing");

  // The exact mistake that started all of this.
  await tryStep("the sync passphrase can be typed by mistake", async () => {
    await card(a, "Encryption").locator('input[name="sovereign-encryption-confirm"]').fill(SYNC, { timeout: 5000 });
    await card(a, "Encryption").locator('button:has-text("Encrypt everything")').click({ timeout: 5000 });
  });
  await a.waitForTimeout(1200);
  check("typing the sync passphrase at the confirm step is refused",
    (await textOf(a, "Encryption")).includes("not the same phrase")
      && !(await textOf(a, "Encryption")).includes("End-to-end encrypted"),
    (await textOf(a, "Encryption")).slice(0, 140));

  // Its own phrase is the one that seals it. CRYPT stands in so the rest of
  // the suite has a passphrase it knows.
  await tryStep("the first device can start encrypting", async () => {
    await card(a, "Encryption").locator('button:has-text("Show it to me again")').click({ timeout: 5000 });
    await card(a, "Encryption").locator('button:has-text("Use my own")').click({ timeout: 5000 });
    await card(a, "Encryption").locator('input[name="sovereign-encryption-new"]').fill(CRYPT, { timeout: 5000 });
    await card(a, "Encryption").locator('button:has-text("I have written it down")').click({ timeout: 5000 });
    await card(a, "Encryption").locator('input[name="sovereign-encryption-confirm"]').fill(CRYPT, { timeout: 5000 });
    await card(a, "Encryption").locator('button:has-text("Encrypt everything")').click({ timeout: 5000 });
  });
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

  // ── what two tabs left open actually cost ──────────────────────────────
  //
  // This is a bill, not a bug report, which is why it went unnoticed for
  // months: everything worked. The poll fetched the whole document once a
  // minute to compare a version number, and a pull handed the store a freshly
  // parsed object that the save effect could not tell from a typed edit, so
  // each tab pushed back what it had just been given and gave the other tab
  // something new to fetch. Two idle tabs moved about 640 MB a day in each
  // direction and exhausted a month of database transfer in two days.
  //
  // Playwright's clock makes the minute-long poll instant, so the traffic is
  // measured rather than reasoned about.
  // Every device from the sections above is still open and still polling on a
  // real timer. They would push their own copy over the top of what this
  // section is measuring, and their traffic would be counted as it.
  for (const ctx of [first, second, flaky, third, forgot, after]) await ctx.close();

  const meter = [];
  const openTab = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 } });
    const page = await ctx.newPage();
    await page.clock.install();
    await page.goto(`${APP}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await card(page, "Sync across devices").locator('input[name="sovereign-sync"]').fill(SYNC);
    await card(page, "Sync across devices").locator('button:text-is("Connect")').click();
    await page.waitForTimeout(2000);
    await card(page, "Encryption").locator('input[name="sovereign-encryption-unlock"]').fill(RESEAL);
    await card(page, "Encryption").locator("button").filter({ hasText: /Unlock/i }).first().click();
    await page.waitForTimeout(2500);
    await page.clock.fastForward("00:20");
    await page.waitForTimeout(2500);
    page.on("response", async (res) => {
      if (!res.url().includes("/api/db")) return;
      let bytes = 0;
      try { bytes = (await res.body()).length; } catch { /* aborted */ }
      meter.push({
        label, method: res.request().method(),
        meta: res.url().includes("meta=1"),
        down: bytes, up: res.request().postData()?.length ?? 0,
      });
    });
    return page;
  };

  const t1 = await openTab("one");
  const t2 = await openTab("two");
  // Let them agree with the server first — the second tab's own arrival is a
  // change the first one has to fetch, and that is not idle traffic.
  for (let i = 0; i < 3; i++) {
    await t1.clock.fastForward("01:00");
    await t2.clock.fastForward("01:00");
    await t1.waitForTimeout(1200);
  }
  meter.length = 0;

  const POLLS = 8;
  for (let i = 0; i < POLLS; i++) {
    await t1.clock.fastForward("01:00");
    await t2.clock.fastForward("01:00");
    await t1.waitForTimeout(800);
  }
  const down = meter.reduce((x, r) => x + r.down, 0);
  const up = meter.reduce((x, r) => x + r.up, 0);
  const perDay = ((down + up) / POLLS) * 1440;

  const fetchedDoc = (r) => r.method === "GET" && !r.meta;
  check("an idle tab asks for the version, not the document",
    !meter.some(fetchedDoc),
    meter.filter(fetchedDoc).map((r) => `${r.label} fetched ${(r.down / 1024).toFixed(0)} KB`).join(", ") || "none");
  check("two idle tabs do not push the document back and forth at each other",
    up < 4096, `${(up / 1024).toFixed(0)} KB was uploaded by tabs nobody touched`);
  check("a day of two idle tabs costs kilobytes, not hundreds of megabytes",
    perDay < 5e6, `${(perDay / 1e6).toFixed(1)} MB/day`);

  // The saving is worthless if a real change stops arriving.
  await t1.locator('input[name="sovereign-household"]').fill("Changed on the first tab");
  await t1.waitForTimeout(600);
  await t1.clock.fastForward("00:10");
  await t1.waitForTimeout(2500);
  await t2.clock.fastForward("01:00");
  await t2.waitForTimeout(3000);
  const crossed = await t2.evaluate(() => JSON.parse(localStorage.getItem("sovereign.db.v1")).settings.householdName);
  check("an edit on one tab still reaches the other", crossed === "Changed on the first tab", crossed);

  // Typed in the second before the tab has finished reconciling with the
  // server. This used to be dropped: the save effect stood down until first
  // contact was over and never marked the edit as unsent, so nothing pushed
  // it and the next change from elsewhere wrote over it.
  // The handshake is held open on purpose, or it finishes before anyone could
  // realistically have typed and the test proves nothing.
  let firstHandshake = true;
  const meta1 = (url) => url.href.includes("/api/db") && url.href.includes("meta=1");
  await t1.route(meta1, async (route) => {
    if (firstHandshake) { firstHandshake = false; await new Promise((r) => setTimeout(r, 5000)); }
    await route.continue();
  });
  await t1.reload({ waitUntil: "domcontentloaded" });
  await t1.locator('input[name="sovereign-household"]').fill("Typed during the handshake", { timeout: 8000 });
  await t1.waitForTimeout(600);
  await t1.clock.fastForward("00:10");
  await t1.waitForTimeout(6000);
  await t1.unroute(meta1);
  // Whatever the timing did to the debounce, the poll has to flush it.
  await t1.clock.fastForward("01:00");
  await t1.waitForTimeout(3000);
  await t2.clock.fastForward("01:00");
  await t2.waitForTimeout(3000);
  const early = await t2.evaluate(() => JSON.parse(localStorage.getItem("sovereign.db.v1")).settings.householdName);
  check("an edit typed before the tab has finished syncing is not dropped",
    early === "Typed during the handshake", early);

  // And they settle again rather than resuming the loop.
  meter.length = 0;
  for (let i = 0; i < 4; i++) {
    await t1.clock.fastForward("01:00");
    await t2.clock.fastForward("01:00");
    await t1.waitForTimeout(800);
  }
  check("and the tabs go quiet again afterwards",
    !meter.some(fetchedDoc) && meter.every((r) => r.up < 4096),
    meter.filter((r) => fetchedDoc(r) || r.up).map((r) => `${r.label} ${r.method} ${r.down + r.up}B`).join(", ") || "none");
} finally {
  await browser.close();
}

for (const [status, name, msg] of results) console.log(status.padEnd(5), name, msg ? `— ${msg}` : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

/**
 * What is actually visible at each width.
 *
 * The responsive rules in index.css are a single ordered section, which stops
 * an override losing to its own base rule on source order. It does not stop one
 * losing on *specificity* — an element-qualified base rule beats a plain-class
 * override wherever it sits, and that is exactly how the account mark once
 * leaked onto phones and wrapped every transaction onto two lines.
 *
 * So this asserts the outcome rather than the rules: at every width the app
 * claims to support, which columns are showing, and whether anything runs off
 * the edge. It needs a built dist and a preview server:
 *
 *   npm run build && npm run preview -- --port 4173
 *   node scripts/breakpoints.mjs
 */
const BASE = process.env.PREVIEW_URL ?? "http://localhost:4173";
const CHROME = process.env.CHROME_PATH;

// Playwright is not a dependency of this project — it pulls a browser down with
// it and every Vercel build would pay for that. Skipped rather than failed when
// it is absent, the same way the database tests skip without a DATABASE_URL.
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("SKIP  playwright is not installed — the breakpoints were not checked");
  console.log("      npm i -D playwright && npx playwright install chromium");
  process.exit(0);
}

// A preview server has to be up, and it has to be serving a build that includes
// whatever is being tested. Saying so beats a wall of connection refusals.
try {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.log(`SKIP  nothing is serving ${BASE} — the breakpoints were not checked`);
  console.log("      npm run build && npm run preview -- --port 4173");
  process.exit(0);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push([ok ? "PASS" : "FAIL", name, ok ? "" : detail]);
};

/** Every page, so a rule meant for one screen can't quietly break another. */
const PAGES = [
  "/dashboard", "/transactions", "/budget", "/accounts", "/cashflow", "/reports",
  "/recurring", "/goals", "/investments", "/rules", "/categories", "/tags", "/settings",
];

/**
 * The transaction row is the most-overridden thing in the app — three
 * breakpoints change it — so its column set is spelled out rather than assumed.
 */
const TX_COLUMNS = [
  { w: 1440, cols: ["cb", "avatar", "merchant", "account", "category", "amount"] },
  { w: 1000, cols: ["cb", "avatar", "merchant", "account", "category", "amount"] },
  { w: 880, cols: ["cb", "avatar", "merchant", "category", "amount"] },
  { w: 700, cols: ["cb", "avatar", "merchant", "amount"] },
  { w: 390, cols: ["cb", "avatar", "merchant", "amount"] },
  { w: 320, cols: ["cb", "avatar", "merchant", "amount"] },
];

const nameOf = (el) => {
  const c = typeof el.className === "string" ? el.className : "";
  if (el.tagName === "INPUT") return "cb";
  if (c.includes("tx-account")) return "account";
  if (c.includes("tx-category")) return "category";
  if (c.includes("right")) return "amount";
  if (c.includes("avatar")) return "avatar";
  return "merchant";
};

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});

try {
  // ── the transaction row's columns, breakpoint by breakpoint ──
  for (const { w, cols } of TX_COLUMNS) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const seen = await page.evaluate((fn) => {
      const named = new Function("el", `return (${fn})(el)`);
      const row = document.querySelector(".tx-grid:not(.head)");
      if (!row) return null;
      const out = [];
      for (const child of row.children) {
        // display:contents children are the real grid items
        const items = getComputedStyle(child).display === "contents" ? [...child.children] : [child];
        for (const el of items) {
          if (getComputedStyle(el).display === "none") continue;
          out.push(named(el));
        }
      }
      return out;
    }, nameOf.toString());

    check(
      `${w}px — the transaction row shows ${cols.join(", ")}`,
      seen !== null && seen.join(",") === cols.join(","),
      `saw ${seen === null ? "no row at all" : seen.join(", ")}`,
    );

    // the header has to line up with the body, or the labels describe the
    // wrong columns — which is invisible until you read one
    const head = await page.evaluate(() =>
      [...document.querySelectorAll(".tx-grid.head")[0].children]
        .filter((el) => getComputedStyle(el).display !== "none").length);
    check(`${w}px — the header has as many cells as the row`, head === cols.length,
      `header ${head}, row ${cols.length}`);
    await page.close();
  }

  // ── nothing runs off the edge, anywhere ──
  for (const w of [320, 360, 390, 430, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    const over = [];
    for (const path of PAGES) {
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(280);
      const r = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth, vw: window.innerWidth,
      }));
      if (r.doc > r.vw) over.push(`${path} (${r.doc}px)`);
    }
    check(`${w}px — every page fits the viewport`, over.length === 0, `overflowing: ${over.join(", ")}`);
    await page.close();
  }

  // ── the phone keeps a way to reach the account ──
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  await phone.waitForTimeout(500);
  const sub = await phone.evaluate(() => {
    const a = document.querySelector("a.tx-sub-account");
    return a ? { text: a.innerText.trim(), href: a.getAttribute("href") } : null;
  });
  check("390px — the account is still reachable, as a name on the sub-line",
    !!sub && sub.text.length > 1 && /^\/accounts\//.test(sub.href ?? ""),
    `saw ${JSON.stringify(sub)}`);
  await phone.close();
} finally {
  await browser.close();
}

for (const [state, name, msg] of results) console.log(`${state}  ${name}${msg ? ` — ${msg}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

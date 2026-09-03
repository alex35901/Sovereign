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
  // The category drill-down carries a chart, a transaction list and two cards
  // side by side, which is the layout most likely to run off a phone.
  "/categories/c_groceries", "/categories/c_groceries?by=year",
  "/merchants/Amazon", "/merchants/Amazon?by=year",
  // A goal's own page: a wide header, four tiles, a chart and two columns.
  "/goals/gl_efund", "/goals/gl_kitchen",
];

/**
 * The transaction row is the most-overridden thing in the app — three
 * breakpoints change it — so its column set is spelled out rather than assumed.
 *
 * Matched on .list-row.tx-grid, not .tx-grid alone: the date header shares that
 * grid so the day's total lands in the amount column, and would otherwise be
 * the first thing the selector found.
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
  if (c.includes("tx-amount")) return "amount";
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
      const row = document.querySelector(".list-row.tx-grid:not(.head)");
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

  // ── the centred columns actually line up ──
  // Measured on the rendered text rather than the cell holding it: a header
  // cell can sit centred over its column while its label sits hard left, which
  // is exactly what justify-content alone did to "Category".
  const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await wide.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
  await wide.waitForTimeout(500);

  const aligned = await wide.evaluate(() => {
    const head = document.querySelector(".tx-grid.head");
    const row = document.querySelector(".list-row.tx-grid:not(.head)");
    const find = (parent, cls) => [...parent.children]
      .find((c) => (c.className || "").toString().includes(cls));
    const midText = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const b = r.getBoundingClientRect();
      return b.width ? (b.left + b.right) / 2 : null;
    };
    const midBox = (el) => {
      const b = el.getBoundingClientRect();
      return (b.left + b.right) / 2;
    };
    const out = {};
    for (const cls of ["tx-account", "tx-category", "tx-amount"]) {
      const h = find(head, cls);
      const c = find(row, cls);
      out[cls] = h && c ? Math.round(Math.abs((midText(h) ?? midBox(h)) - midBox(c))) : null;
    }
    // and every category pill the same width, or the column reads as ragged
    out.pillWidths = [...new Set([...document.querySelectorAll(".tx-category .chip")]
      .map((c) => Math.round(c.getBoundingClientRect().width)))];
    return out;
  });

  for (const cls of ["tx-account", "tx-category", "tx-amount"]) {
    check(`1440px — the ${cls.replace("tx-", "")} heading sits over its column`,
      aligned[cls] !== null && aligned[cls] <= 1, `drifts ${aligned[cls]}px`);
  }
  check("1440px — every category pill is the same width",
    aligned.pillWidths.length === 1, `saw widths ${aligned.pillWidths.join(", ")}`);
  await wide.close();

  // ── the "view category" arrow does not sit on top of the chip ──
  // It is pinned to the right edge of a cell whose chip is centred, so the
  // column has to leave 22px clear on *both* sides. It did not, at exactly the
  // widths between 900px and about 1200px where the column stops growing.
  for (const w of [1440, 1100, 950, 901]) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const row = document.querySelector(".list-row.tx-grid:not(.head)");
      const chip = row?.querySelector(".tx-category .chip");
      // Scoped to the category cell: the merchant's arrow shares the look and
      // would otherwise be the first thing found, at a wildly negative "gap".
      const arrow = row?.querySelector(".tx-category .tx-cat-open");
      if (!chip || !arrow) return null;
      const c = chip.getBoundingClientRect();
      const a = arrow.getBoundingClientRect();
      const cell = row.querySelector(".tx-category").getBoundingClientRect();
      const mo = row.querySelector(".tx-merchant-open");
      return {
        gap: Math.round(a.left - c.right),
        inside: a.right <= Math.round(cell.right) + 1,
        merchantPos: mo ? getComputedStyle(mo).position : "missing",
        merchantInline: !!mo && getComputedStyle(mo).position === "static",
      };
    });
    check(`${w}px — the view-merchant arrow is beside the name, in the flow`,
      m !== null && m.merchantInline, m === null ? "no arrow found" : `merchant arrow position ${m.merchantPos}`);
    check(`${w}px — the view-category arrow clears the pill`,
      m !== null && m.gap >= 0 && m.inside,
      m === null ? "no arrow found" : `gap ${m.gap}px, inside cell ${m.inside}`);
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

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
 *
 * Or one part of it, which is what to do while iterating on a single screen:
 *
 *   node scripts/breakpoints.mjs --only=detail
 *
 * Sections: tx-columns, tx-align, category-arrow, overflow, phone-account,
 * phone-nav, nested-menu, drilldown-back, drilldown-scroll, goals, detail, explain, recurring, notifications, retry, compress, budget, accounts, account-page, tx-filters, tx-select, dashboard, merchants, reports.
 * Push on a full run, always — a filter is for the loop, not for the verdict.
 */
const BASE = process.env.PREVIEW_URL ?? "http://localhost:4173";
const CHROME = process.env.CHROME_PATH;

// Playwright is not a dependency of this project — it pulls a browser down with
// it and every Vercel build would pay for that. Skipped rather than failed when
// it is absent, the same way the database tests skip without a DATABASE_URL.
let chromium;
/**
 * Which sections to run.
 *
 * The whole suite is nearly three minutes of real browsers, and most of any
 * one run is checking widths and screens that a given change cannot reach.
 * Mutation-testing a single dialog meant paying for all of it once per
 * mutation, which is how verifying one screen came to cost an hour of
 * wall clock. `--only=detail` runs the sections whose name contains "detail"
 * and skips the rest.
 *
 * A filtered run is never allowed to look like a full one: what was skipped is
 * printed with the results, because "69/69 passed" and "11/11 passed" are the
 * same sentence at a glance and only one of them means the app is fine.
 */
const ONLY = (process.argv.slice(2).find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length);
const skipped = [];
const want = (name) => {
  if (!ONLY || name.includes(ONLY)) return true;
  skipped.push(name);
  return false;
};

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

/**
 * A step that is allowed to be impossible.
 *
 * Against a broken build the thing to click is not there, and a locator timing
 * out would abandon the run with a stack trace instead of the list of what
 * passed and what did not — which is the moment the list matters most.
 */
const tryStep = async (what, fn) => {
  try { await fn(); return true; } catch (err) {
    results.push(["FAIL", what, (err instanceof Error ? err.message : String(err)).split("\n")[0]]);
    return false;
  }
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
  if (want("tx-columns")) {
    // ── the transaction row's columns, breakpoint by breakpoint ──
    for (const { w, cols } of TX_COLUMNS) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);

      // Multi-select is off by default, and its column is gone rather than
      // standing empty — one fewer cell in every row of the list, and the
      // merchant's mark hard against the left of the card.
      const measure = () => page.evaluate(() => {
        const visible = (el) => [...el.children]
          .filter((c) => getComputedStyle(c).display !== "none").length;
        const row = document.querySelector(".list-row.tx-grid:not(.head)");
        const head = document.querySelector(".tx-grid.head");
        const tracks = (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length;
        return {
          head: visible(head),
          row: visible(row),
          boxes: document.querySelectorAll(".list-row.tx-grid input.cb").length,
          // The column itself, not just what stands in it: a template that
          // still reserves the track has moved the blank space, not closed it.
          tracks: tracks(row),
          sameTracks: tracks(head) === tracks(row),
        };
      });
      const off = await measure();
      check(`${w}px — with multi-select off the checkbox column is gone, not blank`,
        off.boxes === 0 && off.head === off.row && off.head === cols.length - 1
        && off.tracks === cols.length - 1 && off.sameTracks,
        `${off.boxes} boxes, header ${off.head}, row ${off.row}, ${off.tracks} tracks, expected ${cols.length - 1}`);

      // Guarded: an unguarded locator call aborts the whole run, and a run that
      // aborts prints no failures at all — which reads exactly like a pass.
      if (!await tryStep(`${w}px — multi-select can be turned on`, async () => {
        await page.locator(".tx-pick").click({ timeout: 5000 });
        await page.waitForTimeout(250);
      })) { await page.close(); continue; }

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
      const on = await measure();
      check(`${w}px — the header has as many cells as the row`, on.head === cols.length,
        `header ${on.head}, row ${cols.length}`);
      // And the room the column takes when it is on is room the rest of the
      // list gets back when it is off — one whole track's worth of it.
      check(`${w}px — turning it off gives the column's room back`,
        on.tracks === off.tracks + 1 && on.sameTracks,
        `${off.tracks} tracks off, ${on.tracks} on`);
      await page.close();
    }
  }

  if (want("tx-select")) {
    // ── multi-select is asked for, not always on ──
    const sel = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await sel.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await sel.waitForTimeout(600);

    const off = await sel.evaluate(() => {
      const head = document.querySelector(".tx-grid.head");
      const btn = head.querySelector(".tx-pick");
      const first = head.getBoundingClientRect();
      return {
        boxes: document.querySelectorAll(".list-row.tx-grid input.cb").length,
        toggle: !!btn,
        // "top left of the table" — in the first column, above the rows.
        leftmost: btn ? Math.round(btn.getBoundingClientRect().left - first.left) : -1,
        bar: !!document.querySelector(".btn"),
      };
    });
    check("the list opens with no checkboxes on it", off.boxes === 0, `${off.boxes} boxes`);
    check("and a toggle in the top left of the table instead",
      off.toggle && off.leftmost >= 0 && off.leftmost < 40, `toggle at ${off.leftmost}px`);

    const on = await tryStep("the toggle turns multi-select on", async () => {
      await sel.locator(".tx-pick").click({ timeout: 5000 });
      await sel.waitForTimeout(400);
    });
    if (on) {
      const shown = await sel.evaluate(() => ({
        rows: document.querySelectorAll(".list-row.tx-grid:not(.head) input.cb").length,
        all: !!document.querySelector(".tx-grid.head input.cb"),
        toggle: !!document.querySelector(".tx-pick"),
        bar: /select transactions/i.test(document.body.innerText),
      }));
      check("every row gets its square", shown.rows > 5, `${shown.rows} squares`);
      check("the header's own square selects them all", shown.all, String(shown.all));
      check("and the toggle gives way to it", !shown.toggle, String(shown.toggle));
      // Nothing is picked yet, so the bar offers the way out and nothing else.
      check("with a bar saying what to do next", shown.bar, "no bar");

      const picked = await tryStep("a row can be picked", async () => {
        await sel.locator(".list-row.tx-grid:not(.head) input.cb").first().check({ timeout: 5000 });
        await sel.waitForTimeout(400);
      });
      if (picked) {
        const text = await sel.evaluate(() => document.body.innerText);
        check("and the bar counts it and offers what to do with it",
          /1 selected/.test(text) && /Categorize/.test(text) && /Mark reviewed/.test(text),
          text.slice(0, 80));
      }

      const done = await tryStep("multi-select can be left again", async () => {
        await sel.locator("button", { hasText: /^Done$/ }).first().click({ timeout: 5000 });
        await sel.waitForTimeout(400);
      });
      if (done) {
        const back = await sel.evaluate(() => ({
          boxes: document.querySelectorAll(".list-row.tx-grid input.cb").length,
          toggle: !!document.querySelector(".tx-pick"),
        }));
        check("which puts the squares away and the toggle back",
          back.boxes === 0 && back.toggle, `${back.boxes} boxes, toggle ${back.toggle}`);
      }
    }
    // The drill-down carries the same rows without any multi-select at all, so
    // its own header and date rows have to drop the column too — a list whose
    // header is one column wider than its rows labels them all wrong.
    const drill = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await drill.goto(`${BASE}/categories/c_mortgage`, { waitUntil: "networkidle" });
    await drill.waitForTimeout(900);
    const lined = await drill.evaluate(() => {
      const visible = (el) => [...el.children]
        .filter((c) => getComputedStyle(c).display !== "none").length;
      const head = document.querySelector(".tx-grid.head");
      const row = document.querySelector(".list-row.tx-grid:not(.head)");
      if (!head || !row) return null;
      const cols = (el) => getComputedStyle(el).gridTemplateColumns;
      return { head: visible(head), row: visible(row), same: cols(head) === cols(row), boxes: row.querySelectorAll("input.cb").length };
    });
    check("the drill-down's list drops the column as well",
      lined !== null && lined.boxes === 0 && lined.head === lined.row && lined.same,
      lined === null ? "no list found" : `header ${lined.head}, row ${lined.row}, same grid ${lined.same}`);
    await drill.close();
    await sel.close();
  }

  if (want("tx-align")) {
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

    // What a row says about itself — Pending, and the needs-review dot — sits
    // against the merchant's name. The failure this replaces: the merchant's
    // hover arrow holds its 28px while invisible, and holding it between the
    // name and the badges left them adrift in the middle of the column.
    const badges = await wide.evaluate(() => {
      const textRight = (el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const b = r.getBoundingClientRect();
        return b.width ? b.right : el.getBoundingClientRect().right;
      };
      const out = [];
      for (const row of document.querySelectorAll(".list-row.tx-grid:not(.head)")) {
        const line = row.querySelector(".col > .row");
        if (!line) continue;
        const name = line.querySelector(".truncate");
        const badge = line.querySelector(".tag, .dot");
        if (!name || !badge) continue;
        out.push({
          gap: Math.round(badge.getBoundingClientRect().left - textRight(name)),
          at: Math.round(badge.getBoundingClientRect().left),
        });
      }
      return out;
    });
    check("1440px — a row's badges sit against its merchant name",
      badges.length > 3 && badges.every((b) => b.gap <= 10),
      `${badges.length} rows, widest gap ${Math.max(...badges.map((b) => b.gap), 0)}px`);

    // And the arrow, which appears on hover, must not push them along when it
    // does — the space it reserves is why it sits after them.
    const steady = await tryStep("1440px — hovering a row reveals its arrow", async () => {
      await wide.locator(".list-row.tx-grid:not(.head)").first().hover({ timeout: 5000 });
      await wide.waitForTimeout(300);
    });
    if (steady) {
      const after = await wide.evaluate(() => {
        const line = document.querySelector(".list-row.tx-grid:not(.head) .col > .row");
        return {
          at: Math.round(line.querySelector(".tag, .dot").getBoundingClientRect().left),
          arrow: getComputedStyle(line.querySelector(".tx-merchant-open")).opacity,
        };
      });
      check("1440px — without shifting the badges it sits after",
        after.arrow === "1" && Math.abs(after.at - badges[0].at) <= 1,
        `arrow opacity ${after.arrow}, badge ${badges[0].at} then ${after.at}`);
    }
    await wide.close();
  }

  if (want("category-arrow")) {
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
  }

  if (want("overflow")) {
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
  }

  if (want("phone-account")) {
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
  }

  if (want("phone-nav")) {
    // ── every screen is reachable on a phone ──
    //
    // The bottom bar has room for four, and the fifth used to say "More" and go
    // straight to Settings. Goals, Cash Flow, Reports, Recurring, Investments,
    // Rules, Categories and Tags had no way in at all on a phone — the sidebar
    // that lists them is hidden below 720px. Checked by walking to each one and
    // reading the address back, because a link that renders is not the same as
    // a screen you can get to.
    const nav = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await nav.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await nav.waitForTimeout(500);

    // What the wide layout offers, taken from the running app rather than
    // listed here, so a screen added to the sidebar is covered the same day.
    const desktop = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await desktop.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await desktop.waitForTimeout(500);
    const everywhere = await desktop.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href^='/']")].map((a) => a.getAttribute("href")));
    await desktop.close();

    const more = nav.locator('.mobile-tabs button[aria-label="More screens"]');
    check("390px — the fifth tab opens a menu rather than being one more screen",
      await more.count() === 1, "no More button in the tab bar — it is a link to one more screen");

    await tryStep("390px — the menu can be opened", () => more.click({ timeout: 5000 }));
    await nav.waitForTimeout(400);
    const inBar = await nav.$$eval(".mobile-tabs a[href^='/']", (as) => as.map((a) => a.getAttribute("href")));
    const inSheet = await nav.$$eval(".more-sheet a[href^='/']", (as) => as.map((a) => a.getAttribute("href")));
    const reachable = new Set([...inBar, ...inSheet]);
    const missing = everywhere.filter((h) => h !== "/dashboard" && !reachable.has(h));

    check("390px — every screen the sidebar offers can be reached from the tab bar",
      everywhere.length > 8 && missing.length === 0,
      missing.length ? `no way to ${missing.join(", ")}` : `only saw ${everywhere.length} in the sidebar`);
    check("390px — and nothing is offered in both the bar and the menu",
      !inBar.some((h) => inSheet.includes(h)),
      inBar.filter((h) => inSheet.includes(h)).join(", "));

    // Tapping one has to land there and put the menu away.
    await tryStep("390px — Goals can be reached from the menu", () =>
      nav.locator('.more-sheet a[href="/goals"]').click({ timeout: 5000 }));
    await nav.waitForTimeout(800);
    check("390px — tapping a screen in the menu goes there and closes it",
      new URL(nav.url()).pathname === "/goals" && await nav.locator(".more-sheet").count() === 0,
      `landed on ${new URL(nav.url()).pathname}`);

    // And the bar must not look as though nothing is selected while you stand
    // on one of the screens behind the menu.
    const lit = await nav.evaluate(() => {
      const b = document.querySelector('.mobile-tabs button[aria-label="More screens"]');
      const link = document.querySelector('.mobile-tabs a[href="/dashboard"]');
      return b && link ? getComputedStyle(b).color !== getComputedStyle(link).color : null;
    });
    check("390px — More is lit while you are on one of the screens behind it", lit === true, `saw ${lit}`);

    // Closing it without going anywhere.
    await tryStep("390px — the menu can be opened again", () => more.click({ timeout: 5000 }));
    await nav.waitForTimeout(350);
    await nav.mouse.click(195, 40);
    await nav.waitForTimeout(400);
    check("390px — tapping outside the menu closes it without navigating",
      await nav.locator(".more-sheet").count() === 0 && new URL(nav.url()).pathname === "/goals",
      `at ${new URL(nav.url()).pathname}`);
    await nav.close();
  }

  if (want("nested-menu")) {
    // ── a menu opened from inside a menu ──
    //
    // Every popover is portalled to document.body, so the category list opened
    // from the Move money panel is not a DOM descendant of it. The panel read a
    // click on that list as a click outside itself and shut, which left the
    // pickers unusable and the panel workable only with whatever it had guessed.
    const nest = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await nest.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
    await nest.waitForTimeout(600);

    const opened = await tryStep("the move panel opens from a category's remaining", async () => {
      await nest.locator(".bcol-left button.budget-amount").first().click({ timeout: 5000 });
      await nest.locator(".move-panel").waitFor({ timeout: 5000 });
    });

    if (opened) {
      check("every category in the move list carries what is left in it",
        await tryStep("the From picker opens", async () => {
          await nest.locator(".move-panel .move-row").first().locator("button.move-pick").click({ timeout: 5000 });
          await nest.waitForTimeout(350);
        }) && (await nest.evaluate(() =>
          [...document.querySelectorAll("button")].filter((b) => / left/.test(b.innerText)).length)) > 3);

      await tryStep("a category can be chosen from the list", async () => {
        const option = nest.locator("button").filter({ hasText: / left/ }).nth(1);
        await option.scrollIntoViewIfNeeded();
        await option.click({ timeout: 5000 });
        await nest.waitForTimeout(350);
      });
      check("choosing from a nested menu leaves the panel it belongs to open",
        await nest.locator(".move-panel").count() === 1,
        "the panel closed under the choice");
    }
    await nest.close();
  }

  if (want("drilldown-back")) {
    // ── the way out of a drill-down ──
    //
    // Every drill-down used to carry its own back link in the page body, which
    // scrolled away with the body: on a category with two years of transactions
    // the way out was the one thing you could not reach without going back up
    // for it. It lives in the sticky bar now, which means it has to be on every
    // one of them, point at the right place, and still be there at the bottom.
    const DRILLDOWNS = [
      { path: "/accounts/a_savings", parent: "/accounts" },
      { path: "/goals/gl_efund", parent: "/goals" },
      { path: "/categories/c_groceries", parent: "/transactions" },
      { path: "/merchants/Amazon", parent: "/transactions" },
    ];

    const drill = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    for (const { path, parent } of DRILLDOWNS) {
      await drill.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await drill.waitForTimeout(400);
      const href = await drill.evaluate(() => document.querySelector(".topbar-back")?.getAttribute("href") ?? null);
      check(`${path} — the bar carries a way back, to ${parent}`, href === parent, `points at ${href}`);

      // Not two ways back. The body's own link was removed in the same change,
      // and a page carrying both would be the repetition this was meant to end.
      const strays = await drill.evaluate(() => document.querySelectorAll(".page .lucide-arrow-left").length);
      check(`${path} — and only the one`, strays === 0, `${strays} arrows left in the body`);

      // The whole point: still reachable from the far end of the page.
      await drill.evaluate(() => window.scrollTo(0, 99999));
      await drill.waitForTimeout(250);
      const scrolled = await drill.evaluate(() => window.scrollY);
      // Allowed to be missing: against a build that dropped the arrow this is
      // the line that would otherwise abandon the run with a stack trace, and
      // take the list of what else passed down with it.
      const box = await drill.locator(".topbar-back").boundingBox({ timeout: 3000 }).catch(() => null);
      check(`${path} — and it is still on screen at the bottom of the page`,
        scrolled === 0 || (box !== null && box.y >= 0 && box.y < 60),
        `scrolled ${scrolled}px, arrow at ${box ? Math.round(box.y) : "nowhere"}`);
    }

    // It goes where it says it goes.
    await drill.goto(`${BASE}/categories/c_groceries`, { waitUntil: "networkidle" });
    await drill.waitForTimeout(400);
    await tryStep("the back arrow can be clicked", () => drill.locator(".topbar-back").click({ timeout: 5000 }));
    await drill.waitForTimeout(600);
    check("the back arrow lands on the screen it names",
      new URL(drill.url()).pathname === "/transactions", `landed on ${new URL(drill.url()).pathname}`);
    await drill.close();
  }

  if (want("drilldown-scroll")) {
    // ── a drill-down opens at its own top ──
    //
    // The window scrolls the whole app, so opening a category from halfway down
    // a long list used to keep that offset — landing you in the middle of a
    // chart you had never seen the top of.
    const jump = await browser.newPage({ viewport: { width: 1280, height: 700 } });
    await jump.goto(`${BASE}/categories`, { waitUntil: "networkidle" });
    await jump.waitForTimeout(500);
    await jump.evaluate(() => window.scrollTo(0, 900));
    await jump.waitForTimeout(250);
    const from = await jump.evaluate(() => window.scrollY);
    const drilled = await tryStep("a category can be opened from down the page", async () => {
      const link = jump.locator('a[href^="/categories/"]').last();
      await link.scrollIntoViewIfNeeded();
      await link.click({ timeout: 5000 });
      await jump.waitForTimeout(600);
    });
    if (drilled) {
      check("opening a drill-down from down the page starts it at the top",
        from > 0 && await jump.evaluate(() => window.scrollY) === 0,
        `left ${from}px, arrived at ${await jump.evaluate(() => window.scrollY)}px`);

      // But reading the same page must not: a drill-down keeps the period in
      // the query string, so jumping to the top on every bar click would pull
      // the list out from under whoever clicked it.
      await jump.evaluate(() => window.scrollTo(0, 400));
      await jump.waitForTimeout(200);
      const held = await tryStep("the grain can be changed", async () => {
        await jump.locator(".seg button").last().click({ timeout: 5000 });
        await jump.waitForTimeout(500);
      });
      if (held) {
        check("changing the period within a drill-down leaves the page where it was",
          await jump.evaluate(() => window.scrollY) > 0,
          "it jumped to the top on a query-string change");
      }
    }
    await jump.close();
  }

  if (want("goals")) {
    // ── two things taken away ──
    const gone = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await gone.goto(`${BASE}/goals`, { waitUntil: "networkidle" });
    await gone.waitForTimeout(600);
    const tiles = await gone.evaluate(() => [...document.querySelectorAll(".tile-label")].map((e) => e.innerText.trim()));
    check("the goals screen no longer counts the goals it is listing",
      !tiles.some((t) => /active goals/i.test(t)), tiles.join(", "));

    // Expanding a goal account offered "Allocate this account" directly above
    // the "Allocate funds" button that does the same job.
    await tryStep("a goal account can be expanded", async () => {
      await gone.locator(".list-row").filter({ hasText: "High Yield Savings" }).first().click({ timeout: 5000 });
      await gone.waitForTimeout(400);
    });
    const buttons = await gone.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => /allocate/i.test(t)));
    check("and an expanded goal account does not repeat the allocate button",
      !buttons.some((t) => /this account/i.test(t)), buttons.join(" | "));
    check("while the one at the foot of the card stays",
      buttons.some((t) => /^allocate funds$/i.test(t)), buttons.join(" | "));
    await gone.close();

    // ── an account allocated in full, then spent down ──
    //
    // Seeded rather than clicked: the demo data is hand-kept and would only
    // ever show the one state that cannot go wrong. This is the reported case
    // — every penny of an account promised to a goal, and then the balance
    // falls — which used to leave a permanent red figure on a screen with no
    // control that could clear it.
    const seedCtx = await browser.newContext();
    const seedPage = await seedCtx.newPage();
    await seedPage.goto(`${BASE}/goals`, { waitUntil: "networkidle" });
    await seedPage.waitForTimeout(1200);
    const doc = JSON.parse(await seedPage.evaluate(() => localStorage.getItem("sovereign.db.v1")));
    await seedCtx.close();

    const target = doc.accounts.find((a) => a.goalAccount) ?? doc.accounts[0];
    const goal = doc.goals.find((g) => !g.archived);
    const overDoc = {
      ...doc,
      accounts: doc.accounts.map((a) => (a.id === target.id ? { ...a, balance: 10_475_10 } : a)),
      goals: doc.goals.map((g) => (g.id === goal.id
        ? { ...g, allocations: { ...(g.allocations ?? {}), [target.id]: 11_807_92 } }
        : g)),
    };

    const overCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await overCtx.addInitScript((d) => {
      if (!localStorage.getItem("sovereign.db.v1")) localStorage.setItem("sovereign.db.v1", d);
    }, JSON.stringify(overDoc));
    const over = await overCtx.newPage();
    await over.goto(`${BASE}/goals`, { waitUntil: "networkidle" });
    await over.waitForTimeout(900);

    // Currency first, then the number: the app writes a negative as "-$1,332.82",
    // so matching digits straight off the string finds "1,332.82" and loses the
    // sign — which is how this check first passed against a build that still
    // showed the shortfall.
    const money = (t) => Number(t.replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0");

    // Read off the account's own expanded panel, not the headline: the
    // headline adds every goal account up, so a shortfall on one is covered by
    // spare money on another — which is how the first version of this check
    // passed against a build with the trimming taken out.
    const panel = await over.evaluate((name) => {
      const row = [...document.querySelectorAll(".list-row")]
        .find((r) => r.querySelector(".truncate")?.innerText.trim() === name);
      if (!row) return null;
      row.click();
      return new Promise((r) => setTimeout(() => r(
        [...document.querySelectorAll(".spread.small")].map((e) => e.innerText.replace(/\n/g, " ").trim()),
      ), 500));
    }, target.name);

    const line = (re) => panel?.find((l) => re.test(l)) ?? null;
    const balanceLine = line(/^Account balance/i);
    const availableLine = line(/^Available/i);
    const goalLine = panel?.find((l) => !/^(Account balance|Available)/i.test(l) && /\$/.test(l)) ?? null;

    check("an account spent below what its goals were promised shows no negative to chase",
      availableLine !== null && money(availableLine) >= 0,
      availableLine === null ? `no Available line — saw ${panel?.join(" | ") ?? "no panel"}` : availableLine);
    check("the balance it reports is the one the account really holds",
      balanceLine?.includes("10,475.10") ?? false, balanceLine ?? "missing");
    check("and the goal behind it holds exactly that, not what it was promised",
      goalLine !== null && goalLine.includes("10,475.10") && !goalLine.includes("11,807.92"),
      goalLine ?? `no goal line — saw ${panel?.join(" | ") ?? "no panel"}`);
    await overCtx.close();
  }

  if (want("detail")) {
    // ── a transaction, as a detail screen ──
    //
    // It was a stack of form fields; it is now the amount alone at the top and
    // one labelled line per fact, with each value a piece of text until you go
    // to change it. The reason for that last part is not decoration: an input
    // wide enough to type into is wider than the words in it, so a text box left
    // sitting in the row pushes the merchant's logo into the middle of it.
    const det = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await det.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await det.waitForTimeout(700);

    const openedTxn = await tryStep("a transaction opens its detail screen", async () => {
      await det.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(1).click({ timeout: 5000 });
      await det.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
    });

    if (openedTxn) {
      const labels = await det.evaluate(() =>
        [...document.querySelectorAll(".modal .drow-label")].map((e) => e.innerText.trim()));
      check("the detail screen names the same things Monarch's does, in that order",
        labels.slice(0, 5).join(" / ") === "Merchant / Original statement / Account / Category / Date",
        labels.join(" / "));

      // Measured on an untouched dialog, and it has to stay first: clicking
      // anything at all blurs an open row and closes it, so this same check run
      // later would pass against a screen that had opened every row at once.
      const untouched = await det.evaluate(() => document.querySelectorAll(".modal .drow input").length);
      check("a row is text, not a form field, until it is asked to be",
        untouched === 0, `${untouched} inputs sitting in rows unasked`);

      // Values sit hard right, logo included — the alignment the tap-to-edit
      // pattern exists to protect.
      const merchantRow = det.locator(".modal .drow").filter({ hasText: "Merchant" }).first();
      // The date is spelled out, as it is on the screen this was matched to —
      // "Sep 5, 2026" is what a cramped list says, and this screen is not one.
      const dateText = await det.evaluate(() =>
        [...document.querySelectorAll(".modal .drow")]
          .find((r) => r.querySelector(".drow-label").innerText.trim() === "Date")
          ?.querySelector(".drow-val").innerText.trim() ?? "");
      check("the date is written out in full",
        /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/.test(dateText),
        dateText);

      // The last thing in the value, not the box holding it: that box spans the
      // rest of the row whichever end its contents are pushed to, so measuring
      // it would pass against a screen with every value hard left.
      const rowGap = await merchantRow.evaluate((row) => {
        const last = row.querySelector(".drow-val").lastElementChild;
        const pad = parseFloat(getComputedStyle(row).paddingRight);
        return Math.round((row.getBoundingClientRect().right - pad) - last.getBoundingClientRect().right);
      });
      check("a value ends where its row ends", rowGap >= 0 && rowGap <= 4, `${rowGap}px short of the edge`);

      // The amount is the heading, and reads as money until it is being edited.
      const shown = await det.evaluate(() => document.querySelector(".modal .txn-amount input").value);
      check("the amount reads as money above everything else", /^-?\$[\d,]+\.\d\d$/.test(shown), shown);
      const big = await det.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector(".modal .txn-amount input")).fontSize));
      check("and it is the largest thing on the screen", big >= 30, `${big}px`);

      await det.locator(".modal .txn-amount input").click();
      await det.waitForTimeout(250);
      const raw = await det.evaluate(() => document.querySelector(".modal .txn-amount input").value);
      check("putting the cursor in it swaps the money for the number you edit",
        /^-?\d+\.\d\d$/.test(raw), raw);

      // The statement is shown as the bank sent it, with the whole of it on
      // hover — the useful half of a statement line is often the half that will
      // not fit. CSS clips it, so innerText is still the whole string and the
      // title has to match it exactly.
      const stmt = await det.evaluate(() => {
        const el = document.querySelector(".modal .drow-statement");
        return el ? { text: el.innerText.trim(), title: el.getAttribute("title") } : null;
      });
      check("the original statement is carried through verbatim, hover and all",
        stmt !== null && stmt.text.length > 0 && stmt.title === stmt.text,
        stmt === null ? "no statement row at all" : `shows "${stmt.text}", hover says "${stmt.title}"`);

      // Clicking a value opens that row and only that row, and what is typed
      // into it survives the save.
      const editable = await tryStep("the merchant can be clicked to edit", async () => {
        await merchantRow.locator(".drow-btn").click({ timeout: 5000 });
        await det.waitForTimeout(300);
      });
      if (editable) {
        const fields = await det.evaluate(() => document.querySelectorAll(".modal .drow input").length);
        check("clicking a value turns that one row into a field, and no others",
          fields === 1, `${fields} rows became fields`);

        const saved = await tryStep("the merchant can be retyped and saved", async () => {
          await merchantRow.locator("input").fill("Bodega Cat Supply", { timeout: 5000 });
          await det.locator(".modal .drow-label").first().click({ timeout: 5000 });
          await det.waitForTimeout(250);
          await det.locator(".modal-foot button", { hasText: "Save changes" }).click({ timeout: 5000 });
          await det.waitForTimeout(700);
          await det.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(1).click({ timeout: 5000 });
          await det.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
        });
        if (saved) {
          const kept = await det.evaluate(() =>
            document.querySelector(".modal .drow .drow-btn")?.innerText.trim() ?? "");
          check("and what was typed into it is what gets saved",
            kept.includes("Bodega Cat Supply"), `reopened as "${kept}"`);
        }
      }
    }
    await det.close();

    // A dialog that runs off a pocket is a dialog with a button you cannot press.
    const pocket = await browser.newPage({ viewport: { width: 390, height: 860 } });
    await pocket.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await pocket.waitForTimeout(800);
    const onPhone = await tryStep("390px — a transaction opens its detail screen", async () => {
      await pocket.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(1).click({ timeout: 5000 });
      await pocket.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
    });
    if (onPhone) {
      const fits = await pocket.evaluate(() => {
        const m = document.querySelector(".modal").getBoundingClientRect();
        return m.left >= 0 && m.right <= window.innerWidth
          && document.documentElement.scrollWidth <= window.innerWidth;
      });
      check("390px — the detail screen fits the pocket it is on", fits === true, "it runs off the edge");
    }
    await pocket.close();
  }

  if (want("explain")) {
    // ── what a statement line was ──
    //
    // The model is stubbed at the network boundary: this is about the button,
    // the streaming, and — the part that matters for the bill — the second
    // click never reaching the wire at all.
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    await ctx.addInitScript(() => {
      // A passphrase, or the client refuses before it gets as far as fetching.
      try { localStorage.setItem("sovereign.cloud.pass", "test-pass"); } catch { /* private mode */ }
      const real = window.fetch;
      window.__hopperCalls = 0;
      window.fetch = async (input, init) => {
        const url = String(typeof input === "string" ? input : input.url);
        if (!url.includes("/api/hopper")) return real(input, init);
        window.__hopperCalls += 1;
        const body = init?.body ? JSON.parse(init.body) : {};
        window.__hopperBody = body;
        const said = "This is a payment to the City of Fishers (Fishers, Indiana), processed through "
          + "an online payment portal.\n\n- Utility bill (water/sewer/trash)\n- City services or permit fees";
        const events = [
          `data: ${JSON.stringify({ type: "text", text: said })}\n\n`,
          `data: ${JSON.stringify({ type: "done", message: { content: [{ type: "text", text: said }], stop_reason: "end_turn" } })}\n\n`,
        ];
        return new Response(new Blob(events).stream(), {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      };
    });
    const ex = await ctx.newPage();
    await ex.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await ex.waitForTimeout(900);

    // Not every transaction carries a statement — a hand-entered one has none
    // — so this opens rows until it finds one that does.
    const opened = await tryStep("a transaction with a statement opens", async () => {
      for (let i = 0; i < 8; i++) {
        await ex.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(i).click({ timeout: 5000 });
        await ex.waitForTimeout(400);
        if (await ex.locator(".modal .drow-explain").count()) return;
        await ex.keyboard.press("Escape");
        await ex.waitForTimeout(250);
      }
      throw new Error("no transaction in the first eight carried a statement");
    });

    if (opened) {
      const asked = await tryStep("the question mark asks what the line was", async () => {
        await ex.locator(".modal .drow-explain").first().click({ timeout: 5000 });
        await ex.locator(".explain-body").waitFor({ timeout: 5000 });
      });
      if (asked) {
        const shown = await ex.evaluate(() => ({
          title: [...document.querySelectorAll(".modal h2, .modal h3, .modal .modal-title")]
            .map((e) => e.innerText.trim()).find((t) => /explanation/i.test(t)) ?? null,
          statement: document.querySelector(".explain-statement")?.innerText.trim() ?? null,
          body: document.querySelector(".explain-body")?.innerText.trim() ?? null,
          calls: window.__hopperCalls,
          sent: window.__hopperBody,
        }));
        check("it opens its own screen, headed like Monarch's", /explanation/i.test(shown.title ?? ""), shown.title ?? "no title");
        check("with the statement line it is explaining", (shown.statement ?? "").length > 0, shown.statement ?? "none");
        check("and the answer, line breaks and all",
          (shown.body ?? "").includes("City of Fishers") && (shown.body ?? "").includes("\n"),
          (shown.body ?? "none").slice(0, 60));
        check("one question, asked once", shown.calls === 1, `${shown.calls} calls`);
        // No tools and no digest: this is a question about a string, not about
        // the household's money.
        check("and it goes up without Hopper's tools or its data",
          shown.sent && !shown.sent.tools && shown.sent.messages.length === 1,
          `tools ${Boolean(shown.sent?.tools)}, ${shown.sent?.messages?.length} messages`);
        check("under instructions marked cacheable",
          shown.sent?.system?.[0]?.cache_control?.type === "ephemeral",
          JSON.stringify(shown.sent?.system?.[0]?.cache_control ?? null));

        // The saving. Close it, open it again, and nothing should reach the wire.
        const again = await tryStep("the same line can be asked about twice", async () => {
          await ex.locator(".modal .btn", { hasText: /^Close$/ }).first().click({ timeout: 5000 });
          await ex.waitForTimeout(300);
          await ex.locator(".modal .drow-explain").first().click({ timeout: 5000 });
          await ex.locator(".explain-body").waitFor({ timeout: 5000 });
        });
        if (again) {
          const after = await ex.evaluate(() => ({
            calls: window.__hopperCalls,
            body: document.querySelector(".explain-body")?.innerText.trim() ?? null,
          }));
          check("but the second time is answered from the document, not the model",
            after.calls === 1, `${after.calls} calls after asking twice`);
          check("and it is the same answer", (after.body ?? "").includes("City of Fishers"), after.body ?? "none");
        }
      }
    }
    await ctx.close();
  }

  if (want("recurring")) {
    // ── the calendar leads, and a row is its merchant ──
    for (const w of [1280, 390]) {
      const rec = await browser.newPage({ viewport: { width: w, height: 1000 } });
      await rec.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
      await rec.waitForTimeout(800);

      const layout = await rec.evaluate(() => {
        const cal = document.querySelector(".cal-grid");
        const row = document.querySelector(".rec-row");
        if (!cal || !row) return null;
        const calCard = cal.closest(".card").getBoundingClientRect();
        const listCard = row.closest(".card").getBoundingClientRect();
        return {
          calTop: Math.round(cal.getBoundingClientRect().top),
          listTop: Math.round(row.getBoundingClientRect().top),
          // The page's gutter is a gutter, not the calendar being narrow, so
          // "full width" is measured against the card it used to sit beside.
          calCard: { left: Math.round(calCard.left), width: Math.round(calCard.width) },
          listCard: { left: Math.round(listCard.left), width: Math.round(listCard.width) },
          // The grid's own width too: a card that is full width with a
          // calendar capped narrow inside it is the thing being fixed, and
          // measuring only the card cannot see it.
          gridWidth: Math.round(cal.getBoundingClientRect().width),
          columns: getComputedStyle(cal).gridTemplateColumns.split(" ").length,
        };
      });
      check(`${w}px — the calendar sits above the transactions`,
        layout !== null && layout.calTop < layout.listTop,
        layout === null ? "no calendar or no rows" : `calendar at ${layout.calTop}, list at ${layout.listTop}`);
      check(`${w}px — and takes the whole width rather than a column of it`,
        layout !== null && layout.columns === 7
        && Math.abs(layout.calCard.width - layout.listCard.width) <= 2
        && Math.abs(layout.calCard.left - layout.listCard.left) <= 2
        && layout.calCard.width - layout.gridWidth <= 40,
        layout === null ? "no calendar"
          : `grid ${layout.gridWidth} in card ${layout.calCard.width}px at ${layout.calCard.left}, `
            + `list ${layout.listCard.width}px at ${layout.listCard.left}`);
      await rec.close();
    }

    // ── the two tiles, and what they claim ──
    const tiles = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await tiles.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await tiles.waitForTimeout(800);
    const top = await tiles.evaluate(() => {
      const money = (t) => Number(t.replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0");
      return [...document.querySelectorAll(".tile-label")].map((el) => {
        const card = el.closest(".card");
        const value = card.querySelector(".tile-value")?.innerText.replace(/\n/g, " ").trim() ?? "";
        const parts = value.split(/\bof\b/);
        return {
          label: el.innerText.trim(),
          value,
          spent: money(parts[0] ?? ""),
          total: parts[1] === undefined ? null : money(parts[1]),
          bar: card.querySelector(".spend-bar > i")
            ? parseFloat(getComputedStyle(card.querySelector(".spend-bar > i")).width)
            : null,
          barTrack: card.querySelector(".spend-bar")
            ? parseFloat(getComputedStyle(card.querySelector(".spend-bar")).width)
            : null,
          foot: card.querySelector(".spread")?.innerText.replace(/\n/g, " ").trim() ?? "",
        };
      });
    });
    check("the page carries two metrics, not four",
      top.length === 2, top.map((t) => t.label).join(", "));
    check("and neither of them is the two that were dropped",
      !top.some((t) => /next 7 days|recurring income/i.test(t.label)), top.map((t) => t.label).join(", "));
    check("each says what has gone of what is committed",
      top.every((t) => t.total !== null && t.total > 0 && t.spent <= t.total),
      top.map((t) => t.value).join(" | "));
    check("with the rest of it named rather than left to be worked out",
      top.every((t) => /to go/.test(t.foot)), top.map((t) => t.foot).join(" | "));
    // The bar is the same claim as the figures, so it has to agree with them.
    check("and a bar drawn to the same share the figures give",
      top.every((t) => {
        const share = t.spent / t.total;
        return Math.abs(t.bar / t.barTrack - share) <= 0.02;
      }),
      top.map((t) => `${Math.round((t.bar / t.barTrack) * 100)}% drawn vs ${Math.round((t.spent / t.total) * 100)}%`).join(" | "));
    // The year is twelve of the month, on a schedule that is all monthly —
    // which is what the demo data is, and what a day-stepped walk gets wrong.
    const [month, year] = top;
    check("the year's total is twelve times the month's",
      Math.abs(year.total - month.total * 12) <= 12,
      `${year.total} against ${month.total} × 12`);
    await tiles.close();

    // A cell wide enough for a name shows one; a narrow one shows a dot.
    const wide = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await wide.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await wide.waitForTimeout(800);
    const named = await wide.evaluate(() => {
      // Drawn, not merely styled: an element inside a display:none parent still
      // computes its own display, so asking it directly says "flex" for
      // something nobody can see.
      const drawn = (sel) => [...document.querySelectorAll(sel)]
        .filter((e) => e.getBoundingClientRect().height > 0).length;
      return { names: drawn(".cal-name"), dots: drawn(".cal-marks") };
    });
    check("1280px — a full-width cell names what is due, rather than dotting it",
      named.names > 3 && named.dots === 0, `${named.names} names, ${named.dots} dot rows`);

    // The row goes where every other merchant in the app goes.
    const rows = await wide.evaluate(() => [...document.querySelectorAll(".rec-row")].slice(0, 4).map((r) => ({
      tag: r.tagName,
      href: r.getAttribute("href"),
      merchant: r.querySelector(".truncate")?.innerText.trim() ?? "",
    })));
    check("a recurring row leads to its merchant's page",
      rows.length > 0 && rows.every((r) => r.tag === "A"
        && r.href === `/merchants/${encodeURIComponent(r.merchant)}`),
      rows.map((r) => `${r.tag} ${r.href}`).join(", "));

    const went = await tryStep("and clicking one goes there", async () => {
      await wide.locator(".rec-row").first().click({ timeout: 5000 });
      await wide.waitForTimeout(700);
    });
    if (went) {
      check("landing on the merchant, not the schedule",
        /\/merchants\//.test(wide.url()) && !await wide.locator(".modal").count(),
        wide.url());
      await wide.goBack();
      await wide.waitForTimeout(600);
    }

    // Editing the schedule is still reachable, and must not follow the link.
    const edited = await tryStep("the schedule can still be edited", async () => {
      await wide.locator(".rec-row button[title='Edit schedule']").first().click({ timeout: 5000 });
      await wide.locator(".modal").waitFor({ timeout: 5000 });
    });
    if (edited) {
      check("which opens the schedule where it is, rather than navigating away",
        /\/recurring/.test(wide.url()), wide.url());
    }
    await wide.close();
  }

  if (want("notifications")) {
    // ── the bell replaces the eye ──
    const nb = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await nb.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
    await nb.waitForTimeout(800);

    const bar = await nb.evaluate(() => ({
      bell: document.querySelectorAll(".topbar .notif-bell").length,
      badge: document.querySelector(".notif-dot")?.innerText.trim() ?? null,
      titles: [...document.querySelectorAll(".topbar button")].map((b) => b.getAttribute("title") ?? ""),
      blurred: document.querySelectorAll(".blurred").length,
    }));
    check("the top bar carries a bell", bar.bell === 1, `${bar.bell} bells`);
    check("and no longer offers to hide the amounts",
      !bar.titles.some((t) => /hide amounts|show amounts/i.test(t)), bar.titles.join(" | "));
    check("with nothing left blurred anywhere", bar.blurred === 0, `${bar.blurred} blurred`);
    check("the bell counts what is unread", bar.badge !== null && /^[0-9]+\+?$/.test(bar.badge), bar.badge ?? "no badge");

    const opened = await tryStep("the bell opens the list", async () => {
      await nb.locator(".notif-bell").click({ timeout: 5000 });
      await nb.locator(".notif-row").first().waitFor({ timeout: 5000 });
    });
    if (opened) {
      const list = await nb.evaluate(() => ({
        rows: [...document.querySelectorAll(".notif-row")].map((r) => ({
          text: r.innerText.replace(/\n/g, " · ").trim(),
          unread: r.classList.contains("unread"),
        })),
        inside: (() => {
          const panel = document.querySelector(".notif-panel").getBoundingClientRect();
          return panel.right <= window.innerWidth + 1 && panel.left >= -1;
        })(),
      }));
      check("each row says what happened and what it costs",
        list.rows.length > 0 && list.rows.every((r) => /\S/.test(r.text)),
        list.rows.map((r) => r.text).slice(0, 2).join(" || "));
      check("and every one of them is unread to begin with",
        list.rows.every((r) => r.unread), `${list.rows.filter((r) => r.unread).length} of ${list.rows.length}`);
      check("the panel stays on the screen", list.inside, "the panel ran off the edge");

      // Clicking one goes where it points, and stops counting.
      const before = list.rows.length;
      const followed = await tryStep("a notice takes you to what it is about", async () => {
        await nb.locator(".notif-row").first().click({ timeout: 5000 });
        await nb.waitForTimeout(800);
      });
      if (followed) {
        check("landing somewhere, with the list closed behind it",
          !await nb.locator(".notif-panel").count(), "the panel stayed open");
        await nb.locator(".notif-bell").click();
        await nb.waitForTimeout(400);
        const after = await nb.evaluate(() => ({
          badge: document.querySelector(".notif-dot")?.innerText.trim() ?? "0",
          rows: document.querySelectorAll(".notif-row").length,
          unread: document.querySelectorAll(".notif-row.unread").length,
        }));
        check("the one that was read stops counting", Number(after.badge) === before - 1,
          `badge ${after.badge}, was ${before}`);
        check("but stays in the list rather than vanishing", after.rows === before,
          `${after.rows} rows, was ${before}`);
        check("shown as read", after.unread === before - 1, `${after.unread} unread`);

        const cleared = await tryStep("everything can be marked read at once", async () => {
          await nb.locator(".notif-all").click({ timeout: 5000 });
          await nb.waitForTimeout(500);
        });
        if (cleared) {
          const end = await nb.evaluate(() => ({
            badge: document.querySelector(".notif-dot")?.innerText.trim() ?? null,
            unread: document.querySelectorAll(".notif-row.unread").length,
          }));
          check("and then the bell is quiet", end.badge === null && end.unread === 0,
            `badge ${end.badge}, ${end.unread} unread`);
        }
      }
    }
    await nb.close();

    // ── a recurring item can be added by hand ──
    const add = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await add.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await add.waitForTimeout(800);
    const beforeRows = await add.locator(".rec-row").count();
    const added = await tryStep("a recurring item can be added by hand", async () => {
      await add.locator(".topbar button", { hasText: /Recurring/ }).first().click({ timeout: 5000 });
      await add.locator(".modal").waitFor({ timeout: 5000 });
      await add.locator(".modal input").first().fill("Adobe Creative Cloud");
      await add.locator(".modal .btn-primary, .modal button", { hasText: /^Save$/ }).first().click({ timeout: 5000 });
      await add.waitForTimeout(700);
    });
    if (added) {
      const rows = await add.evaluate(() => [...document.querySelectorAll(".rec-row")].map((r) => r.innerText));
      check("which lands in the list rather than replacing something detected",
        rows.length === beforeRows + 1 && rows.some((t) => /Adobe Creative Cloud/.test(t)),
        `${rows.length} rows, was ${beforeRows}`);
    }
    await add.close();

    // ── a pattern the app has only just worked out ──
    //
    // Seeded: the demo history is old, so nothing in it completed recently and
    // the state being checked would never occur.
    const seedCtx = await browser.newContext();
    const sp = await seedCtx.newPage();
    await sp.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await sp.waitForTimeout(1000);
    const doc = JSON.parse(await sp.evaluate(() => localStorage.getItem("sovereign.db.v1")));
    await seedCtx.close();

    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const newDoc = {
      ...doc,
      recurring: [
        ...(doc.recurring ?? []),
        {
          id: "rec_fresh_thing", merchant: "Fresh Thing", categoryId: doc.categories[0].id,
          amount: -9_99, cadence: "monthly", nextDate: iso(-20), kind: "subscription",
          detected: true, detectedAt: iso(3),
        },
        {
          id: "rec_old_thing", merchant: "Old Thing", categoryId: doc.categories[0].id,
          amount: -4_99, cadence: "monthly", nextDate: iso(-25), kind: "subscription",
          detected: true, detectedAt: iso(200),
        },
      ],
    };

    const tagCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await tagCtx.addInitScript((d) => {
      if (!localStorage.getItem("sovereign.db.v1")) localStorage.setItem("sovereign.db.v1", d);
    }, JSON.stringify(newDoc));
    const tag = await tagCtx.newPage();
    await tag.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await tag.waitForTimeout(900);

    const tags = await tag.evaluate(() => {
      const of = (name) => {
        const row = [...document.querySelectorAll(".rec-row")]
          .find((r) => r.querySelector(".truncate")?.innerText.trim() === name);
        return row ? [...row.querySelectorAll(".tag")].map((t) => t.innerText.trim()) : null;
      };
      return { fresh: of("Fresh Thing"), old: of("Old Thing") };
    });
    check("a pattern found in the last month is tagged as new",
      tags.fresh?.includes("New") ?? false, JSON.stringify(tags.fresh));
    check("and one that has been running for months is not",
      tags.old !== null && !tags.old.includes("New"), JSON.stringify(tags.old));

    // Acting on it is having seen it.
    const acted = await tryStep("acting on it clears the tag", async () => {
      const row = tag.locator(".rec-row").filter({ hasText: "Fresh Thing" }).first();
      await row.locator("button[title='Edit schedule']").click({ timeout: 5000 });
      await tag.locator(".modal").waitFor({ timeout: 5000 });
      await tag.locator(".modal button", { hasText: /^Save$/ }).first().click({ timeout: 5000 });
      await tag.waitForTimeout(600);
    });
    if (acted) {
      const after = await tag.evaluate(() => {
        const row = [...document.querySelectorAll(".rec-row")]
          .find((r) => r.querySelector(".truncate")?.innerText.trim() === "Fresh Thing");
        return row ? [...row.querySelectorAll(".tag")].map((t) => t.innerText.trim()) : null;
      });
      check("so the row stops shouting once it has been dealt with",
        after !== null && !after.includes("New"), JSON.stringify(after));
    }
    await tagCtx.close();
  }

  if (want("retry")) {
    // ── a save that fails does not keep trying every minute ──
    //
    // The whole document goes up on every save, so a retry loop is a bill
    // rather than an annoyance. The endpoint is stubbed to refuse, and the
    // clock is wound forward rather than waited out.
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sovereign.cloud.pass", "test-pass");
        localStorage.setItem("sovereign.cloud.state.v1", JSON.stringify({ version: 1, dirty: false }));
      } catch { /* private mode */ }
      window.__puts = 0;
      window.__bytes = 0;
      const real = window.fetch;
      window.fetch = async (input, init) => {
        const url = String(typeof input === "string" ? input : input.url);
        if (!url.includes("/api/db")) return real(input, init);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET") {
          // The version check: cheap, and always says "nothing new".
          return new Response(JSON.stringify({ found: true, version: 1, updatedAt: null, updatedBy: null, sealed: false }),
            { status: 200, headers: { "content-type": "application/json" } });
        }
        window.__puts += 1;
        window.__bytes += (init?.body ?? "").length;
        return new Response(JSON.stringify({ error: "Nope." }), { status: 500, headers: { "content-type": "application/json" } });
      };
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    // One edit, which is one save, which fails.
    // The theme toggle is an edit like any other: it goes through apply, so it
    // marks the document unsent and starts the same save.
    const edited = await tryStep("an edit is made while the server is refusing", async () => {
      await page.locator(".topbar button[title='Toggle theme']").click({ timeout: 5000 });
      // Longer than the ceiling on the debounce, so the save has certainly run.
      await page.waitForTimeout(11_000);
    });

    if (edited) {
      const state = await page.evaluate(() => ({
        puts: window.__puts,
        stored: JSON.parse(localStorage.getItem("sovereign.cloud.state.v1") ?? "{}"),
      }));
      check("a refused save is recorded rather than forgotten",
        state.stored.dirty === true && (state.stored.failures ?? 0) >= 1 && state.stored.nextTryAt > Date.now(),
        JSON.stringify(state.stored));

      // What used to retry it: every tick of the sixty-second poll, and every
      // return to the tab, both of which go through syncNow. Waiting out four
      // real minutes is not a test, so the same path is driven directly.
      const before = state.puts;
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem("sovereign.cloud.state.v1"));
        s.nextTryAt = Date.now() + 10 * 60_000;
        localStorage.setItem("sovereign.cloud.state.v1", JSON.stringify(s));
      });
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForTimeout(250);
      }
      const after = await page.evaluate(() => window.__puts);
      check("and is not sent again while it is waiting", after === before,
        `${after} puts, was ${before}`);
      check("which is what keeps a stuck tab from sending the whole budget every minute",
        after === before, `${after - before} extra copies went up`);

      // A wrong passphrase is not weather: it stops until somebody acts.
      const blocked = await page.evaluate(() => {
        window.fetch = async (input, init) => {
          const url = String(typeof input === "string" ? input : input.url);
          if (!url.includes("/api/db")) return window.__realFetch?.(input, init) ?? new Response("{}");
          if ((init?.method ?? "GET").toUpperCase() === "GET") {
            return new Response(JSON.stringify({ found: true, version: 1 }), { status: 200 });
          }
          window.__puts += 1;
          return new Response(JSON.stringify({ error: "Wrong passphrase." }), { status: 401 });
        };
        const s = JSON.parse(localStorage.getItem("sovereign.cloud.state.v1"));
        s.nextTryAt = 0; s.failures = 0;
        localStorage.setItem("sovereign.cloud.state.v1", JSON.stringify(s));
        return window.__puts;
      });
      void blocked;
    }
    await ctx.close();
  }

  if (want("compress")) {
    // ── the budget goes up compressed ──
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("sovereign.cloud.pass", "test-pass");
        localStorage.setItem("sovereign.cloud.state.v1", JSON.stringify({ version: 1, dirty: false }));
      } catch { /* private mode */ }
      window.__put = null;
      const real = window.fetch;
      window.fetch = async (input, init) => {
        const url = String(typeof input === "string" ? input : input.url);
        if (!url.includes("/api/db")) return real(input, init);
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return new Response(JSON.stringify({ found: true, version: 1, updatedAt: null, updatedBy: null, sealed: false }),
            { status: 200, headers: { "content-type": "application/json" } });
        }
        const body = JSON.parse(init.body);
        window.__put = { keys: Object.keys(body), bytes: init.body.length, hasZ: typeof body.z === "string" };
        return new Response(JSON.stringify({ version: 2, updatedAt: new Date().toISOString() }), { status: 200 });
      };
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    const saved = await tryStep("an edit is saved", async () => {
      await page.locator(".topbar button[title='Toggle theme']").click({ timeout: 5000 });
      await page.waitForTimeout(11_000);
    });
    if (saved) {
      const put = await page.evaluate(() => window.__put);
      const plain = await page.evaluate(() => localStorage.getItem("sovereign.db.v1")?.length ?? 0);
      check("a save carries the compressed form rather than the document",
        put !== null && put.hasZ && !put.keys.includes("doc"),
        put === null ? "no save was made" : put.keys.join(", "));
      check("and it is several times smaller than the budget itself",
        put !== null && plain > 0 && put.bytes * 4 < plain,
        put === null ? "no save" : `${Math.round(put.bytes / 1024)} KB on the wire against ${Math.round(plain / 1024)} KB of budget`);
    }
    await ctx.close();
  }

  if (want("budget")) {
    // ── the budget's columns, headers and bar ──
    //
    // The group header's figures and the rows beneath them are two separate
    // flex layouts that have to agree on where three columns sit. They stopped
    // agreeing the moment a group name grew long enough to wrap the header onto
    // its own line, where space-between had nothing left to space and the
    // columns went hard left — 180px out of step with the rows they label.

    /**
     * One document with long group names and a month put over budget: both
     * cases are invisible in the demo data as it ships.
     *
     * The factor is worked out from what the page itself reports rather than
     * guessed at. A fixed fraction of the plan is a bet on how much of the
     * month has been spent by the day the suite runs, and it is a bet that
     * comes good most days and quietly stops testing anything on the rest —
     * 35% held until the date rolled one day forward and month-to-date
     * spending slipped under it.
     */
    const budgetDoc = async () => {
      const seed = await browser.newContext();
      const p0 = await seed.newPage();
      await p0.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
      await p0.waitForTimeout(1200);
      const read = await p0.evaluate(() => {
        const money = (t) => Number((t.match(/-?[\d,]+(\.\d+)?/)?.[0] ?? "0").replace(/,/g, ""));
        const cell = [...document.querySelectorAll(".budget-stats > *")]
          .find((c) => /planned expenses/i.test(c.innerText));
        return {
          db: localStorage.getItem("sovereign.db.v1"),
          planned: money(cell.querySelector(".num").innerText),
          actual: money(cell.querySelector(".tiny").innerText),
        };
      });
      await seed.close();
      const db = JSON.parse(read.db);
      const income = new Set(db.categories
        .filter((c) => db.groups.find((g) => g.id === c.groupId)?.kind === "income")
        .map((c) => c.id));
      // Aim the plan at 60% of what was actually spent, so the bar is
      // decidedly over and the mark lands around three fifths along.
      const factor = read.planned > 0 ? (read.actual * 0.6) / read.planned : 0.5;
      const cut = (plan) => Object.fromEntries(Object.entries(plan)
        .map(([k, v]) => [k, income.has(k) ? v : Math.round(v * factor)]));
      return {
        ...db,
        groups: db.groups.map((g) => (g.kind === "income" ? g : { ...g, name: `${g.name} & Everything Else` })),
        // Every month, not just one: the page opens on whichever month is
        // current when the suite runs.
        budgets: Object.fromEntries(Object.entries(db.budgets).map(([m, plan]) => [m, cut(plan)])),
      };
    };

    const seeded = async (doc, width) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addInitScript((d) => {
        if (!localStorage.getItem("sovereign.db.v1")) localStorage.setItem("sovereign.db.v1", d);
      }, JSON.stringify(doc));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      return page;
    };

    const doc = await budgetDoc();

    // Every width, because the head's padding and gap track the row's at each
    // one and they are set in three separate places.
    for (const w of [1180, 700, 390, 360]) {
      const page = await seeded(doc, w);
      const offsets = await page.evaluate(() => [...document.querySelectorAll(".card")].map((card) => {
        const head = card.querySelector(".budget-head .bcol-plan");
        const row = card.querySelector(".list-row .bcol-plan");
        if (!head || !row) return null;
        const a = head.getBoundingClientRect(), b = row.getBoundingClientRect();
        return Math.round((a.left + a.width / 2) - (b.left + b.width / 2));
      }).filter((x) => x !== null));
      const worst = offsets.length ? Math.max(...offsets.map(Math.abs)) : -1;
      check(`${w}px — every Planned header sits over its own column, long names included`,
        offsets.length > 0 && worst <= 1, `worst ${worst}px out across ${offsets.length} groups`);

      if (w === 390) {
        const counted = await page.evaluate(() =>
          document.querySelectorAll(".card-head .row .tiny").length);
        check("a group no longer counts its own categories beside its name",
          counted === 0, `${counted} counts still there`);

        const grid = await page.evaluate(() => {
          const el = document.querySelector(".budget-stats");
          const cols = getComputedStyle(el).gridTemplateColumns.split(" ").map(parseFloat);
          const cell = el.firstElementChild;
          const mid = (r) => r.left + r.width / 2;
          const c = cell.getBoundingClientRect();
          return {
            n: cols.length,
            even: Math.max(...cols) - Math.min(...cols) < 1,
            wide: el.getBoundingClientRect().width > window.innerWidth * 0.7,
            centred: Math.abs(mid(cell.querySelector(".tile-label").getBoundingClientRect()) - mid(c)) < 2
              && Math.abs(mid(cell.querySelector(".num").getBoundingClientRect()) - mid(c)) < 2,
          };
        });
        check("390px — the four figures sit two to a row", grid.n === 2, `${grid.n} columns`);
        check("390px — sharing the width evenly, not by how long their labels are", grid.even === true);
        check("390px — across the whole card rather than bunched to one side", grid.wide === true);
        check("390px — with label and figure centred in their column", grid.centred === true);
      }
      await page.close();
    }

    // The bar: green inside the plan, red past it, and the plan marked only
    // once the bar has grown past it and it is no longer the bar's own end.
    const bar = async (page) => page.evaluate(() => {
      const el = document.querySelector(".bar");
      const b = el.getBoundingClientRect();
      const mk = el.querySelector(".bar-mark");
      return {
        fill: getComputedStyle(el.querySelector("i")).backgroundColor,
        marks: el.querySelectorAll(".bar-mark").length,
        at: mk ? Math.round(((mk.getBoundingClientRect().left + 1 - b.left) / b.width) * 100) : null,
      };
    });

    const plain = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await plain.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
    await plain.waitForTimeout(600);
    const good = await bar(plain);
    check("inside the plan the bar is green", good.fill === "rgb(53, 196, 140)", good.fill);
    check("and the plan is not marked, because the end of the bar is the plan",
      good.marks === 0, `${good.marks} marks`);
    await plain.close();

    const spent = await seeded(doc, 1180);
    const bad = await bar(spent);
    check("past the plan the bar is red", bad.fill === "rgb(242, 104, 94)", bad.fill);
    // Aimed at 60%, so anywhere near it proves the mark tracks the plan
    // rather than sitting at a fixed spot.
    check("and the plan is marked where it fell", bad.marks === 1 && bad.at > 45 && bad.at < 75,
      `${bad.marks} marks at ${bad.at}%`);
    await spent.close();
  }

  if (want("accounts")) {
    // ── the accounts headline ──
    //
    // A slider of kinds over a full-width chart, and choosing one has to move
    // three things at once: the figure, the line under it, and which accounts
    // are listed. A filter that changes only the list is the bug worth
    // guarding against, because it still looks like it worked.
    const acc = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await acc.goto(`${BASE}/accounts`, { waitUntil: "networkidle" });
    await acc.waitForTimeout(800);

    const pills = await acc.evaluate(() =>
      [...document.querySelectorAll(".scope-pill")].map((b) => b.innerText.trim()));
    check("the whole picture is offered first, then each kind",
      pills[0] === "Net Worth" && pills.length > 2, pills.join(" / "));

    const read = () => acc.evaluate(() => ({
      total: document.querySelector(".nw-value").innerText.trim(),
      groups: [...document.querySelectorAll(".acct-group-head h2")].map((h) => h.innerText.trim()),
      line: document.querySelector(".chart-wrap path[stroke]")?.getAttribute("d") ?? "",
    }));
    const all = await read();
    check("net worth lists every kind at once", all.groups.length > 2, all.groups.join(", "));

    const picked = pills.find((p) => p === "Investments") ?? pills[1];
    const filtered = await tryStep(`the ${picked} pill can be chosen`, async () => {
      await acc.locator(".scope-pill", { hasText: new RegExp(`^${picked}$`) }).click({ timeout: 5000 });
      await acc.waitForTimeout(700);
    });
    if (filtered) {
      const one = await read();
      check("choosing a kind narrows the list to it",
        one.groups.length === 1 && one.groups[0] === picked, one.groups.join(", "));
      check("and moves the headline figure with it", one.total !== all.total,
        `still ${one.total}`);
      check("and redraws the line, rather than leaving the old one under it",
        one.line !== all.line && one.line.length > 0, "the chart did not change");

      // The pill has to be readable after it is chosen, not half off the edge.
      const visible = await acc.evaluate(() => {
        const bar = document.querySelector(".scope-bar");
        const on = bar.querySelector('[aria-selected="true"]');
        const b = bar.getBoundingClientRect(), p = on.getBoundingClientRect();
        return p.left >= b.left - 1 && p.right <= b.right + 1;
      });
      check("and scrolls the chosen pill fully into view", visible === true);
    }

    // Where the line itself begins and ends, not where its wrapper sits: the
    // axis gutter is padding inside the SVG, so the wrapper spans the card
    // whether the line reaches the edges or stops 52px short of them.
    const spans = await acc.evaluate(() => {
      const wrap = document.querySelector(".nw-card .chart-wrap");
      const svg = wrap.querySelector("svg");
      const d = svg.querySelector("path[stroke]").getAttribute("d");
      const xs = [...d.matchAll(/[ML](-?[\d.]+),/g)].map((m) => parseFloat(m[1]));
      const card = document.querySelector(".nw-card");
      const w = wrap.getBoundingClientRect(), c = card.getBoundingClientRect();
      return {
        left: Math.round(Math.min(...xs)),
        right: Math.round(w.width - Math.max(...xs)),
        gutter: Math.round(w.left - c.left) + Math.round(c.right - w.right),
        ticks: svg.querySelectorAll(".axis-text").length,
      };
    });
    check("the chart runs edge to edge inside its card",
      spans.gutter <= 2 && spans.left <= 2 && spans.right <= 2,
      `line starts ${spans.left}px in and ends ${spans.right}px short, card margin ${spans.gutter}px`);
    check("and carries no axis labels, because the figures are spelled out above it",
      spans.ticks === 0, `${spans.ticks} axis labels`);

    // Changing the period changes the line and the figure beside it.
    const before = await read();
    const ranged = await tryStep("a longer period can be chosen", async () => {
      await acc.locator(".span-pill", { hasText: "1Y" }).click({ timeout: 5000 });
      await acc.waitForTimeout(700);
    });
    if (ranged) {
      const after = await read();
      check("a different period redraws the chart", after.line !== before.line);
      const said = await acc.evaluate(() => document.querySelector(".nw-head").innerText);
      check("and says which period it is now reporting", /1 year/.test(said), said.replace(/\n/g, " | "));
    }

    // ── dragging a finger along the line ──
    //
    // Everything the headline says has to follow the finger: the figure is
    // the one on the day under it, and the change is measured from the start
    // of the period to that day. A marker that moves while the figures above
    // it stay put is the failure this is aimed at — it still looks alive.
    const readHead = () => acc.evaluate(() => ({
      total: document.querySelector(".nw-value").innerText.trim(),
      head: document.querySelector(".nw-head").innerText.replace(/\n/g, " | ").trim(),
      // The period on its own. Reading it out of the whole header and
      // splitting on the dash catches the figures too, which move by design.
      period: document.querySelector(".nw-head .faint")?.innerText.trim() ?? "",
      dots: document.querySelectorAll(".nw-card .chart-wrap circle").length,
    }));
    const drag = (type, clientX, clientY, buttons) =>
      acc.dispatchEvent(".nw-card .chart-wrap svg", type,
        { pointerType: "touch", pointerId: 1, isPrimary: true, clientX, clientY, buttons });

    const rest = await readHead();
    const box = await acc.locator(".nw-card .chart-wrap").boundingBox();
    const midY = box.y + box.height / 2;

    const scrubbed = await tryStep("a finger can be put on the line", async () => {
      await drag("pointerdown", box.x + box.width * 0.25, midY, 1);
      await acc.waitForTimeout(200);
    });
    if (scrubbed) {
      const early = await readHead();
      check("a touch marks the day it landed on", early.dots === 1, `${early.dots} markers`);
      check("and the headline figure becomes that day's", early.total !== rest.total,
        `still ${early.total}`);
      check("and the period becomes the stretch dragged out, not the whole one",
        /\d{4}\s*[\u2013-]\s*\w/.test(early.period), early.period);

      await drag("pointermove", box.x + box.width * 0.75, midY, 1);
      await acc.waitForTimeout(200);
      const late = await readHead();
      check("dragging on moves the figure again",
        late.total !== early.total, `${early.total} then ${late.total}`);
      const startOf = (p) => p.split("\u2013")[0].trim();
      const endOf = (p) => p.split("\u2013")[1]?.trim() ?? "";
      check("and the window's end moves with it, while its start stays put",
        startOf(late.period) === startOf(early.period) && endOf(late.period) !== endOf(early.period),
        `${early.period} then ${late.period}`);

      await drag("pointerup", box.x + box.width * 0.75, midY, 0);
      await acc.waitForTimeout(300);
      const after = await readHead();
      check("and letting go gives the whole period back",
        after.total === rest.total && after.dots === 0 && after.head === rest.head, after.head);
    }

    // A chart that swallows vertical drags is a chart you cannot scroll past.
    const touch = await acc.evaluate(() =>
      getComputedStyle(document.querySelector(".nw-card .chart-wrap svg")).touchAction);
    check("the chart takes sideways drags without eating the page's scroll",
      touch === "pan-y", touch);

    await acc.close();
  }

  if (want("account-page")) {
    // ── one account's own page ──
    //
    // The same headline chart as the Accounts screen, and the same behaviour,
    // because it is the same component — which is the point of testing it
    // here too: a shared component is only shared until one of its callers
    // stops passing something.
    const one = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await one.goto(`${BASE}/accounts/a_checking`, { waitUntil: "networkidle" });
    await one.waitForTimeout(800);

    const shape = await one.evaluate(() => ({
      label: document.querySelector(".nw-head .tile-label")?.innerText.trim() ?? "",
      spans: [...document.querySelectorAll(".span-pill")].map((b) => b.innerText.trim()),
      chart: document.querySelectorAll(".nw-card .chart-wrap").length,
      axis: document.querySelectorAll(".nw-card .axis-text").length,
      // the things that used to sit between the chart and the transactions
      updateBox: /update balance/i.test(document.body.innerText),
      visibility: /where this account counts/i.test(document.body.innerText),
      onPage: /change any value, or add a date/i.test(document.body.innerText),
    }));
    check("an account leads with its balance over a chart", shape.chart === 1 && shape.label === "CURRENT BALANCE",
      `${shape.chart} charts, labelled "${shape.label}"`);
    check("with the same six periods under it",
      shape.spans.join(" ") === "1M 3M 6M YTD 1Y ALL", shape.spans.join(" "));
    check("and no axis labels, as on the accounts screen", shape.axis === 0, `${shape.axis}`);
    check("the update-balance box is gone", shape.updateBox === false);
    check("and visibility and balance history are off the page",
      shape.visibility === false && shape.onPage === false);

    // Transactions follow, with the way on to all of them at the end.
    const list = await one.evaluate(() => ({
      head: document.querySelectorAll(".card-head h2, .card-head .card-title").length,
      rows: document.querySelectorAll(".list-row").length,
      viewAll: document.querySelector(".view-all")?.getAttribute("href") ?? "",
    }));
    check("then the recent transactions, with a way through to the rest",
      list.rows > 3 && /^\/transactions\?account=/.test(list.viewAll),
      `${list.rows} rows, on to "${list.viewAll}"`);

    // Dragging works here too, and moves this account's own figure.
    const readOne = () => one.evaluate(() => ({
      total: document.querySelector(".nw-value").innerText.trim(),
      period: document.querySelector(".nw-head .faint")?.innerText.trim() ?? "",
    }));
    const rest = await readOne();
    const box = await one.locator(".nw-card .chart-wrap").boundingBox();
    const midY = box.y + box.height / 2;
    const held = await tryStep("the account's chart takes a finger", async () => {
      await one.dispatchEvent(".nw-card .chart-wrap svg", "pointerdown",
        { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: box.x + box.width * 0.3, clientY: midY, buttons: 1 });
      await one.waitForTimeout(250);
    });
    if (held) {
      const on = await readOne();
      check("and the balance shown follows it", on.total !== rest.total, `still ${on.total}`);
      check("as does the stretch it reports", /\d{4}\s*[\u2013-]\s*\w/.test(on.period), on.period);
      await one.dispatchEvent(".nw-card .chart-wrap svg", "pointerup",
        { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: box.x + box.width * 0.3, clientY: midY, buttons: 0 });
      await one.waitForTimeout(250);
    }

    // What was on the page is now behind the one button.
    const opened = await tryStep("the more menu opens", async () => {
      await one.locator('button[title="More"]').click({ timeout: 5000 });
      await one.waitForTimeout(350);
    });
    if (opened) {
      const items = await one.evaluate(() =>
        [...document.querySelectorAll(".menu button")].map((b) => b.innerText.trim()));
      for (const wanted of ["Edit account details", "Edit balance history", "Visibility and actions"]) {
        check(`the menu carries "${wanted}"`, items.some((t) => t === wanted), items.join(" | "));
      }

      const dialog = await tryStep("balance history opens as a dialog", async () => {
        await one.locator(".menu button", { hasText: "Edit balance history" }).click({ timeout: 5000 });
        await one.locator(".modal").waitFor({ timeout: 5000 });
        await one.waitForTimeout(300);
      });
      if (dialog) {
        const titles = await one.evaluate(() =>
          [...document.querySelectorAll(".modal h2, .modal .card-title")]
            .map((h) => h.innerText.trim()).filter((t) => /edit balance history/i.test(t)).length);
        check("and says its name once, not twice", titles === 1, `${titles} copies of the title`);
        check("and can still add and change points",
          await one.locator(".modal", { hasText: "Add a balance" }).count() === 1);
      }
    }
    await one.close();

    // ── the connection status card ──
    //
    // A balance that stopped arriving three weeks ago looks exactly like an
    // account nobody has spent from, right up until it matters. Seeded,
    // because the demo data is all hand-kept and would only ever exercise the
    // one state that cannot go wrong.
    const seedConn = await browser.newContext();
    const cp = await seedConn.newPage();
    await cp.goto(`${BASE}/accounts`, { waitUntil: "networkidle" });
    await cp.waitForTimeout(1200);
    const baseDoc = JSON.parse(await cp.evaluate(() => localStorage.getItem("sovereign.db.v1")));
    await seedConn.close();

    const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const connDoc = {
      ...baseDoc,
      settings: {
        ...baseDoc.settings, syncCadence: "daily",
        usage: { ...(baseDoc.settings.usage ?? {}), plaid: { period: "", count: 3, error: "Wells Fargo: login required" } },
      },
      accounts: baseDoc.accounts.map((a, i) =>
        i === 0 ? { ...a, syncSource: "plaid", lastSyncedAt: iso(2) }
        : i === 1 ? { ...a, syncSource: "simplefin", lastSyncedAt: iso(2) }
        : i === 2 ? { ...a, syncSource: "simplefin", lastSyncedAt: iso(24 * 9) }
        : { ...a, syncSource: undefined, lastSyncedAt: undefined }),
    };

    const connPage = async (index) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
      await ctx.addInitScript((d) => {
        if (!localStorage.getItem("sovereign.db.v1")) localStorage.setItem("sovereign.db.v1", d);
      }, JSON.stringify(connDoc));
      const page = await ctx.newPage();
      await page.goto(`${BASE}/accounts/${connDoc.accounts[index].id}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      return page;
    };
    const readConn = (page) => page.evaluate(() => {
      const cards = [...document.querySelectorAll(".card")];
      const card = cards.find((c) => /connection status/i.test(c.querySelector("h2")?.innerText ?? ""));
      if (!card) return null;
      const rows = [...card.querySelectorAll(".drow")].map((r) => [
        r.querySelector(".drow-label").innerText.trim(),
        r.querySelector(".drow-val").innerText.trim(),
      ]);
      return {
        labels: rows.map(([l]) => l),
        values: Object.fromEntries(rows),
        detail: card.querySelector(".conn-detail")?.innerText.trim() ?? "",
        last: cards.indexOf(card) === cards.length - 1,
        text: card.innerText.replace(/\n/g, " | "),
      };
    });

    const broke = await connPage(0);
    const attention = await readConn(broke);
    check("every account ends with its connection status",
      attention !== null && attention.last === true, "not the last card on the page");
    check("which says when it last updated, how it is, and who supplies it",
      attention !== null && attention.labels.join(" / ") === "Last update / Status / Data provider",
      attention?.labels.join(" / "));
    check("a provider that is failing shows up as needing attention",
      /needs attention/i.test(attention?.values.Status ?? ""), attention?.values.Status);
    check("and says out loud what to go and do about it",
      /login required/i.test(attention?.detail ?? ""), attention?.detail || "nothing said");
    await broke.close();

    const fine = await connPage(1);
    const connected = await readConn(fine);
    check("an account whose provider is fine reads as connected",
      /institution connected/i.test(connected?.values.Status ?? ""), connected?.values.Status);
    check("and names the provider behind it",
      connected?.values["Data provider"] === "SimpleFIN", connected?.values["Data provider"]);
    // Seeded two hours ago, so the row has to report roughly that — a label
    // with nothing behind it would otherwise pass every check above.
    check("and how long ago the balance actually arrived",
      /^[12]h ago/.test(connected?.values["Last update"] ?? ""), connected?.values["Last update"]);
    await fine.close();

    const late = await connPage(2);
    const stale = await readConn(late);
    check("one that has fallen behind its schedule says so, without crying broken",
      /not updating/i.test(stale?.values.Status ?? "") && !/attention/i.test(stale?.values.Status ?? ""),
      stale?.values.Status);
    await late.close();

    // The one that matters: a hand-kept account has no provider to fail, so a
    // broken provider elsewhere must not paint it as broken too.
    const byHand = await connPage(3);
    const manual = await readConn(byHand);
    check("an account nobody connected is not reported as a broken connection",
      /by hand/i.test(manual?.values.Status ?? "") && !/attention/i.test(manual?.text ?? ""),
      manual?.text);
    await byHand.close();
  }

  if (want("tx-filters")) {
    // ── the filters, behind the funnel ──
    //
    // Six controls used to run across the top of the page: two rows on a
    // laptop, four on a phone, and almost always set to "any". They are one
    // button now, and the risk of that move is a filter that is reachable but
    // no longer does anything — so each one is opened and used.
    const fp = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await fp.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await fp.waitForTimeout(800);

    const bar = await fp.evaluate(() => {
      const row = document.querySelector(".filter-bar");
      const search = row.querySelector(".search").getBoundingClientRect();
      const toggle = row.querySelector(".filter-toggle")?.getBoundingClientRect();
      return {
        controls: row.querySelectorAll("select, .btn:not(.filter-toggle)").length,
        lines: new Set([...row.children].map((c) => Math.round(c.getBoundingClientRect().top))).size,
        rightOfSearch: toggle ? toggle.left >= search.right - 1 : false,
        toggle: Boolean(toggle),
      };
    });
    check("the search row is the search and one funnel beside it",
      bar.toggle && bar.controls === 0, `${bar.controls} other controls still on the row`);
    check("the funnel sits at the far end of the search box", bar.rightOfSearch === true);
    check("and they share one line", bar.lines === 1, `${bar.lines} lines`);

    const counted = () => fp.evaluate(() => {
      const t = document.querySelector(".spread.small .muted")?.innerText ?? "";
      return Number((t.match(/[\d,]+/)?.[0] ?? "0").replace(/,/g, ""));
    });
    const badge = () => fp.evaluate(() =>
      document.querySelector(".filter-count")?.innerText.trim() ?? "");

    check("nothing is filtered to begin with", (await badge()) === "", await badge());
    const before = await counted();

    const open = await tryStep("the funnel opens the filters", async () => {
      await fp.locator(".filter-toggle").click({ timeout: 5000 });
      await fp.locator(".filter-panel").waitFor({ timeout: 5000 });
      await fp.waitForTimeout(300);
    });
    if (open) {
      const fields = await fp.evaluate(() =>
        [...document.querySelectorAll(".filter-panel .field > label")].map((l) => l.innerText.trim()));
      check("every filter is in the panel, each with its own name",
        fields.join(" / ") === "Show / Account / Category / Date / Tag", fields.join(" / "));

      // All of them have to be reachable without scrolling one out of sight.
      const fits = await fp.evaluate(() => {
        const panel = document.querySelector(".filter-panel");
        const last = panel.querySelector(".field:last-of-type");
        return last.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1;
      });
      check("and the last of them is not scrolled out of the panel", fits === true);

      // Using one narrows the list and the funnel says how many are on.
      await fp.locator(".filter-panel select").first().selectOption("income");
      await fp.waitForTimeout(400);
      const afterOne = await counted();
      check("choosing a filter narrows the list", afterOne < before, `${before} then ${afterOne}`);
      check("and the funnel carries how many are on", (await badge()) === "1", await badge());

      await fp.locator(".filter-panel select").nth(1).selectOption({ index: 1 });
      await fp.waitForTimeout(400);
      check("a second filter counts as two", (await badge()) === "2", await badge());
      check("and narrows it further", (await counted()) < afterOne);

      // Between-dates puts two date fields in the panel rather than off it.
      const dateSelect = fp.locator(".filter-panel .field", { hasText: "Date" }).locator("select").first();
      await dateSelect.selectOption("between");
      await fp.waitForTimeout(400);
      const bounds = await fp.evaluate(() => {
        const panel = document.querySelector(".filter-panel");
        const dates = [...panel.querySelectorAll('input[type="date"]')];
        const r = panel.getBoundingClientRect();
        return {
          n: dates.length,
          inside: dates.every((d) => {
            const b = d.getBoundingClientRect();
            return b.left >= r.left - 1 && b.right <= r.right + 1;
          }),
        };
      });
      check("between-dates gives two bounds, both inside the panel",
        bounds.n === 2 && bounds.inside === true, `${bounds.n} bounds, inside: ${bounds.inside}`);

      const cleared = await tryStep("everything can be cleared at once", async () => {
        await fp.locator(".filter-panel button", { hasText: "Clear all" }).click({ timeout: 5000 });
        await fp.waitForTimeout(500);
      });
      if (cleared) {
        check("clearing puts the whole list back", (await counted()) === before,
          `${await counted()} of ${before}`);
        check("and takes the count off the funnel", (await badge()) === "", await badge());
      }
    }
    await fp.close();
  }

  if (want("dashboard")) {
    // ── the dashboard ──
    const dash = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await dash.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await dash.waitForTimeout(900);

    const cards = await dash.evaluate(() =>
      [...document.querySelectorAll(".page > .card")].map((c) =>
        (c.querySelector("h2")?.innerText ?? c.querySelector(".tile-label")?.innerText ?? "").trim()));
    // Lower-cased on both sides: the net worth card's name is a tile label,
    // which CSS puts in capitals, and the test is about which cards are there
    // rather than about how they are typeset.
    check("the dashboard is the six cards, in that order",
      cards.join(" / ").toLowerCase() === "net worth / spending / budget / recurring / goals / investments",
      cards.join(" / "));
    const body = await dash.evaluate(() => document.body.innerText);
    check("and recent transactions is not one of them", !/recent transactions/i.test(body));
    check("nor credit score, which was taken out for want of an API to feed it",
      !/credit score/i.test(body));

    // Net worth: the same scrubbable chart as everywhere else.
    const nw = await dash.evaluate(() => ({
      label: document.querySelector(".nw-head .tile-label")?.innerText.trim() ?? "",
      spans: document.querySelectorAll(".span-pill").length,
      axis: document.querySelectorAll(".nw-card .axis-text").length,
    }));
    check("net worth leads with the shared chart, periods and all",
      nw.label === "NET WORTH" && nw.spans === 6 && nw.axis === 0,
      `${nw.label}, ${nw.spans} periods, ${nw.axis} axis labels`);

    // Spending: this month stops at today, last month runs the whole month.
    const spend = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Spending/.test(c.querySelector("h2")?.innerText ?? ""));
      const paths = [...card.querySelectorAll("path[stroke]")];
      const xs = (d) => [...d.matchAll(/[ML](-?[\d.]+),/g)].map((m) => parseFloat(m[1]));
      const [prior, now] = paths.map((p) => xs(p.getAttribute("d")));
      return {
        lines: paths.length,
        priorEnd: Math.max(...prior),
        nowEnd: Math.max(...now),
        keys: [...card.querySelectorAll(".cmp-key span")].map((e) => e.innerText.trim()),
      };
    });
    check("spending draws both months on one scale", spend.lines === 2, `${spend.lines} lines`);
    check("this month stops short of last month, because the month is not over",
      spend.nowEnd < spend.priorEnd, `this ${spend.nowEnd} vs last ${spend.priorEnd}`);
    check("and says which line is which",
      spend.keys.join(" / ") === "This month / Last month", spend.keys.join(" / "));

    // Budget: the marker is where today falls in the month, not where the
    // spending got to — that is what the bar itself already says.
    const budget = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Budget/.test(c.querySelector("h2")?.innerText ?? ""));
      const bar = card.querySelector(".bar");
      const mark = bar.querySelector(".bar-mark");
      const b = bar.getBoundingClientRect();
      const day = Number(new Date().toISOString().slice(8, 10));
      const days = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      return {
        at: mark ? (mark.getBoundingClientRect().left + 1 - b.left) / b.width : null,
        want: day / days,
        rows: [...card.querySelectorAll(".spread")].map((r) => r.innerText.replace(/\n/g, " ")).join(" | "),
      };
    });
    check("the budget bar marks where today falls in the month",
      budget.at !== null && Math.abs(budget.at - budget.want) < 0.04,
      `mark at ${budget.at === null ? "nowhere" : Math.round(budget.at * 100)}%, today is ${Math.round(budget.want * 100)}% through`);
    // Red once spending is ahead of the calendar, not only once it is past the
    // plan outright — which is the whole reason the mark is there.
    const pace = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Budget/.test(c.querySelector("h2")?.innerText ?? ""));
      const lines = [...card.querySelectorAll(".col > .col")];
      const read = (el) => {
        const bar = el.querySelector(".bar");
        const b = bar.getBoundingClientRect();
        const fill = bar.querySelector("i").getBoundingClientRect();
        const mk = bar.querySelector(".bar-mark");
        return {
          label: el.querySelector("span").innerText.trim(),
          red: getComputedStyle(bar.querySelector("i")).backgroundColor === "rgb(242, 104, 94)",
          past: mk ? fill.right > mk.getBoundingClientRect().left : fill.width / b.width > 0.5,
        };
      };
      return lines.map(read);
    });
    const expenses = pace.find((l) => /expenses/i.test(l.label));
    check("expenses past the mark are red, not green",
      expenses !== undefined && expenses.red === expenses.past,
      `expenses ${expenses?.past ? "past" : "short of"} the mark and ${expenses?.red ? "red" : "green"}`);
    const income = pace.find((l) => /income/i.test(l.label));
    check("income stays green whatever it does, because behind on it is not the same news",
      income !== undefined && income.red === false);

    check("the budget card's link says where it goes",
      (await dash.evaluate(() => {
        const card = [...document.querySelectorAll(".card")].find((c) => /^Budget/.test(c.querySelector("h2")?.innerText ?? ""));
        return card.querySelector("a.link")?.innerText.trim() ?? "";
      })) === "Budget");

    check("and reports income and expenses against their plans",
      /planned/.test(budget.rows) && /earned/.test(budget.rows) && /spent/.test(budget.rows),
      budget.rows.slice(0, 120));

    // Goals: every live one, with how it moved this month.
    const goals = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Goals/.test(c.querySelector("h2")?.innerText ?? ""));
      if (!card) return null;
      return {
        head: card.querySelector(".dash-card-head").innerText.replace(/\n/g, " | "),
        rows: [...card.querySelectorAll(".goal-row")].map((r) => ({
          text: r.innerText.replace(/\n/g, " | "),
          href: r.getAttribute("href"),
          bars: r.querySelectorAll(".bar").length,
        })),
      };
    });
    check("goals lists every live goal, each with a bar and a way into it",
      goals !== null && goals.rows.length > 1
      && goals.rows.every((r) => r.bars === 1 && /^\/goals\//.test(r.href ?? "")),
      goals === null ? "no goals card" : `${goals.rows.length} rows`);
    check("and totals how they moved this month",
      /this month/.test(goals?.head ?? ""), goals?.head);
    check("with a standing on each — ahead, at risk, or no target date",
      goals !== null && goals.rows.every((r) => /ahead|at risk|on track|completed|no target date|no plan/i.test(r.text)),
      goals?.rows.map((r) => r.text.slice(0, 40)).join(" / "));

    // Recurring: what is still ahead, and what it comes to.
    const rec = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Recurring/.test(c.querySelector("h2")?.innerText ?? ""));
      return { head: card.querySelector(".dash-card-head").innerText.replace(/\n/g, " | "), rows: card.querySelectorAll(".list-row").length };
    });
    check("recurring says what is still due and lists what is coming",
      /still due this month/.test(rec.head) && rec.rows > 0, `${rec.head} — ${rec.rows} rows`);

    await dash.close();
  }

  if (want("merchants")) {
    // ── the merchants directory ──
    const mer = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await mer.goto(`${BASE}/merchants`, { waitUntil: "networkidle" });
    await mer.waitForTimeout(800);

    const read = () => mer.evaluate(() => ({
      rows: [...document.querySelectorAll(".list-row")].map((r) => ({
        name: r.querySelector(".truncate")?.innerText.trim() ?? "",
        count: Number((r.innerText.match(/([\d,]+) transaction/)?.[1] ?? "0").replace(/,/g, "")),
        href: r.getAttribute("href"),
      })),
      summary: document.querySelector(".card .spread")?.innerText.replace(/\n/g, " | ") ?? "",
      // The list is paged at 60, so its length says nothing about how many
      // merchants there are; the summary line is the figure to compare.
      merchants: Number((document.querySelector(".card .spread")?.innerText.match(/([\d,]+) merchant/)?.[1] ?? "0").replace(/,/g, "")),
    }));

    const first = await read();
    check("every merchant is listed", first.rows.length > 5, `${first.rows.length} rows`);

    // The point of the screen: it counts spending, so the things you pay
    // whatever you do are not competing with the things you choose.
    check("and it counts purchases, saying so",
      /purchases/.test(first.summary) && !/transactions in all/.test(first.summary), first.summary);
    const spendingNames = first.rows.map((r) => r.name.toLowerCase());
    check("payroll and card payments are not merchants you shopped at",
      !spendingNames.some((n) => /payroll|payment thank you/.test(n)),
      spendingNames.slice(0, 8).join(", "));
    check("busiest first", first.rows.every((r, i) => i === 0 || r.count <= first.rows[i - 1].count),
      first.rows.slice(0, 4).map((r) => `${r.name} ${r.count}`).join(", "));
    check("each says how many transactions it has",
      first.rows.every((r) => r.count > 0), "a row with no count");
    check("and how many there are in all",
      /merchants/.test(first.summary) && /[\d,]+ purchases/.test(first.summary), first.summary);

    // A row goes to that merchant's own page — the drill-down that already
    // exists, not a second one.
    const opened = await tryStep("a merchant can be opened", async () => {
      await mer.locator(".list-row").first().click({ timeout: 5000 });
      await mer.waitForTimeout(700);
    });
    if (opened) {
      const where = new URL(mer.url()).pathname;
      check("which is the merchant drill-down, not a new screen",
        where.startsWith("/merchants/") && decodeURIComponent(where.slice(11)) === first.rows[0].name,
        `${where} for ${first.rows[0].name}`);
      check("and the drill-down carries its way back",
        (await mer.evaluate(() => document.querySelector(".topbar-back")?.getAttribute("href") ?? "")) === "/transactions");
      await mer.goBack();
      await mer.waitForTimeout(600);
    }

    // Searching narrows it without changing what the rows mean.
    const searched = await tryStep("merchants can be searched", async () => {
      await mer.locator(".search input").fill(first.rows[0].name.slice(0, 4));
      await mer.waitForTimeout(500);
    });
    if (searched) {
      const after = await read();
      check("searching narrows the list to what matches",
        after.rows.length > 0 && after.rows.length < first.rows.length
        && after.rows.every((r) => r.name.toLowerCase().includes(first.rows[0].name.slice(0, 4).toLowerCase())),
        `${after.rows.length} of ${first.rows.length}`);
    }

    // But nothing is hidden for good: the whole list is still one filter away.
    // The search from the step above has to come off first, or this compares
    // a widened list of one merchant against an unfiltered list of sixty.
    const widened = await tryStep("the filter can widen it to everything", async () => {
      await mer.locator(".search input").fill("");
      await mer.waitForTimeout(300);
      await mer.locator(".filter-toggle").click({ timeout: 5000 });
      await mer.locator(".filter-panel").waitFor({ timeout: 5000 });
      await mer.locator(".filter-panel select").first().selectOption("all");
      await mer.waitForTimeout(500);
    });
    if (widened) {
      const all = await read();
      check("widening brings back what spending left out",
        all.merchants > first.merchants
        && all.rows.some((r) => /payroll|payment thank you/i.test(r.name)),
        `${all.merchants} merchants against ${first.merchants}`);
      check("and the funnel says one filter is on",
        (await mer.evaluate(() => document.querySelector(".filter-count")?.innerText.trim() ?? "")) === "1");
      await mer.locator(".filter-panel select").first().selectOption("spending");
      await mer.waitForTimeout(400);
      await mer.keyboard.press("Escape");
      await mer.waitForTimeout(300);
    }

    // And it can be asked the other question instead.
    await mer.locator(".search input").fill("");
    await mer.waitForTimeout(400);
    const resorted = await tryStep("it can be sorted by what was spent", async () => {
      await mer.locator(".seg button", { hasText: "Most spent" }).click({ timeout: 5000 });
      await mer.waitForTimeout(500);
    });
    if (resorted) {
      const spent = await read();
      check("sorting by spending puts the biggest outgoing first",
        spent.rows[0].name !== first.rows[0].name || first.rows.length < 2,
        `still ${spent.rows[0].name}`);
    }
    await mer.close();

    // It has to be reachable, on both shapes of screen.
    const rail = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await rail.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await rail.waitForTimeout(600);
    const order = await rail.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href]")].map((a) => a.getAttribute("href")));
    check("Merchants sits after Reports in the rail",
      order.indexOf("/merchants") === order.indexOf("/reports") + 1,
      order.join(" "));
    await rail.close();
  }

  if (want("reports")) {
    // ── the three report tabs ──
    const rep = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await rep.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
    await rep.waitForTimeout(900);

    const tabs = await rep.evaluate(() =>
      [...document.querySelectorAll(".page > .seg button")].map((b) => b.innerText.trim()));
    check("reports opens on three tabs", tabs.join(" / ") === "Cash Flow / Spending / Income", tabs.join(" / "));

    // Separated buttons sharing the width equally, on one line — not a pill,
    // and not three buttons of three different widths.
    const strip = await rep.evaluate(() => {
      const boxes = [...document.querySelectorAll(".page > .seg button")]
        .map((b) => b.getBoundingClientRect());
      const gaps = boxes.slice(1).map((b, i) => b.left - boxes[i].right);
      return {
        widths: boxes.map((b) => Math.round(b.width)),
        tops: [...new Set(boxes.map((b) => Math.round(b.top)))],
        gaps: gaps.map((g) => Math.round(g)),
        wrap: Math.round(document.querySelector(".page > .seg").getBoundingClientRect().width),
        span: Math.round(boxes[boxes.length - 1].right - boxes[0].left),
      };
    });
    check("the tabs are equal separated buttons on one line",
      strip.tops.length === 1 && Math.max(...strip.widths) - Math.min(...strip.widths) <= 2
      && strip.gaps.every((g) => g >= 4),
      `widths ${strip.widths.join("/")}, gaps ${strip.gaps.join("/")}, ${strip.tops.length} lines`);
    check("and they are spread across the whole width",
      strip.wrap - strip.span <= 2, `${strip.span} of ${strip.wrap}`);

    // Cash flow: bars with a real zero between them, and a savings line.
    const bars = await rep.evaluate(() => {
      const svg = document.querySelector(".card .chart-wrap svg");
      const rects = [...svg.querySelectorAll("rect")].filter((r) => r.getAttribute("fill") !== "transparent");
      const green = rects.filter((r) => getComputedStyle(r).fill === "rgb(53, 196, 140)");
      const red = rects.filter((r) => getComputedStyle(r).fill === "rgb(242, 104, 94)");
      // The zero line the chart actually drew, not the middle of the svg: the
      // plot is inset unevenly top and bottom, so those are seven pixels apart
      // and the bars straddle the first of them.
      const axis = [...svg.querySelectorAll("line")].find((l) => !l.classList.contains("grid-line"));
      const mid = axis.getBoundingClientRect().top;
      return {
        green: green.length, red: red.length,
        greenAbove: green.every((r) => r.getBoundingClientRect().bottom <= mid + 6),
        redBelow: red.every((r) => r.getBoundingClientRect().top >= mid - 6),
        // A path with stroke="none" still matches [stroke], so the line is
        // counted by what it actually draws: a visible colour, a real width,
        // and a run with a point per bucket rather than a stub.
        line: [...svg.querySelectorAll("path")].filter((p) => {
          const st = getComputedStyle(p);
          return st.stroke !== "none" && parseFloat(st.strokeWidth) > 0
            && (p.getAttribute("d") ?? "").split("L").length > 3;
        }).length,
      };
    });
    check("cash flow puts income above the line and spending below it",
      bars.green > 3 && bars.red > 3 && bars.greenAbove && bars.redBelow,
      `${bars.green} up, ${bars.red} down`);
    check("with what was saved drawn across them", bars.line >= 1, `${bars.line} lines`);

    // The pair used to sit side by side. A month is one column now, which is
    // also what buys the extra width each bar got.
    const columns = await rep.evaluate(() => {
      const svg = document.querySelector(".card .chart-wrap svg");
      const at = (fill) => [...svg.querySelectorAll("rect")]
        .filter((r) => getComputedStyle(r).fill === fill)
        .map((r) => {
          const b = r.getBoundingClientRect();
          return { mid: Math.round((b.left + b.right) / 2), w: Math.round(b.width) };
        });
      const up = at("rgb(53, 196, 140)");
      const down = at("rgb(242, 104, 94)");
      return {
        paired: down.filter((d) => up.some((u) => Math.abs(u.mid - d.mid) <= 1)).length,
        down: down.length,
        columns: new Set([...up, ...down].map((r) => r.mid)).size,
        months: up.length,
        width: Math.min(...[...up, ...down].map((r) => r.w)),
      };
    });
    check("income and spending share one vertical line per period",
      columns.down > 3 && columns.paired === columns.down && columns.columns === columns.months,
      `${columns.paired}/${columns.down} paired, ${columns.columns} columns for ${columns.months} periods`);
    check("and the bars are wide enough to read", columns.width >= 10, `${columns.width}px wide`);

    // The second control is the chart's own, and only its own.
    const readControls = () => rep.evaluate(() =>
      [...document.querySelectorAll(".report-controls .field")].map((f) => f.querySelector("span").innerText.trim()));
    check("bars are asked for a timeframe", (await readControls()).join(" / ") === "Chart / Timeframe",
      (await readControls()).join(" / "));
    const oneLine = await rep.evaluate(() =>
      new Set([...document.querySelectorAll(".report-controls .field")]
        .map((f) => Math.round(f.getBoundingClientRect().top))).size);
    check("and both dropdowns sit on the same line, even on a phone", oneLine === 1, `${oneLine} lines`);

    const yearly = await tryStep("the timeframe can be changed", async () => {
      await rep.locator(".report-controls select").nth(1).selectOption("yearly");
      await rep.waitForTimeout(600);
    });
    if (yearly) {
      const labels = await rep.evaluate(() =>
        [...document.querySelectorAll(".card .chart-wrap .axis-text")].map((t) => t.textContent.trim())
          .filter((t) => /^\d{4}$/.test(t)));
      check("yearly buckets the bars into years", labels.length >= 1, labels.join(" "));
      await rep.locator(".report-controls select").nth(1).selectOption("monthly");
      await rep.waitForTimeout(500);
    }

    const drawn = await tryStep("the chart can be switched to a sankey", async () => {
      await rep.locator(".report-controls select").first().selectOption("sankey");
      await rep.waitForTimeout(700);
    });
    if (drawn) {
      check("a sankey is asked how to group instead",
        (await readControls()).join(" / ") === "Chart / Group by", (await readControls()).join(" / "));
      const sank = await rep.evaluate(() => {
        const wrap = document.querySelector(".card .chart-wrap");
        // The diagram is laid out wider than the phone, so a label belongs
        // inside the drawing, not inside the window it is read through.
        const drawn = wrap.firstElementChild.getBoundingClientRect();
        const labels = [...wrap.querySelectorAll("text")];
        return {
          bands: wrap.querySelectorAll("path").length,
          nodes: wrap.querySelectorAll("svg > g > rect").length,
          outside: labels.filter((t) => {
            const b = t.getBoundingClientRect();
            return b.right > drawn.right + 1 || b.left < drawn.left - 1;
          }).length,
          scrolls: wrap.scrollWidth - wrap.clientWidth,
          overflow: getComputedStyle(wrap).overflowX,
          snapAt: [...wrap.querySelectorAll(".sankey-snap")]
            .map((n) => Math.round(n.getBoundingClientRect().left - drawn.left)),
          columns: [...new Set([...wrap.querySelectorAll("svg > g > rect")]
            .map((r) => Math.round(r.getBoundingClientRect().left - drawn.left)))].sort((a, b) => a - b),
        };
      });
      check("the sankey draws a band per flow", sank.bands > 2 && sank.nodes > 2,
        `${sank.bands} bands, ${sank.nodes} nodes`);
      // The failure this replaces: category names ran off the side of the card.
      check("and every label stays inside the drawing", sank.outside === 0, `${sank.outside} labels outside`);
      // On a phone it is read one column at a time, scrolled sideways.
      check("on a phone the sankey scrolls sideways rather than squeezing",
        sank.scrolls > 60 && sank.overflow === "auto", `${sank.scrolls}px of overflow, overflow-x ${sank.overflow}`);
      // Vertical room is what gets a band its figure: they are drawn in
      // proportion, so a diagram that fits the fold labels only its biggest.
      const tall = await rep.evaluate(() => {
        const wrap = document.querySelector(".card .chart-wrap");
        const bands = [...wrap.querySelectorAll("svg > g")].map((g) => {
          const r = g.querySelector("rect").getBoundingClientRect();
          return { col: Math.round(r.left), h: r.height, texts: g.querySelectorAll("text").length };
        });
        // A band's weight is its share of its own column, taken off the drawing
        // rather than the figures, so bands too small to print one still count.
        const totals = new Map();
        for (const b of bands) totals.set(b.col, (totals.get(b.col) ?? 0) + b.h);
        const weight = (b) => b.h / totals.get(b.col);
        return {
          height: Math.round(wrap.getBoundingClientRect().height),
          bands: bands.length,
          // A band under nine pixels gets no label at all, and one under
          // twenty-six no figure — so height is what turns stripes into rows.
          mute: bands.filter((b) => weight(b) >= 0.02 && b.texts < 1).length,
          figureless: bands.filter((b) => weight(b) >= 0.08 && b.texts < 2).length,
        };
      });
      check("the sankey takes the height its bands need",
        tall.height >= tall.bands * 40, `${tall.height}px for ${tall.bands} bands`);
      check("so a band worth 2% of its side is named rather than left a stripe",
        tall.mute === 0, `${tall.mute} of ${tall.bands} unnamed`);
      check("and one worth 8% carries its figure as well",
        tall.figureless === 0, `${tall.figureless} of ${tall.bands} without a figure`);

      check("with a snap point per column",
        sank.snapAt.length === sank.columns.length
        && sank.snapAt.every((x, i) => i === 0 || x > sank.snapAt[i - 1]),
        `snaps at ${sank.snapAt.join(", ")} for columns at ${sank.columns.join(", ")}`);
      const swiped = await tryStep("a swipe lands on the next column", async () => {
        await rep.evaluate((x) => {
          document.querySelector(".card .chart-wrap").scrollLeft = x;
        }, sank.snapAt[1]);
        await rep.waitForTimeout(400);
      });
      if (swiped) {
        const second = await rep.evaluate(() => {
          const wrap = document.querySelector(".card .chart-wrap");
          const box = wrap.getBoundingClientRect();
          return [...wrap.querySelectorAll("svg > g")].filter((g) => {
            const b = g.getBoundingClientRect();
            return b.left >= box.left - 1 && b.right <= box.right + 1;
          }).length;
        });
        check("and the column it lands on is whole", second > 0, `${second} bands fully in view`);
        await rep.evaluate(() => { document.querySelector(".card .chart-wrap").scrollLeft = 0; });
      }
      await rep.locator(".report-controls select").first().selectOption("bar");
      await rep.waitForTimeout(500);
    }

    // Spending: a ring whose slices add up to the figure in the middle of it.
    const onSpending = await tryStep("the spending tab opens", async () => {
      await rep.locator(".page > .seg button", { hasText: "Spending" }).click({ timeout: 5000 });
      await rep.waitForTimeout(800);
    });
    if (onSpending) {
      const ring = await rep.evaluate(() => {
        const money = (t) => Number((t.match(/-?[\d,]+(\.\d+)?/)?.[0] ?? "0").replace(/,/g, ""));
        const card = document.querySelector(".card");
        const centre = money(card.querySelector(".chart-wrap .num, .num").innerText);
        const keys = [...card.querySelectorAll(".donut-key > .row")].map((r) => ({
          label: r.querySelector(".truncate").innerText.trim(),
          value: money(r.querySelector(".num").innerText),
        }));
        return { centre, keys, sum: keys.reduce((s, k) => s + k.value, 0) };
      });
      check("the ring's key adds up to the figure in the middle of it",
        Math.abs(ring.sum - ring.centre) <= 1, `key ${ring.sum} against centre ${ring.centre}`);
      check("and a long tail is folded into a labelled band rather than dropped",
        ring.keys.some((k) => /everything else/i.test(k.label)) || ring.keys.length < 8,
        ring.keys.map((k) => k.label).join(", "));

      // The ring used to be pinned to the left edge by a key that grew to
      // fill the rest of the row.
      const centred = await rep.evaluate(() => {
        const wrap = document.querySelector(".donut-wrap").getBoundingClientRect();
        const ring = document.querySelector(".donut-wrap > div").getBoundingClientRect();
        return {
          left: Math.round(ring.left - wrap.left),
          right: Math.round(wrap.right - ring.right),
        };
      });
      check("the ring is centred in its card rather than pinned left",
        centred.left > 4 && Math.abs(centred.left - centred.right) <= 3,
        `${centred.left}px left, ${centred.right}px right`);

      const sums = await rep.evaluate(() =>
        [...document.querySelectorAll(".report-sum")].map((r) => r.innerText.replace(/\n/g, " ")));
      check("the summary reports the four figures Monarch's does",
        /total spending/i.test(sums.join(" ")) && /total transactions/i.test(sums.join(" "))
        && /largest/i.test(sums.join(" ")) && /average/i.test(sums.join(" ")),
        sums.join(" | "));

      // Rows go where they say. A group has no page, so it does not pretend to.
      const rows = await rep.evaluate(() =>
        [...document.querySelectorAll(".report-row")].map((r) => ({ tag: r.tagName, href: r.getAttribute("href") })));
      check("a category row leads to its own page",
        rows.length > 0 && rows.every((r) => r.tag === "A" && /^\/categories\//.test(r.href ?? "")),
        rows.slice(0, 3).map((r) => `${r.tag} ${r.href}`).join(", "));

      const grouped = await tryStep("the breakdown can be cut by group", async () => {
        await rep.locator(".dash-card-head .seg button", { hasText: "Group" }).first().click({ timeout: 5000 });
        await rep.waitForTimeout(600);
      });
      if (grouped) {
        const groupRows = await rep.evaluate(() =>
          [...document.querySelectorAll(".report-row")].map((r) => r.tagName));
        check("and a group row does not pretend to lead anywhere",
          groupRows.length > 0 && groupRows.every((t) => t === "DIV"), groupRows.join(","));
      }
    }

    // Income is the same screen, the other way up.
    const onIncome = await tryStep("the income tab opens", async () => {
      await rep.locator(".page > .seg button", { hasText: "Income" }).click({ timeout: 5000 });
      await rep.waitForTimeout(800);
    });
    if (onIncome) {
      const text = await rep.evaluate(() => document.body.innerText);
      check("income reports income, not spending",
        /total income/i.test(text) && !/total spending/i.test(text), text.slice(0, 60));
    }
    await rep.close();

    // The same three answers on a desktop, where there is width to waste.
    const wide = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await wide.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
    await wide.waitForTimeout(900);
    const wideStrip = await wide.evaluate(() => {
      const boxes = [...document.querySelectorAll(".page > .seg button")].map((b) => b.getBoundingClientRect());
      return {
        widths: boxes.map((b) => Math.round(b.width)),
        span: Math.round(boxes[boxes.length - 1].right - boxes[0].left),
        wrap: Math.round(document.querySelector(".page > .seg").getBoundingClientRect().width),
      };
    });
    check("the tabs stay equal and spread on a desktop too",
      Math.max(...wideStrip.widths) - Math.min(...wideStrip.widths) <= 2
      && wideStrip.wrap - wideStrip.span <= 2,
      `widths ${wideStrip.widths.join("/")}, ${wideStrip.span} of ${wideStrip.wrap}`);
    const wideRing = await tryStep("the spending tab opens on a desktop", async () => {
      await wide.locator(".page > .seg button", { hasText: "Spending" }).click({ timeout: 5000 });
      await wide.waitForTimeout(800);
    });
    if (wideRing) {
      const box = await wide.evaluate(() => {
        const wrap = document.querySelector(".donut-wrap").getBoundingClientRect();
        const kids = [...document.querySelectorAll(".donut-wrap > *")].map((k) => k.getBoundingClientRect());
        return {
          left: Math.round(Math.min(...kids.map((k) => k.left)) - wrap.left),
          right: Math.round(wrap.right - Math.max(...kids.map((k) => k.right))),
        };
      });
      check("the ring and its key are centred as a pair on a desktop",
        box.left > 8 && Math.abs(box.left - box.right) <= 3, `${box.left}px left, ${box.right}px right`);
    }
    await wide.close();
  }

} finally {
  await browser.close();
}

for (const [state, name, msg] of results) console.log(`${state}  ${name}${msg ? ` — ${msg}` : ""}`);
if (skipped.length) console.log(`\nSKIPPED  ${skipped.join(", ")} — this was not a full run`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

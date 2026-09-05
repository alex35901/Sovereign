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
 * phone-nav, nested-menu, drilldown-back, drilldown-scroll, goals, detail, budget.
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

  if (want("budget")) {
    // ── the budget's columns, headers and bar ──
    //
    // The group header's figures and the rows beneath them are two separate
    // flex layouts that have to agree on where three columns sit. They stopped
    // agreeing the moment a group name grew long enough to wrap the header onto
    // its own line, where space-between had nothing left to space and the
    // columns went hard left — 180px out of step with the rows they label.

    /** One document with long group names and a month put over budget: both
     *  cases are invisible in the demo data as it ships. */
    const budgetDoc = async () => {
      const seed = await browser.newContext();
      const p0 = await seed.newPage();
      await p0.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
      await p0.waitForTimeout(1200);
      const raw = await p0.evaluate(() => localStorage.getItem("sovereign.db.v1"));
      await seed.close();
      const db = JSON.parse(raw);
      const income = new Set(db.categories
        .filter((c) => db.groups.find((g) => g.id === c.groupId)?.kind === "income")
        .map((c) => c.id));
      // Every month, not just one: the page opens on whichever month is
      // current when the suite runs, and cutting the wrong one leaves the bar
      // comfortably green and the test quietly measuring nothing.
      const cut = (plan) => Object.fromEntries(Object.entries(plan)
        .map(([k, v]) => [k, income.has(k) ? v : Math.round(v * 0.35)]));
      return {
        ...db,
        groups: db.groups.map((g) => (g.kind === "income" ? g : { ...g, name: `${g.name} & Everything Else` })),
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
    check("and the plan is marked where it fell", bad.marks === 1 && bad.at > 20 && bad.at < 99,
      `${bad.marks} marks at ${bad.at}%`);
    await spent.close();
  }

} finally {
  await browser.close();
}

for (const [state, name, msg] of results) console.log(`${state}  ${name}${msg ? ` — ${msg}` : ""}`);
if (skipped.length) console.log(`\nSKIPPED  ${skipped.join(", ")} — this was not a full run`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

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
* rule-conditions, phone-nav, nested-menu, drilldown-back, drilldown-scroll, goals, detail, explain, recurring, notifications, retry, compress, budget, accounts, account-page, tx-filters, tx-select, dashboard, merchants, reports, investments, forecast, estate, books, sorting, payoff, tax, price, year, drill-pick, smoke, draw, import-route, duplicate, amounts, calendar, history, mark-recurring, repeat-mark, wallet, settings-trim, not-saved.
 * Push on a full run, always — a filter is for the loop, not for the verdict.
 */
const BASE = process.env.PREVIEW_URL ?? "http://localhost:4173";
const CHROME = process.env.CHROME_PATH;

// Playwright is a devDependency, and checked for anyway.
//
// It used to be kept out of package.json on the grounds that it pulls a browser
// down on install and every Vercel build would pay for that. That stopped being
// true: since 1.5x the package ships no postinstall, the browsers come down
// only when somebody runs `npx playwright install`, and a clean `npm ci` here
// takes ten seconds. The comment outlived the fact and said the opposite of it,
// which is worse than saying nothing.
//
// Still skipped rather than failed when it is absent, the same way the database
// tests skip without a DATABASE_URL: a checkout that has not installed it, or a
// runner with no browser, should report that it did not look rather than fail.
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
  "/dashboard", "/transactions", "/budget", "/accounts", "/reports",
  "/recurring", "/goals", "/investments", "/payoff", "/forecast", "/estate", "/tax", "/year", "/rules", "/categories", "/tags", "/settings",
  // Added with the cards screen and missed at the time, so every per-page
  // check below had a hole in it until now.
  "/cards",
  // The category drill-down carries a chart, a transaction list and two cards
  // side by side, which is the layout most likely to run off a phone.
  "/categories/c_groceries", "/categories/c_groceries?by=year",
  "/merchants/Amazon", "/merchants/Amazon?by=year",
  // A goal's own page: a wide header, four tiles, a chart and two columns.
  "/goals/gl_efund", "/goals/gl_kitchen",
  // The rest of the routes, so the sweep really is every page.
  "/merchants", "/hopper", "/accounts/a_checking", "/accounts/a_mortgage",
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
  { w: 1440, cols: ["cb", "avatar", "merchant", "category", "account", "amount"] },
  { w: 1000, cols: ["cb", "avatar", "merchant", "category", "account", "amount"] },
  { w: 880, cols: ["cb", "avatar", "merchant", "category", "amount"] },
  { w: 700, cols: ["cb", "avatar", "merchant", "amount"] },
  { w: 390, cols: ["cb", "avatar", "merchant", "amount"] },
  { w: 320, cols: ["cb", "avatar", "merchant", "amount"] },
];

/** The last dollar figure in a sentence, which is the interest in this one. */
const lastMoney = (t) => {
  const all = [...(t ?? "").matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  return all.length ? all[all.length - 1] : 0;
};

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

      // And the words over them, in the same order. Counting the cells says
      // the header has the right number of columns; only reading them says it
      // is naming the right one, which is what a swap gets wrong.
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll(".tx-grid.head > *")]
          .filter((el) => getComputedStyle(el).display !== "none")
          .map((el) => el.textContent.trim())
          .filter(Boolean));
      const want = cols.filter((c) => c !== "cb" && c !== "avatar")
        .map((c) => c.charAt(0).toUpperCase() + c.slice(1));
      check(`${w}px — and names them in that order`, labels.join(" / ") === want.join(" / "),
        `${labels.join(" / ")}, wanted ${want.join(" / ")}`);

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

    // What a row says about itself — that it repeats, that it is Pending, that
    // it still wants a look — sits against the merchant's name and against
    // each other. The failure this replaces: the merchant's hover arrow holds
    // its 28px while invisible, and holding it between the name and the badges
    // left them adrift in the middle of the column. Every gap along the line is
    // measured, not just the first, so one of them going astray shows wherever
    // in the run it happens.
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
        const marks = [...line.querySelectorAll(".tx-repeat, .tag, .dot")];
        if (!name || !marks.length) continue;
        let edge = textRight(name);
        for (const m of marks) {
          const box = m.getBoundingClientRect();
          out.push({ gap: Math.round(box.left - edge), at: Math.round(box.left) });
          edge = box.right;
        }
      }
      return out;
    });
    check("1440px — a row's badges sit against its merchant name and each other",
      badges.length > 3 && badges.every((b) => b.gap <= 10),
      `${badges.length} gaps, widest ${Math.max(...badges.map((b) => b.gap), 0)}px`);

    // And the arrow, which appears on hover, must not push them along when it
    // does — the space it reserves is why it sits after them.
    // The same row read twice, rather than the first of the gaps measured
    // above: what matters is that nothing on this line moves when the arrow
    // arrives, and only the same element before and after can say that.
    const marksOn = (nth) => wide.evaluate((i) => {
      const line = document.querySelectorAll(".list-row.tx-grid:not(.head) .col > .row")[i];
      return {
        at: [...line.querySelectorAll(".tx-repeat, .tag, .dot")]
          .map((m) => Math.round(m.getBoundingClientRect().left)),
        arrow: getComputedStyle(line.querySelector(".tx-merchant-open")).opacity,
      };
    }, nth);

    const before = await marksOn(0);
    const steady = await tryStep("1440px — hovering a row reveals its arrow", async () => {
      await wide.locator(".list-row.tx-grid:not(.head)").first().hover({ timeout: 5000 });
      await wide.waitForTimeout(300);
    });
    if (steady) {
      const after = await marksOn(0);
      check("1440px — without shifting the badges it sits after",
        after.arrow === "1" && before.at.length > 0
        && after.at.every((x, i) => Math.abs(x - before.at[i]) <= 1),
        `arrow opacity ${after.arrow}, ${before.at.join("/")} then ${after.at.join("/")}`);
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

  if (want("touch-zoom")) {
    // ── nothing a finger can focus is small enough to zoom the page ──
    //
    // Safari on iPhone zooms the whole page in when a form control smaller
    // than 16px takes focus, and leaves you there, scrolled sideways. There is
    // no event to cancel and no setting to turn it off: the control being 16px
    // is the only thing that stops it. It was reported on a transaction's
    // category picker, whose search box was 13px like every other input.
    //
    // Emulated with touch on, which is what makes `pointer: coarse` match, so
    // this measures the rule that actually ships rather than a width.
    const SMALL = `(() => {
      const out = [];
      for (const el of document.querySelectorAll("input, select, textarea")) {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        // The ones iOS does not zoom for: they take no text.
        if (["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(t)) continue;
        if (el.offsetParent === null && !el.getClientRects().length) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 16) out.push(location.pathname + " " + (el.className || el.tagName.toLowerCase()) + " at " + size + "px");
      }
      return out;
    })()`;

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const offenders = [];
    for (const path of PAGES) {
      await phone.goto(`${BASE}${path}`, { waitUntil: "networkidle" }).catch(() => {});
      await phone.waitForTimeout(250);
      offenders.push(...await phone.evaluate(SMALL));
    }
    check("every page — nothing a finger can focus is under 16px",
      offenders.length === 0, offenders.slice(0, 6).join(", "));

    // The reported case, walked the way it was hit: open a transaction, open
    // its category. A rule that covers the pages but not the thing a menu
    // opens would pass everything above and still zoom.
    await phone.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await phone.waitForTimeout(500);
    await tryStep("a transaction opens on a phone", () =>
      // The amount, not the name. The name's cell carries a small arrow to the
      // merchant's own page, and a click lands in the centre of whatever it is
      // given: the demo data is generated from today's date, so the first row
      // is a different merchant every day and on the days the name is short
      // enough the centre falls on that arrow. The test then navigated instead
      // of opening anything, which reads as the row being broken.
      phone.locator(".list-row.tx-grid:not(.head) .tx-amount").first().click({ timeout: 5000 }));
    await phone.waitForTimeout(600);
    const catRow = phone.locator(".drow", { hasText: "Category" }).first();
    await tryStep("and its category can be opened", () =>
      catRow.locator("button, select, .drow-btn").first().click({ timeout: 5000 }));
    await phone.waitForTimeout(500);
    // And the keyboard stays down. The search box above the list took focus
    // when it opened, which on a phone means the keyboard covers the list you
    // opened the menu to read. Under a mouse it should still take focus.
    const focusedOnPhone = await phone.evaluate(() =>
      document.activeElement ? document.activeElement.tagName.toLowerCase() : "none");
    check("opening the category picker does not put the keyboard up",
      focusedOnPhone !== "input", `focus landed on ${focusedOnPhone}`);

    // The action bar has to fit. It held Delete, Duplicate, Cancel and Save,
    // which ran off the side of a phone; Cancel went, because the close in the
    // corner and Escape both already do it.
    const foot = await phone.evaluate(() => {
      const f = document.querySelector(".scrim .modal .modal-foot");
      if (!f) return null;
      const box = f.getBoundingClientRect();
      const buttons = [...f.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.innerText.trim(), left: Math.round(r.left), right: Math.round(r.right) };
      });
      return {
        overflows: f.scrollWidth - f.clientWidth > 1,
        outside: buttons.filter((b) => b.left < box.left - 1 || b.right > box.right + 1),
        labels: buttons.map((b) => b.text),
      };
    });
    check("and the action bar fits on the screen",
      !!foot && !foot.overflows && foot.outside.length === 0,
      foot ? `${foot.labels.join(" | ")} overflow=${foot.overflows} outside=${JSON.stringify(foot.outside)}` : "no footer");
    check("with no Cancel, since the corner close already does that",
      !!foot && !foot.labels.some((l) => /cancel/i.test(l)), foot ? foot.labels.join(" | ") : "no footer");

    const picker = await phone.evaluate(SMALL);
    const searched = await phone.evaluate(() => {
      const el = [...document.querySelectorAll("input")]
        .find((i) => /categor/i.test(i.getAttribute("placeholder") || ""));
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    check("the category picker is reached, and its search box is 16px",
      searched !== null && searched >= 16, `saw ${searched}`);
    check("and nothing else inside the open transaction is under 16px",
      picker.length === 0, picker.join(", "));

    // The amount is 38px and must stay it: a blanket 16px would have shrunk
    // the one control on the screen that was already large enough.
    const amount = await phone.evaluate(() => {
      const el = document.querySelector(".txn-amount input");
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    check("and the amount is left the size it was designed",
      amount !== null && amount > 30, `saw ${amount}`);
    await phone.close();

    // Capability, not width. The same narrow window under a mouse keeps the
    // designed size, or this would be a redesign of every form in the app
    // rather than a fix for one browser's behaviour.
    const mouse = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mouse.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await mouse.waitForTimeout(400);
    const size = await mouse.evaluate(() => {
      const el = document.querySelector(".search .input");
      return el ? parseFloat(getComputedStyle(el).fontSize) : null;
    });
    check("a narrow window with a mouse is not treated as a phone",
      size !== null && size < 16, `saw ${size}`);

    // The other half of that: with a mouse the search box should still take
    // focus, or a fix for phones has quietly cost everyone else the ability to
    // open a menu and start typing.
    // The amount cell, for the same reason as above: no links inside it.
    await mouse.locator(".list-row.tx-grid:not(.head) .tx-amount").first().click();
    await mouse.waitForTimeout(600);
    await mouse.locator(".drow", { hasText: "Category" }).first()
      .locator("button, select, .drow-btn").first().click();
    await mouse.waitForTimeout(400);
    const focusedOnMouse = await mouse.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}:${el.getAttribute("placeholder") ?? ""}` : "none";
    });
    check("but with a mouse the category search still takes focus",
      /^input:.*categor/i.test(focusedOnMouse), `focus landed on ${focusedOnMouse}`);
    await mouse.close();

    // The other two zooms, which have no focus to hang a measurement on.
    const rest = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await rest.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await rest.waitForTimeout(400);
    const taps = await rest.evaluate(() => {
      const els = [...document.querySelectorAll("button, a")].filter((e) => e.getClientRects().length);
      const wrong = els.filter((e) => !/manipulation|none/.test(getComputedStyle(e).touchAction));
      return { seen: els.length, wrong: wrong.length, first: wrong[0]?.className ?? "" };
    });
    check("two quick taps on a button do not zoom either",
      taps.seen > 10 && taps.wrong === 0, `${taps.wrong} of ${taps.seen} still zoom, e.g. ${taps.first}`);
    const adjust = await rest.evaluate(() =>
      getComputedStyle(document.documentElement).webkitTextSizeAdjust
      ?? getComputedStyle(document.documentElement).textSizeAdjust);
    check("and turning the phone does not grow the text by itself",
      adjust === "100%", `saw ${adjust}`);
    await rest.close();
  }

  if (want("budget-actual")) {
    // ── a phone sees one of the two figures, and can ask for the other ──
    //
    // Planned, Actual and Remaining is three columns of numbers against a
    // category name, and on a phone the name loses. Dropping Actual outright
    // was worse: a category with no activity read as its whole plan still
    // remaining, with nothing on the page to tell that apart from a plan
    // nobody had spent against, and on income it is the number you came to
    // look at. So one is shown and its heading swaps them.
    for (const w of [360, 390, 430]) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 }, hasTouch: true, isMobile: true });
      await page.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);

      const read = () => page.evaluate(() => {
        const rows = [...document.querySelectorAll(".list-row")].filter((r) => r.querySelector(".bcol-plan"));
        const shown = (el) => Boolean(el) && getComputedStyle(el).display !== "none";
        const head = document.querySelector(".bgroup-head");
        const name = rows[0]?.querySelector(".cat-open");
        const live = [...(head?.querySelectorAll(".bcol-toggle") ?? [])]
          .filter((b) => b.offsetParent !== null);
        const style = live[0] ? getComputedStyle(live[0]) : null;
        return {
          rows: rows.length,
          actual: shown(rows[0]?.querySelector(".bcol-actual")),
          remaining: shown(rows[0]?.querySelector(".bcol-left")),
          headings: live.map((b) => b.textContent.trim()),
          dotted: style ? style.textDecorationStyle === "dotted" && /underline/.test(style.textDecorationLine) : false,
          pressable: style ? style.pointerEvents !== "none" && style.cursor === "pointer" : false,
          // The name is what the second column is paid for, so it is measured
          // rather than assumed: two letters and a gap is not a name.
          clipped: name ? name.scrollWidth - Math.ceil(name.getBoundingClientRect().width) > 1 : true,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });

      const first = await read();
      check(`${w}px — the budget shows one of Actual and Remaining, not both`,
        first.rows > 0 && first.actual !== first.remaining, JSON.stringify(first));
      check(`${w}px — and it is Remaining, which is the one that is acted on`,
        first.remaining && first.headings.length === 1 && first.headings[0] === "Remaining", JSON.stringify(first));
      check(`${w}px — its heading is dotted and pressable, so it reads as the switch it is`,
        first.dotted && first.pressable, JSON.stringify(first));
      check(`${w}px — and the category name is readable beside it`,
        !first.clipped && first.overflow === 0, JSON.stringify(first));

      // Pressing it swaps them, and does not collapse the group it sits in:
      // the heading lives inside the card head, whose own job is collapsing.
      await page.locator(".bgroup-head .bcol-toggle:visible").first().click({ timeout: 5000 });
      await page.waitForTimeout(250);
      const after = await read();
      check(`${w}px — pressing the heading shows the other figure`,
        after.actual && !after.remaining && after.headings[0] === "Actual", JSON.stringify(after));
      check(`${w}px — and the group it sits in stays open`,
        after.rows === first.rows, `${first.rows} rows before, ${after.rows} after`);
      check(`${w}px — the name survives the swap too`,
        !after.clipped && after.overflow === 0, JSON.stringify(after));

      // And back, so neither figure is a one-way door.
      await page.locator(".bgroup-head .bcol-toggle:visible").first().click({ timeout: 5000 });
      await page.waitForTimeout(250);
      const back = await read();
      check(`${w}px — and pressing it again goes back`,
        back.remaining && !back.actual, JSON.stringify(back));
      await page.close();
    }

    // Narrower than any current phone, where the name is what is at risk.
    // Measured: "Paychecks" fits at 360 and was down to two letters at 344
    // when a third column was still being asked for.
    const tiny = await browser.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });
    await tiny.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
    await tiny.waitForTimeout(400);
    const small = await tiny.evaluate(() => {
      const rows = [...document.querySelectorAll(".list-row")].filter((r) => r.querySelector(".bcol-plan"));
      const name = rows[0]?.querySelector(".cat-open");
      const shown = (el) => Boolean(el) && getComputedStyle(el).display !== "none";
      return {
        one: shown(rows[0]?.querySelector(".bcol-actual")) !== shown(rows[0]?.querySelector(".bcol-left")),
        clipped: name ? name.scrollWidth - Math.ceil(name.getBoundingClientRect().width) > 1 : true,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check("320px — still one figure and a readable name, rather than both losing",
      small.one && !small.clipped && small.overflow === 0, JSON.stringify(small));
    await tiny.close();

    // On a screen with room for both, there is nothing to switch to, so the
    // heading is a label again. An affordance without a behaviour is a lie.
    const wide = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await wide.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
    await wide.waitForTimeout(400);
    const both = await wide.evaluate(() => {
      const rows = [...document.querySelectorAll(".list-row")].filter((r) => r.querySelector(".bcol-plan"));
      const shown = (el) => Boolean(el) && getComputedStyle(el).display !== "none";
      const b = document.querySelector(".bgroup-head .bcol-toggle");
      const style = b ? getComputedStyle(b) : null;
      return {
        actual: shown(rows[0]?.querySelector(".bcol-actual")),
        remaining: shown(rows[0]?.querySelector(".bcol-left")),
        inert: style ? style.pointerEvents === "none" : false,
        plain: style ? style.textDecorationStyle !== "dotted" : false,
      };
    });
    check("1200px — both figures are there, so the heading is a label and not a switch",
      both.actual && both.remaining && both.inert && both.plain, JSON.stringify(both));
    await wide.close();
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
    // straight to Settings. Goals, Merchants, Reports, Recurring, Investments,
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

    // Opened by looking for one that carries a statement rather than by index.
    // Which row is second depends on today's date, so nth(1) was a test that
    // passed until a Tuesday.
    // Which row is second depends on today's date, so nth(1) was a test that
    // passed until a Tuesday. The one it settles on is remembered, because a
    // later step reopens it to check an edit survived.
    let detailRow = 0;
    const openedTxn = await tryStep("a transaction opens its detail screen", async () => {
      for (let i = 0; i < 10; i++) {
        await det.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(i).click({ timeout: 5000 });
        await det.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
        const labels = await det.evaluate(() =>
          [...document.querySelectorAll(".modal .drow-label")].map((e) => e.innerText.trim()));
        if (labels.includes("Original statement")) { detailRow = i; return; }
        await det.keyboard.press("Escape");
        await det.waitForTimeout(250);
      }
      throw new Error("none of the first ten transactions carried a statement");
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
          await det.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(detailRow).click({ timeout: 5000 });
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
    check("named for the stretch they cover, not for the year they fell in",
      top.map((t) => t.label.toUpperCase()).join(" / ") === "THIS MONTH / THIS YEAR",
      top.map((t) => t.label).join(" / "));
    check("and neither of them is the two that were dropped",
      !top.some((t) => /next 7 days|recurring income/i.test(t.label)), top.map((t) => t.label).join(", "));
    check("each says what has gone of what is committed",
      top.every((t) => t.total !== null && t.total > 0 && t.spent <= t.total),
      top.map((t) => t.value).join(" | "));
    check("with the rest of it named rather than left to be worked out",
      top.every((t) => /to go/.test(t.foot)), top.map((t) => t.foot).join(" | "));
    check("and both count what is still due rather than what exists",
      top.every((t) => /\d+ more due this (month|year)|nothing else due this (month|year)/.test(t.foot)),
      top.map((t) => t.foot).join(" | "));
    // The bar is the same claim as the figures, so it has to agree with them.
    check("and a bar drawn to the same share the figures give",
      top.every((t) => {
        const share = t.spent / t.total;
        return Math.abs(t.bar / t.barTrack - share) <= 0.02;
      }),
      top.map((t) => `${Math.round((t.bar / t.barTrack) * 100)}% drawn vs ${Math.round((t.spent / t.total) * 100)}%`).join(" | "));
    // Green, like every other bar in the app that fills up rather than runs
    // out. Read off the page rather than named here, so a change to the token
    // moves both together.
    const fills = await tiles.evaluate(() => {
      const pos = getComputedStyle(document.documentElement).getPropertyValue("--pos").trim();
      const swatch = document.createElement("span");
      swatch.style.color = pos;
      document.body.append(swatch);
      const want = getComputedStyle(swatch).color;
      swatch.remove();
      return {
        want,
        bars: [...document.querySelectorAll(".spend-bar > i")]
          .map((i) => getComputedStyle(i).backgroundColor),
      };
    });
    check("both bars are drawn in the green the rest of the app fills with",
      fills.bars.length === 2 && fills.bars.every((c) => c === fills.want),
      `${fills.bars.join(" | ")} against ${fills.want}`);
    // The year is twelve of the month plus whatever is not monthly. It used to
    // assert exactly twelve on the grounds that the demo was all monthly; the
    // demo has since grown a quarterly bill, and the assertion was wrong
    // rather than the arithmetic. The property actually worth guarding is that
    // the year does not drift *upwards*: a walk that steps thirty days instead
    // of a month gives thirteen payments a year and a total eight percent high.
    // The exact cadence counts are checked in scripts/selftest.mjs.
    const [month, year] = top;
    const ratio = month.total > 0 ? year.total / month.total : 0;
    // The lower end allows a cent: both totals are rounded to whole cents, so
    // twelve times a monthly figure and the yearly one drawn beside it can
    // land a penny apart without anything being wrong. It is thirteen
    // payments a year this is watching for, not a rounding step.
    check("the year is twelve months of bills, not thirteen",
      ratio > 11.99 && ratio < 12.5,
      `${year.total} is ${ratio.toFixed(2)} of ${month.total}`);
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

    // ── what the calendar says, and where it goes ──
    const cal = await wide.evaluate(() => {
      const token = (name) => {
        const el = document.createElement("span");
        el.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        document.body.append(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      };
      const marks = [...document.querySelectorAll(".cal-name")].map((n) => ({
        paid: !!n.querySelector(".cal-tick"),
        tone: n.querySelector(".dot") ? getComputedStyle(n.querySelector(".dot")).backgroundColor : null,
        text: (n.querySelector(".cal-name-text")?.textContent ?? "").trim(),
        href: n.getAttribute("href"),
        tag: n.tagName,
        // Two lines' worth of height on a name too long for one, which is what
        // wrapping looks like from the outside.
        lines: Math.round(n.querySelector(".cal-name-text").getBoundingClientRect().height
          / parseFloat(getComputedStyle(n.querySelector(".cal-name-text")).lineHeight)),
        clipped: n.querySelector(".cal-name-text").scrollWidth
          - Math.ceil(n.querySelector(".cal-name-text").getBoundingClientRect().width) > 1,
      }));
      const legend = [...document.querySelectorAll(".card .row.tiny.muted")].map((r) => ({
        label: r.innerText.trim(),
        tone: r.querySelector(".dot") ? getComputedStyle(r.querySelector(".dot")).backgroundColor : null,
      }));
      // The colour the app paints money going the wrong way, taken from the
      // rule itself rather than from a token name, so the two cannot drift
      // apart while both still look defensible in isolation.
      const asClass = (cls) => {
        const el = document.createElement("span");
        el.className = cls;
        document.body.append(el);
        const c = getComputedStyle(el).color;
        el.remove();
        return c;
      };
      return { marks, legend, negText: asClass("neg"), posText: asClass("pos"), pos: token("--pos") };
    });
    // ── the bills mark is red, and red is not a matter of opinion here ──
    //
    // Three passes were spent on this and the earlier checks each let the
    // failure through in a different way, so the rule is stated as the two
    // things a reader actually complains about. Orange: green running ahead of
    // blue. Coral: green and blue level but both too high, which is what the
    // app's negative-amount colour is (242,104,94) and why the mark does not
    // simply borrow it. Measured on the pixels the browser painted, not on the
    // value the stylesheet asked for, because a dot this small is mostly
    // antialiased edge and the edge is half the cell behind it.
    const rgb = (c) => c.match(/\d+/g).map(Number);
    const reads = (c) => {
      const [r, g, b] = rgb(c);
      if (g - b > 25) return "orange";
      if (g > 90 || b > 90) return "coral";
      if (r < 150) return "too dark to read as red";
      return "red";
    };
    const bills = cal.marks.filter((m) => !m.paid && m.tone !== cal.pos);
    // Only the bills still to come carry a mark, so how many there are depends
    // on what day it is. Demanding four of them made this fail on the 20th of
    // the month and would have failed every month end from now on, which is a
    // calendar telling the truth being reported as a bug. The claim worth
    // making is that the marks shown agree with each other, and a set of size
    // one says exactly that - it is also false when there are none at all.
    check("every bill in the calendar is marked in one colour",
      new Set(bills.map((m) => m.tone)).size === 1,
      `${bills.length} bills in ${[...new Set(bills.map((m) => m.tone))].join(" | ") || "no colour at all"}`);
    check("and that colour reads as red, not orange and not coral",
      bills.length > 0 && reads(bills[0].tone) === "red",
      `${bills[0]?.tone} reads ${bills[0] ? reads(bills[0].tone) : "nothing"}`);
    check("which the app's negative-amount colour would not have",
      reads(cal.negText) !== "red", `${cal.negText} reads ${reads(cal.negText)}`);
    check("and income keeps the green the app pays out in",
      cal.pos === cal.posText, `${cal.pos} against ${cal.posText}`);
    // The pair is redefined for the light theme, and a mark tuned only against
    // the dark one goes unnoticed until somebody switches.
    const inLight = await wide.evaluate(() => {
      const root = document.documentElement;
      const was = root.getAttribute("data-theme");
      root.setAttribute("data-theme", "light");
      const dots = [...document.querySelectorAll(".cal-name .dot")]
        .map((d) => getComputedStyle(d).backgroundColor);
      if (was) root.setAttribute("data-theme", was); else root.removeAttribute("data-theme");
      return [...new Set(dots)];
    });
    const lightBill = inLight.find((c) => c !== cal.pos && c !== cal.posText);
    check("in the light theme too", lightBill !== undefined && reads(lightBill) === "red",
      `${lightBill} reads ${lightBill ? reads(lightBill) : "nothing"}`);
    // A dot small enough to be mostly edge arrives washed out whatever colour
    // it was given, which is half of why three passes were needed.
    const dotSize = await wide.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector(".cal-name .dot")).width));
    check("and the mark is big enough to carry a colour",
      dotSize >= 7, `${dotSize}px across`);
    check("the key under it names the three things a day can be",
      cal.legend.length === 3
      && cal.legend.find((l) => /bill/i.test(l.label))?.tone === bills[0]?.tone
      && cal.legend.find((l) => /income/i.test(l.label))?.tone === cal.pos
      && cal.legend.some((l) => /paid/i.test(l.label)),
      cal.legend.map((l) => `${l.label} ${l.tone}`).join(" | "));
    // Wrapped, not cut: a name too wide for its cell takes a second line and
    // still reads in full.
    const longest = cal.marks.slice().sort((a, b) => b.text.length - a.text.length)[0];
    check("a name too wide for its cell wraps rather than being clipped",
      longest !== undefined && longest.lines > 1 && cal.marks.every((m) => !m.clipped),
      longest ? `"${longest.text}" on ${longest.lines} line(s), ${cal.marks.filter((m) => m.clipped).length} clipped` : "no names");
    check("and every name in the calendar leads to that merchant's page",
      cal.marks.length > 3 && cal.marks.every((m) => m.tag === "A"
        && m.href === `/merchants/${encodeURIComponent(m.text)}`),
      cal.marks.slice(0, 3).map((m) => `${m.tag} ${m.href}`).join(", "));

    // ── a tick is evidence, not a calendar reading ──
    //
    // The claim it makes is that money actually left the account, so it has to
    // be checked against the transactions rather than against today's date.
    const ticks = await wide.evaluate(() => {
      const rows = [...document.querySelectorAll(".rec-row")];
      const seen = new Map();
      for (const r of rows) seen.set(r.querySelector(".truncate")?.innerText.trim(), true);
      return {
        marks: [...document.querySelectorAll(".cal-name")].map((n) => ({
          day: Number(n.closest(".cal-cell").querySelector(".cal-day")?.innerText.trim() ?? "0"),
          name: (n.querySelector(".cal-name-text")?.textContent ?? "").trim(),
          paid: !!n.querySelector(".cal-tick"),
        })),
        today: Number(new Date().toISOString().slice(8, 10)),
      };
    });
    check("some of the month is ticked and some of it is not",
      ticks.marks.some((m) => m.paid) && ticks.marks.some((m) => !m.paid),
      `${ticks.marks.filter((m) => m.paid).length} of ${ticks.marks.length} ticked`);
    // Nothing beyond the window round today can have been paid, because there
    // is no transaction out there to pay it.
    const early = ticks.marks.filter((m) => m.paid && m.day > ticks.today + 5);
    check("and nothing well ahead of today is ticked",
      early.length === 0,
      early.map((m) => `${m.name} on the ${m.day}`).join(", "));
    // The tick has to be answering the ledger, so each one is checked against
    // that merchant's own transactions: a charge within the window of the day
    // it is sitting on. An unticked day is checked the same way, for the
    // absence — a rule that ticks everything would pass the first half alone.
    const WINDOW = 5;
    const chargesNear = async (name, day) => {
      await wide.goto(`${BASE}/merchants/${encodeURIComponent(name)}`, { waitUntil: "networkidle" });
      await wide.waitForTimeout(800);
      const dates = await wide.evaluate(() =>
        [...document.querySelectorAll(".date-head")].map((h) => h.innerText.split("\n")[0].trim()));
      const now = new Date();
      const want = new Date(now.getFullYear(), now.getMonth(), day).getTime();
      return dates.filter((d) => Math.abs(new Date(d).getTime() - want) / 86400000 <= WINDOW);
    };
    const someTicked = ticks.marks.filter((m) => m.paid).slice(0, 3);
    const missing = [];
    for (const m of someTicked) {
      if (!(await chargesNear(m.name, m.day)).length) missing.push(`${m.name} on the ${m.day}`);
    }
    check("every tick has a real charge behind it, on that merchant's own page",
      someTicked.length > 0 && missing.length === 0,
      missing.length ? `nothing near ${missing.join(", ")}` : `checked ${someTicked.length}`);

    const unticked = ticks.marks.filter((m) => !m.paid).slice(0, 3);
    const wrong = [];
    for (const m of unticked) {
      const near = await chargesNear(m.name, m.day);
      if (near.length) wrong.push(`${m.name} on the ${m.day} has ${near[0]}`);
    }
    check("and a day left unticked has no charge behind it either",
      unticked.length > 0 && wrong.length === 0,
      wrong.join(", ") || `checked ${unticked.length}`);

    await wide.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await wide.waitForTimeout(800);

    const inCal = await tryStep("a name in the calendar can be clicked", async () => {
      await wide.locator(".cal-name").first().click({ timeout: 5000 });
      await wide.waitForTimeout(700);
    });
    if (inCal) {
      check("and lands on the same page the row below it does",
        /^\/merchants\//.test(new URL(wide.url()).pathname),
        new URL(wide.url()).pathname);
      // Back by address rather than by history: a click that went nowhere
      // leaves history one step behind the page, and going back from there
      // lands somewhere else entirely, which fails every check after this one
      // for a reason that has nothing to do with them.
      await wide.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
      await wide.waitForTimeout(700);
    }

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

    const line = await wide.evaluate(() => [...document.querySelectorAll(".rec-row")].slice(0, 6).map((r) => ({
      sub: r.querySelector(".tiny.faint")?.textContent.trim() ?? "",
      buttons: [...r.querySelectorAll("button")].map((b) => b.getAttribute("title") ?? ""),
    })));
    check("a row's schedule line ends at the next date, with no bracket after it",
      line.length > 3 && line.every((r) => /·\s*next\s+\S/.test(r.sub) && !/[()]/.test(r.sub)),
      line.map((r) => r.sub).join(" | "));
    // The month keeps its capital when the phrase loses one: "next sep 17" is
    // what lowercasing the whole label gives, and it is not a date.
    check("and a month in it is still a month",
      line.every((r) => !/next [a-z]{3} \d/.test(r.sub)),
      line.map((r) => r.sub).join(" | "));
    const cased = await wide.evaluate(() => {
      const el = document.querySelector(".rec-row .rec-when");
      if (!el) return null;
      return {
        transform: getComputedStyle(el).textTransform,
        // innerText is what the transform produced; textContent is what the
        // markup says. A title-cased line differs from its source and is not
        // simply shouted.
        shown: el.innerText,
        source: el.textContent,
      };
    });
    check("the schedule line is title case, not a sentence and not a shout",
      cased !== null && cased.transform === "capitalize"
      && cased.shown !== cased.shown.toUpperCase()
      && cased.shown.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).every((w) => w[0] === w[0].toUpperCase()),
      cased === null ? "no line" : `${cased.transform}: ${cased.shown}`);
    check("editing the schedule is the only button on a row",
      line.every((r) => r.buttons.length === 1 && r.buttons[0] === "Edit schedule"),
      line.map((r) => r.buttons.join("+") || "none").join(" | "));

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
      // The row lost its dismiss button, so the switch in here is the only way
      // left to say something is not recurring. It has to still work.
      const named = await wide.evaluate(() =>
        document.querySelector(".modal .field input")?.value ?? "");
      const before = await wide.evaluate(() => document.querySelectorAll(".rec-row").length);
      check("and the switch in it starts on, for something that is recurring",
        await wide.evaluate(() => !!document.querySelector(".rec-switch .switch.on")));
      if (await tryStep("which can be turned off to say it is not recurring", async () => {
        await wide.locator(".rec-switch .switch").click({ timeout: 5000 });
        await wide.locator('.modal-foot button:has-text("Save")').click({ timeout: 5000 });
        await wide.locator(".modal").waitFor({ state: "detached", timeout: 5000 });
        await wide.waitForTimeout(700);
      })) {
        const after = await wide.evaluate(() => [...document.querySelectorAll(".rec-row")].map((r) => r.innerText));
        check("and that takes it off the page",
          after.length === before - 1 && !after.some((t) => named && t.includes(named)),
          `${before} -> ${after.length}, looking for ${named}`);
      }
    }
    await wide.close();

    // ── a tick is not "the date went by" ──
    //
    // In this data every bill whose date has passed also has a charge behind
    // it, so the two rules agree and the checks above cannot tell them apart.
    // This makes them disagree: a bill entered by hand, dated the first of the
    // month, for a merchant that has never been paid a penny. A calendar
    // reading ticks it; only the bank can say it is unpaid.
    //
    // Its own page, so its own storage: browser.newPage gives a fresh context,
    // and this leaves an item behind that would sort to the top of every list
    // the checks above read.
    const ghost = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await ghost.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await ghost.waitForTimeout(900);
    const name = "Zzz Never Paid Anything";
    const first = `${new Date().toISOString().slice(0, 8)}01`;
    const added = await tryStep("a bill can be entered by hand", async () => {
      await ghost.locator('.topbar button:has-text("Recurring")').click({ timeout: 5000 });
      await ghost.locator(".modal").waitFor({ timeout: 5000 });
      await ghost.locator(".modal .field:has(label:text-is('Merchant')) input").fill(name);
      await ghost.locator(".modal .field:has(label:text-is('Amount')) input").fill("42.00");
      await ghost.locator(".modal .field:has(label:text-is('Next date')) input").fill(first);
      await ghost.locator('.modal-foot button:has-text("Save")').click({ timeout: 5000 });
      await ghost.locator(".modal").waitFor({ state: "detached", timeout: 5000 });
      await ghost.waitForTimeout(700);
    });
    if (added) {
      const mine = await ghost.evaluate((who) => {
        const el = [...document.querySelectorAll(".cal-name")]
          .find((n) => (n.querySelector(".cal-name-text")?.textContent ?? "").trim() === who);
        if (!el) return null;
        return {
          day: Number(el.closest(".cal-cell").querySelector(".cal-day")?.innerText.trim() ?? "0"),
          paid: !!el.querySelector(".cal-tick"),
        };
      }, name);
      check("a bill dated earlier this month shows up on the day it was dated",
        mine !== null && mine.day === 1, mine === null ? "not on the calendar" : `on the ${mine.day}`);
      check("and is not ticked, because nothing was ever paid to it",
        mine !== null && mine.paid === false,
        mine?.paid ? "ticked with no charge behind it" : "not ticked");
    }
    await ghost.close();
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
        // The badge caps at "9+", so reading it as a number says NaN on any
        // day the demo happens to raise more than ten notices. What it shows
        // is what to assert against, not what it would show if it never
        // counted past nine.
        const badge = before - 1 > 9 ? "9+" : String(before - 1);
        check("the one that was read stops counting", after.badge === badge,
          `badge ${after.badge}, expected ${badge} after ${before}`);
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
        // Names no bank, so it is about the whole connection and belongs on
        // every account fed by it. The message that names one is seeded
        // separately below, because those are two different rules.
        usage: { ...(baseDoc.settings.usage ?? {}), plaid: { period: "", count: 3, error: "Plaid could not be reached." } },
      },
      accounts: baseDoc.accounts.map((a, i) =>
        i === 0 ? { ...a, syncSource: "plaid", lastSyncedAt: iso(2) }
        : i === 1 ? { ...a, syncSource: "simplefin", lastSyncedAt: iso(2) }
        : i === 2 ? { ...a, syncSource: "simplefin", lastSyncedAt: iso(24 * 9) }
        : { ...a, syncSource: undefined, lastSyncedAt: undefined }),
    };

    const connPage = async (index, doc = connDoc) => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
      await ctx.addInitScript((d) => {
        if (!localStorage.getItem("sovereign.db.v1")) localStorage.setItem("sovereign.db.v1", d);
      }, JSON.stringify(doc));
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
      /could not be reached/i.test(attention?.detail ?? ""), attention?.detail || "nothing said");
    await broke.close();

    // ── one bank's trouble is not everybody's ──
    //
    // Only one error is kept per provider, and the Plaid path writes it as
    // "Valon Mortgage: ...". Every Plaid account in the document was showing
    // that mortgage's trouble as its own: a chequing account at another bank
    // under a red line about a connection it has nothing to do with.
    // Named outright rather than taken from the demo data, which has more
    // than one account at the same bank and would let this pass by accident.
    const elsewhere = {
      ...connDoc,
      accounts: connDoc.accounts.map((a, i) =>
        (i === 0 ? { ...a, institution: "Elements Financial" }
        : i === 2 ? { ...a, institution: "Valon Mortgage", syncSource: "plaid" }
        : a)),
      settings: {
        ...connDoc.settings,
        usage: {
          ...connDoc.settings.usage,
          plaid: { period: "", count: 3, error: "Valon Mortgage: login required" },
        },
      },
    };
    const other = await connPage(0, elsewhere);
    const spared = await readConn(other);
    check("a failure naming another bank is not reported against this account",
      !/needs attention/i.test(spared?.values.Status ?? "") && !/login required/i.test(spared?.detail ?? ""),
      `${spared?.values.Status} — ${spared?.detail || "nothing said"}`);
    await other.close();

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
        fields.join(" / ") === "Show / Account / Category / Amount / Date / Tag", fields.join(" / "));

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
    // ── every card's heading says the same kind of thing ──
    //
    // A dashboard is read by glancing down the left edge. Three of these used
    // to answer a different question from the rest: one restated an amount the
    // chart under it already drew, and two said which month it is, on a page
    // about this month.
    const heads = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
    await heads.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await heads.waitForTimeout(1800);
    // The heading's own column, not the whole head: a card with a control
    // beside its title would otherwise read that control's labels as its
    // sub-heading.
    const subs = await heads.evaluate(() => Object.fromEntries(
      [...document.querySelectorAll(".card-head, .dash-card-head")].map((h) => {
        const col = h.querySelector(".col");
        return [
          h.querySelector("h2")?.innerText.trim() ?? "",
          col
            ? [...col.children].slice(1).map((e) => e.innerText.trim()).join(" ")
            : (h.innerText.split("\n").slice(1).join(" ") ?? "").trim(),
        ];
      })));

    check("spending says which way it moved and by how much of last month",
      /^[\u2197\u2198] \$[\d,]+ \(\d+% (higher|lower)\)$/.test(subs.Spending ?? ""),
      JSON.stringify(subs.Spending));
    check("and does not restate the total the chart below it draws",
      !/vs\.|than by this day/i.test(subs.Spending ?? ""), JSON.stringify(subs.Spending));
    for (const card of ["Budget", "Investments"]) {
      check(`${card} carries no heading of its own`, (subs[card] ?? "") === "", JSON.stringify(subs[card]));
    }
    // The shape is the house one: the net worth card has said it this way all
    // along, and the point of the change was that they agree.
    // Delta carries no class of its own; it is the toned span in the head.
    const delta = await heads.evaluate(() =>
      document.querySelector(".nw-head .pos, .nw-head .neg")?.innerText.trim() ?? "");
    check("which is the shape the net worth card was already using",
      /^[\u2197\u2198] \$[\d,.]+ \([\d.]+%\)$/.test(delta), delta);
    await heads.close();

    // ── the net worth card cuts by kind, the way the Accounts page does ──
    //
    // Not merely "it has some pills": the same kind on either screen has to be
    // the same set of accounts, or two screens quietly disagree about what
    // Cash means.
    const read = async (page, path) => {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(900);
      const pills = await page.evaluate(() =>
        [...document.querySelectorAll(".nw-card .scope-pill")].map((e) => e.innerText.trim()));
      // The sub-heading between the kinds and the figure. The accounts page
      // never had one, so on the dashboard it is a difference between two
      // cards that are meant to be the same card.
      const label = await page.evaluate(() =>
        document.querySelector(".nw-card .nw-head .tile-label")?.innerText.trim() ?? "");
      const totals = {};
      for (let i = 0; i < pills.length; i++) {
        // Guarded: a pill that has become unclickable is a failure to report,
        // not an exception to bring the whole run down with. An aborted run
        // prints no failures at all, which reads exactly like a clean one.
        if (!await tryStep(`${path}: the ${pills[i]} pill can be clicked`, () =>
          page.locator(".nw-card .scope-pill").nth(i).click({ timeout: 5000 }))) return { pills, label, totals };
        await page.waitForTimeout(350);
        totals[pills[i]] = await page.evaluate(() =>
          document.querySelector(".nw-card .nw-value")?.innerText.trim() ?? null);
      }
      return { pills, label, totals };
    };

    const agree = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    const onDash = await read(agree, "/dashboard");
    const onAccounts = await read(agree, "/accounts");
    check("the dashboard's net worth card offers the same kinds the accounts page does",
      onDash.pills.length > 2 && onDash.pills.join(" | ") === onAccounts.pills.join(" | "),
      `dashboard: ${onDash.pills.join(" | ")}  //  accounts: ${onAccounts.pills.join(" | ")}`);
    const differs = onDash.pills.filter((k) => onDash.totals[k] !== onAccounts.totals[k]);
    check("and each of them is the same money on both",
      differs.length === 0 && Object.values(onDash.totals).every((v) => v),
      differs.map((k) => `${k}: ${onDash.totals[k]} against ${onAccounts.totals[k]}`).join(", ")
        || JSON.stringify(onDash.totals));
    check("and neither puts a sub-heading between the kinds and the figure",
      onDash.label === "" && onAccounts.label === "",
      `dashboard "${onDash.label}", accounts "${onAccounts.label}"`);
    await agree.close();

    // ── the dashboard ──
    const dash = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await dash.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await dash.waitForTimeout(900);

    const cards = await dash.evaluate(() =>
      [...document.querySelectorAll(".page > .card")].map((c) =>
        // The net worth card wears no heading at all, the same as the one on
        // the accounts page, so it answers for itself by what it draws.
        c.querySelector(".nw-head") ? "net worth" : (c.querySelector("h2")?.innerText ?? "").trim()));
    // Lower-cased on both sides: this is about which cards are there rather
    // than about how any of them is typeset.
    check("the dashboard is the six cards, in that order",
      cards.join(" / ").toLowerCase()
        === "net worth / spending / budget / recurring / goals / investments",
      cards.join(" / "));
    const body = await dash.evaluate(() => document.body.innerText);
    check("and recent transactions is not one of them", !/recent transactions/i.test(body));
    check("nor credit score, which was taken out for want of an API to feed it",
      !/credit score/i.test(body));

    // Net worth: the same scrubbable chart as everywhere else.
    const nw = await dash.evaluate(() => ({
      label: document.querySelector(".nw-head .tile-label")?.innerText.trim() ?? "",
      // Scoped to the card: the investments card carries the same six.
      spans: document.querySelectorAll(".nw-card .span-pill").length,
      axis: document.querySelectorAll(".nw-card .axis-text").length,
    }));
    check("net worth leads with the shared chart, periods and all",
      nw.label === "" && nw.spans === 6 && nw.axis === 0,
      `${nw.label ? `labelled "${nw.label}"` : "no label"}, ${nw.spans} periods, ${nw.axis} axis labels`);

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

    // The legend used to be laid inside the box the chart is drawn in, which
    // left it hanging over the bottom edge of the card.
    const key = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Spending/.test(c.querySelector("h2")?.innerText ?? ""));
      const k = card.querySelector(".cmp-key");
      if (!k) return null;
      return { bottom: k.getBoundingClientRect().bottom, card: card.getBoundingClientRect().bottom };
    });
    check("and the legend sits inside the card rather than over its bottom edge",
      key !== null && key.bottom <= key.card - 2, key === null ? "no legend" : `legend ends at ${Math.round(key.bottom)}, card at ${Math.round(key.card)}`);

    // Days along the bottom, not just the two ends: "Day 1" at one edge and
    // "Day 30" at the other says how long the month is, not where in it a
    // point on the line falls.
    const xAxis = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Spending/.test(c.querySelector("h2")?.innerText ?? ""));
      return [...card.querySelectorAll(".axis-text")].map((e) => e.textContent.trim()).filter((t) => /^Day \d+$/.test(t));
    });
    check("the spending axis names the days along the bottom",
      xAxis.length >= 3 && xAxis[0] === "Day 1" && /^Day (28|29|30|31)$/.test(xAxis[xAxis.length - 1]),
      xAxis.join(" / "));

    // Scrubbing: one readout, both runs, wherever the pointer is. Neither
    // line has to be landed on to be read.
    const svg = await dash.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => /^Spending/.test(c.querySelector("h2")?.innerText ?? ""));
      const el = card.querySelector(".chart-wrap svg");
      const b = el.getBoundingClientRect();
      // Half way along the line that is still being drawn, so the day under
      // the pointer is one both runs have reached.
      const paths = [...card.querySelectorAll("path[stroke]")];
      const xs = [...paths[paths.length - 1].getAttribute("d").matchAll(/[ML](-?[\d.]+),/g)].map((m) => parseFloat(m[1]));
      return { x: b.left + (Math.min(...xs) + Math.max(...xs)) / 2, y: b.top + b.height / 2 };
    });
    await dash.mouse.move(svg.x, svg.y);
    await dash.waitForTimeout(160);
    const tip = await dash.evaluate(() => {
      const t = document.querySelector(".chart-tip");
      if (!t) return null;
      return {
        head: t.firstElementChild?.textContent.trim() ?? "",
        values: [...t.querySelectorAll(".tip-cmp > .num")].map((e) => e.textContent.trim()),
        names: [...t.querySelectorAll(".tip-cmp > .row")].map((e) => e.textContent.trim()),
        keys: t.querySelectorAll(".tip-cmp .cmp-swatch").length,
        crosshairs: document.querySelectorAll(".spend-card line[stroke-width='1.5']").length,
      };
    });
    check("scrubbing the spending chart reads both months at the day under the pointer",
      tip !== null && /^Day \d+$/.test(tip.head) && tip.values.length === 2
      && tip.values.every((v) => /^\$[\d,]+/.test(v))
      && tip.names.join(" / ") === "This month / Last month",
      tip === null ? "no readout" : `${tip.head}: ${tip.values.join(" / ")} for ${tip.names.join(" / ")}`);
    check("with a hairline on the day and a stroke keying each row",
      tip !== null && tip.crosshairs === 1 && tip.keys === 2,
      tip === null ? "no readout" : `${tip.crosshairs} hairlines, ${tip.keys} keys`);
    await dash.mouse.move(5, 5);

    // Five comparisons, the way Monarch offers them, and the choice is
    // remembered: it is how this reader reads their own spending.
    const modes = await dash.evaluate(() =>
      [...document.querySelectorAll(".spend-card .cmp-mode option")].map((o) => o.textContent.trim()));
    check("the spending chart offers the five comparisons",
      modes.join(" | ") === [
        "This week vs. last week", "This month vs. last month", "This month vs. last year",
        "This month vs. average month", "This year vs. last year",
      ].join(" | "), modes.join(" | "));
    await dash.selectOption(".spend-card .cmp-mode", "week");
    await dash.waitForTimeout(250);
    const weekly = await dash.evaluate(() => {
      const card = document.querySelector(".spend-card");
      return {
        keys: [...card.querySelectorAll(".cmp-key span")].map((e) => e.textContent.trim()).join(" / "),
        axis: [...card.querySelectorAll(".axis-text")].map((e) => e.textContent.trim()).filter((t) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(t)),
      };
    });
    check("picking a week redraws the chart against last week",
      weekly.keys === "This week / Last week" && weekly.axis[0] === "Mon",
      `${weekly.keys}, axis ${weekly.axis.join(" ")}`);
    await dash.reload({ waitUntil: "networkidle" });
    await dash.waitForTimeout(900);
    const remembered = await dash.evaluate(() => document.querySelector(".spend-card .cmp-mode")?.value ?? "");
    check("and the choice survives a reload", remembered === "week", remembered);
    // Put it back, so what the rest of the suite sees on this card is the
    // comparison it opens on.
    await dash.selectOption(".spend-card .cmp-mode", "month");
    await dash.waitForTimeout(200);

    // ── the investments card's top movers ──
    //
    // Closing prices are public data this app caches in the browser rather
    // than carrying in the document, and no demo document has a Tiingo key to
    // fetch them with. Seeded here so there is something to rank: the ranking
    // is what is being checked, not the fetch.
    const inv = await browser.newPage({ viewport: { width: 1180, height: 1300 } });
    await inv.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await inv.waitForTimeout(800);
    const seeded = await inv.evaluate(() => {
      const raw = localStorage.getItem("sovereign.db.v1");
      if (!raw) return 0;
      const held = [...new Set((JSON.parse(raw).holdings ?? []).map((h) => h.ticker).filter(Boolean))];
      const series = {};
      // Six years of weekdays, each symbol with its own drift, so the five at
      // the top of the list are a real answer rather than the first five.
      held.forEach((ticker, n) => {
        const dates = [];
        const closes = [];
        let price = 40 + n * 11;
        for (let i = 0, d = new Date("2020-01-01T00:00:00Z"); i < 2600; i++, d = new Date(d.getTime() + 86400000)) {
          if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
          price = Math.max(5, price * (1 + Math.sin((i + n * 13) / 11) * 0.006 + ((n % 7) - 3) * 0.0004));
          dates.push(d.toISOString().slice(0, 10));
          closes.push(Math.round(price * 100));
        }
        series[ticker] = { ticker, dates, closes, fetchedAt: new Date().toISOString() };
      });
      localStorage.setItem("sovereign.benchmarks.v1", JSON.stringify({ v: 1, series }));
      return held.length;
    });
    check("the demo portfolio holds something to rank", seeded >= 5, `${seeded} symbols`);
    await inv.reload({ waitUntil: "networkidle" });
    await inv.waitForTimeout(1000);

    const movers = await inv.evaluate(() => {
      const rows = [...document.querySelectorAll(".inv-card .mover-row")];
      return rows.map((r) => ({
        ticker: r.querySelector(".mover-ticker")?.textContent.trim() ?? "",
        pct: r.querySelector(".mover-pct")?.textContent.trim() ?? "",
        down: !!r.querySelector(".mover-pct.neg"),
      }));
    });
    const size = (m) => Number((m.pct.match(/[\d.]+/) ?? [0])[0]);
    check("the investments card lists five top movers", movers.length === 5,
      `${movers.length} rows`);
    check("biggest move first, whichever way it went",
      movers.length > 1 && movers.every((m, i) => i === 0 || size(movers[i - 1]) >= size(m)),
      movers.map((m) => `${m.ticker} ${m.pct}`).join(" / "));
    check("and a fall is ranked on its size rather than sent to the bottom",
      movers.some((m) => m.down) && movers.some((m) => !m.down),
      movers.map((m) => `${m.ticker} ${m.down ? "down" : "up"}`).join(" / "));
    check("each of them names one symbol, once",
      new Set(movers.map((m) => m.ticker)).size === movers.length,
      movers.map((m) => m.ticker).join(" / "));

    // The same six periods as every other chart on the dashboard, and they
    // change the card rather than opening the investments screen.
    const spans = await inv.evaluate(() =>
      [...document.querySelectorAll(".inv-card .span-pill")].map((b) => b.textContent.trim()));
    check("the investments card offers the same periods as the rest",
      spans.join(" ") === "1M 3M 6M YTD 1Y ALL", spans.join(" "));
    const before = await inv.evaluate(() =>
      [...document.querySelectorAll(".inv-card .mover-row .mover-pct")].map((e) => e.textContent.trim()).join("|"));
    await inv.locator(".inv-card .span-pill", { hasText: "1Y" }).click({ timeout: 5000 });
    await inv.waitForTimeout(500);
    const after = await inv.evaluate(() => ({
      path: location.pathname,
      period: document.querySelector(".inv-card .inv-period")?.textContent.trim() ?? "",
      pcts: [...document.querySelectorAll(".inv-card .mover-row .mover-pct")].map((e) => e.textContent.trim()).join("|"),
      on: document.querySelector(".inv-card .span-pill.on")?.textContent.trim() ?? "",
    }));
    check("picking a period re-ranks the movers and stays on the dashboard",
      after.path === "/dashboard" && after.on === "1Y" && after.pcts !== before && after.pcts !== "",
      `${after.path}, ${after.on}, ${after.pcts}`);
    check("and the headline says which period it is reporting",
      after.period === "1 year", after.period);
    await inv.reload({ waitUntil: "networkidle" });
    await inv.waitForTimeout(900);
    const keptSpan = await inv.evaluate(() =>
      document.querySelector(".inv-card .span-pill.on")?.textContent.trim() ?? "");
    check("and the period survives a reload", keptSpan === "1Y", keptSpan);
    await inv.close();

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

    // ── the card is the link ──
    //
    // The corner link is gone and the whole widget goes to its page instead,
    // so these click a dead spot rather than a control, and click it for
    // real: a dispatched event skips hit testing, which is the one thing
    // being tested here. Anything that must stay live is checked after.
    check("no card has a link in its corner any more",
      (await dash.evaluate(() => document.querySelectorAll(".page > .card a.link").length)) === 0);

    // The mouse rather than the locator: Playwright refuses to click an
    // element that something else is covering, and reports a timeout, which
    // says nothing about where the press would have landed. Being covered is
    // the whole subject here, so these press the spot the reader sees and
    // read off where the app went.
    const pressAt = async (el) => {
      // Six cards do not fit on a phone, and a press at coordinates below the
      // fold lands on whatever is really there instead. Centred rather than
      // merely brought into view, so the spot is not up against the tab bar.
      await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
      await dash.waitForTimeout(300);
      const spot = await el.boundingBox();
      if (!spot) return "no such spot";
      await dash.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2);
      await dash.waitForTimeout(600);
      return decodeURIComponent(new URL(dash.url()).pathname);
    };
    const opens = async (i, sel) => {
      await dash.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
      await dash.waitForTimeout(700);
      return pressAt(dash.locator(".page > .card").nth(i).locator(sel).first());
    };
    // Indexed by position, so this list moves when the dashboard does. The
    // check above names the cards in order and fails first, which is what
    // makes a shift here readable rather than a run of wrong destinations.
    for (const [name, i, sel, want] of [
      ["net worth", 0, ".nw-value", "/accounts"],
      ["spending", 1, "h2", "/reports"],
      ["budget", 2, "h2", "/budget"],
      ["recurring", 3, "h2", "/recurring"],
      ["goals", 4, "h2", "/goals"],
      ["investments", 5, "h2", "/investments"],
    ]) {
      const at = await opens(i, sel);
      check(`clicking the ${name} widget anywhere opens ${want}`, at === want, at);
    }

    // "Anywhere" includes the parts of a card that are drawn in their own
    // layer: a chart, a progress bar. Those sit above ordinary text by the
    // rules of painting, so a sheet that only clears the text is not a sheet
    // over the card.
    // The spending chart is scrubbed rather than clicked, so like the net
    // worth one it answers for itself and stays where it is. Everything else
    // on the card still opens reports, which the run above checks.
    const onChart = await opens(1, ".chart-wrap");
    check("dragging across the spending chart reads it out rather than opening reports",
      onChart === "/dashboard", onChart);
    const onBar = await opens(2, ".bar");
    check("and the budget's own bar opens the budget", onBar === "/budget", onBar);

    // A row inside a list goes to that row's own page, not the card's.
    await dash.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await dash.waitForTimeout(700);
    const recName = (await dash.locator(".page > .card").nth(3).locator(".list-row .truncate").first().innerText()).trim();
    const recPath = await pressAt(dash.locator(".page > .card").nth(3).locator(".list-row").first());
    check("a recurring row opens that merchant, the way the recurring page's rows do",
      recPath === `/merchants/${recName}`, `${recPath} for ${recName}`);

    await dash.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await dash.waitForTimeout(700);
    const goalPath = await pressAt(dash.locator(".page > .card").nth(4).locator(".goal-row").first());
    check("a goal row opens that goal rather than the goals list",
      /^\/goals\/.+/.test(goalPath), goalPath);

    // The net worth card's own controls still answer, and still stay put.
    await dash.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await dash.waitForTimeout(900);
    // What the card is showing, taken from the pill that is lit and the
    // figure under it, since the card no longer says in words which kind it
    // is drawing.
    const nwKind = () => dash.evaluate(() => [
      document.querySelector('.nw-card .scope-pill[aria-selected="true"]')?.innerText.trim() ?? "",
      document.querySelector(".nw-card .nw-value")?.innerText.trim() ?? "",
    ].join(" "));
    const nwPeriod = () => dash.evaluate(() =>
      document.querySelector(".nw-card .nw-head .faint")?.innerText.trim() ?? "");
    const wasLabel = await nwKind();
    const pillPath = await pressAt(dash.locator(".nw-card .scope-pill").nth(1));
    check("a kind on the net worth card switches the chart and stays on the dashboard",
      pillPath === "/dashboard" && (await nwKind()) !== wasLabel,
      `${pillPath}, ${wasLabel} then ${await nwKind()}`);

    const wasPeriod = await nwPeriod();
    const spanPath = await pressAt(dash.locator(".nw-card .span-pill").nth(2));
    check("a period on the net worth card changes the range and stays on the dashboard",
      spanPath === "/dashboard" && (await nwPeriod()) !== wasPeriod,
      `${spanPath}, ${wasPeriod} then ${await nwPeriod()}`);

    // A real press with the mouse, so the sheet over the card gets its chance
    // to swallow it. It must not.
    const chart = await dash.locator(".nw-card .chart-wrap").boundingBox();
    const restTotal = await dash.evaluate(() => document.querySelector(".nw-value").innerText.trim());
    await dash.mouse.move(chart.x + chart.width * 0.3, chart.y + chart.height / 2);
    await dash.mouse.down();
    await dash.mouse.move(chart.x + chart.width * 0.7, chart.y + chart.height / 2, { steps: 8 });
    await dash.waitForTimeout(400);
    const scrubTotal = await dash.evaluate(() => document.querySelector(".nw-value").innerText.trim());
    const scrubPath = new URL(dash.url()).pathname;
    await dash.mouse.up();
    check("and dragging across the graph reads it out rather than opening accounts",
      scrubPath === "/dashboard" && scrubTotal !== restTotal,
      `${scrubPath}, ${restTotal} then ${scrubTotal}`);

    // ── the cash flow screen is gone ──
    //
    // It was the reports screen twice over. Checked by walking to its old
    // address as well as by looking for a way in: a route left behind renders
    // nothing and a link left behind goes nowhere, and neither shows up in a
    // list of what the nav offers.
    const wide = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await wide.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await wide.waitForTimeout(600);
    const offered = await wide.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
    check("nothing on the dashboard offers a way to the cash flow screen",
      !offered.some((h) => (h ?? "").startsWith("/cash-flow")),
      offered.filter((h) => (h ?? "").startsWith("/cash-flow")).join(", "));
    // textContent, not innerText: the rail collapses its labels, and a label
    // that is merely narrow to the eye is still a way in.
    const inNav = await wide.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href]")].map((a) => (a.textContent ?? "").trim()));
    check("nor does the sidebar", !inNav.some((t) => /cash\s*flow/i.test(t)), inNav.join(" / "));
    await wide.goto(`${BASE}/cash-flow`, { waitUntil: "networkidle" });
    await wide.waitForTimeout(700);
    check("and its old address lands on a screen that exists",
      new URL(wide.url()).pathname === "/dashboard",
      new URL(wide.url()).pathname);
    await wide.close();

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

  if (want("investments")) {
    // ── one card, two questions ──
    //
    // The four tiles that used to sit above the chart are gone, and what they
    // said has to still be somewhere: the period's change is the line's own
    // subject, and what the portfolio holds is the other side of the switch.
    const inv = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await inv.goto(`${BASE}/investments`, { waitUntil: "networkidle" });
    await inv.waitForTimeout(1000);

    const head = await inv.evaluate(() => {
      const card = document.querySelector(".page > .nw-card");
      return {
        first: document.querySelector(".page > *")?.className ?? "",
        views: [...document.querySelectorAll(".nw-card .scope-pill")].map((b) => b.innerText.trim()),
        lit: document.querySelector('.nw-card .scope-pill[aria-selected="true"]')?.innerText.trim() ?? "",
        value: card?.querySelector(".nw-value")?.innerText.trim() ?? "",
        delta: card?.querySelector(".nw-head .row")?.innerText.replace(/\n/g, " ").trim() ?? "",
        spans: card?.querySelectorAll(".span-pill").length ?? 0,
        chart: card?.querySelectorAll(".chart-wrap svg").length ?? 0,
        tiles: document.querySelectorAll(".page > .grid .tile-label").length,
      };
    });
    check("the page leads with the portfolio card rather than a row of tiles",
      head.first.includes("nw-card") && head.tiles === 0, `${head.first}, ${head.tiles} tiles`);
    check("which offers the value and what it is made of",
      head.views.join(" / ") === "Portfolio value / Allocation" && head.lit === "Portfolio value",
      `${head.views.join(" / ")}, showing ${head.lit}`);
    check("and reads like the accounts page: a figure, its change, and the period",
      /^\$[\d,]+/.test(head.value) && /\d/.test(head.delta) && /year|month|time/.test(head.delta),
      `${head.value} — ${head.delta}`);
    check("with the same six periods and one chart",
      head.spans === 6 && head.chart === 1, `${head.spans} periods, ${head.chart} charts`);

    // ── the funds are opened up ──
    //
    // Four tickers is four slices and answers nothing, because three of them
    // are funds and a fund is a portfolio of its own. The two views have to
    // actually differ: a look-through that quietly falls back to the recorded
    // tags draws a chart that looks entirely correct and is wrong by however
    // much international somebody holds through a world fund.
    if (await tryStep("the allocation view opens", async () => {
      await inv.locator(".nw-card .scope-pill", { hasText: "Allocation" }).click({ timeout: 5000 });
      await inv.waitForTimeout(700);
    })) {
      const readKey = () => inv.evaluate(() => {
        const rows = [...document.querySelectorAll(".donut-key .row, .donut-key > *")];
        const text = document.querySelector(".donut-key")?.innerText ?? "";
        return { text, rows: rows.length };
      });
      const slice = (text, label) =>
        Number((new RegExp(`${label}\\s*\\n\\$([\\d,]+)`).exec(text) ?? [])[1]?.replace(/,/g, "") ?? 0);

      const through = (await readKey()).text;
      const buttons = (await inv.locator(".alloc-switch button").allInnerTexts()).join("/");
      check("the allocation offers both what it holds and what was recorded",
        buttons === "What it holds/As recorded", buttons);
      check("and it opens on what the funds hold, not on the tickers as tagged",
        (await inv.locator(".alloc-switch button.on").innerText().catch(() => "")) === "What it holds",
        await inv.locator(".alloc-switch button.on").innerText().catch(() => "none lit"));
      // Read through the DOM rather than through a locator: an absent caption
      // is a result, not a reason to abandon the run with a stack trace one
      // line before it prints what passed.
      const note = await inv.evaluate(() => document.querySelector(".alloc-note")?.innerText ?? "");
      check("and says how much of the portfolio it could open up, and as of when",
        /opened up|counts as it was recorded/.test(note) && /\d{4}-\d{2}/.test(note), note || "no caption");

      if (await tryStep("the recorded view opens", async () => {
        await inv.locator(".alloc-switch button", { hasText: "As recorded" }).click({ timeout: 5000 });
        await inv.waitForTimeout(600);
      })) {
        const recorded = (await readKey()).text;
        check("and the two genuinely differ, or the look-through is doing nothing",
          through !== recorded, `${through.replace(/\n/g, " ")}`);
        // The direction is the point: a world fund tagged US stocks moves
        // money out of US equity and into international, never the other way.
        check("opening the funds moves money out of what they were tagged as",
          slice(through, "International") > slice(recorded, "International")
          && slice(through, "US Stocks") < slice(recorded, "US Stocks"),
          `intl ${slice(recorded, "International")} -> ${slice(through, "International")}, `
          + `us ${slice(recorded, "US Stocks")} -> ${slice(through, "US Stocks")}`);
        // And no money is created or lost in the opening up.
        const totals = (t) => ["US Stocks", "International", "Bonds", "Cash", "Crypto", "Real Estate", "Other"]
          .reduce((n, k) => n + slice(t, k), 0);
        check("without inventing or losing any of it",
          Math.abs(totals(through) - totals(recorded)) <= 4,
          `${totals(through)} against ${totals(recorded)}`);
        // The centre figure is the portfolio either way.
        check("and the ring still names the same portfolio in the middle",
          (await inv.locator(".donut-wrap .bold").first().innerText())
            === (await inv.evaluate(() => document.querySelector(".donut-wrap .bold")?.innerText)));
      }
      await inv.locator(".nw-card .scope-pill", { hasText: "Portfolio value" }).click();
      await inv.waitForTimeout(500);
    }

    // The figure has to be the portfolio, not the holdings: those differ when
    // an account carries cash that no position accounts for, and the chart is
    // drawn from account balances.
    const owned = await inv.evaluate(() => {
      const money = (t) => Number((t ?? "").replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0");
      const cards = [...document.querySelectorAll(".page > .card")].filter((c) => c.querySelector(".card-head.flush"));
      return {
        headline: money(document.querySelector(".nw-value")?.innerText),
        accounts: cards.map((c) => money(c.querySelector(".card-head.flush .num")?.innerText)),
      };
    });
    const summed = owned.accounts.reduce((a, b) => a + b, 0);
    check("and the headline is what the accounts below it add up to",
      owned.accounts.length > 1 && Math.abs(owned.headline - summed) <= owned.accounts.length,
      `${owned.headline} against ${summed} from ${owned.accounts.length} accounts`);

    // Dragging: the same chart as everywhere else, so the figure follows.
    const box = await inv.locator(".nw-card .chart-wrap").boundingBox();
    const rest = await inv.evaluate(() => document.querySelector(".nw-value").innerText.trim());
    await inv.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await inv.mouse.down();
    await inv.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
    await inv.waitForTimeout(400);
    const held = await inv.evaluate(() => ({
      value: document.querySelector(".nw-value").innerText.trim(),
      period: document.querySelector(".nw-head .faint")?.innerText.trim() ?? "",
    }));
    await inv.mouse.up();
    check("a finger on the line moves the figure and names the stretch",
      held.value !== rest && /\d{4}\s*[\u2013-]\s*\w/.test(held.period),
      `${rest} then ${held.value}, ${held.period}`);

    // ── the other side of the switch ──
    const switched = await tryStep("allocation can be chosen", async () => {
      await inv.locator(".nw-card .scope-pill").nth(1).click({ timeout: 5000 });
      await inv.waitForTimeout(600);
    });
    if (switched) {
      const alloc = await inv.evaluate(() => {
        const money = (t) => Number((t ?? "").replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0");
        const card = document.querySelector(".page > .nw-card");
        const rows = [...card.querySelectorAll(".donut-key .row")].map((r) => ({
          label: r.querySelector(".truncate")?.innerText.trim() ?? "",
          value: money(r.querySelector(".num.small")?.innerText),
          share: Number((r.querySelector(".tiny")?.innerText ?? "").replace("%", "")),
        }));
        return {
          rows,
          ring: card.querySelectorAll("svg circle").length,
          centre: money([...card.querySelectorAll(".num")].find((n) => /^\$/.test(n.innerText))?.innerText),
          spans: card.querySelectorAll(".span-pill").length,
          chart: card.querySelectorAll(".chart-wrap").length,
          foot: card.querySelector(".alloc-foot")?.innerText.replace(/\n/g, " ").trim() ?? "",
          views: card.querySelectorAll(".scope-pill").length,
        };
      });
      check("the ring replaces the chart rather than joining it",
        alloc.chart === 0 && alloc.ring > 1 && alloc.views === 2,
        `${alloc.chart} charts, ${alloc.ring} arcs, ${alloc.views} views`);
      check("and the period pills go with it, because allocation has no period",
        alloc.spans === 0, `${alloc.spans} periods still showing`);
      check("every asset class is named, with what it comes to and its share",
        alloc.rows.length > 2 && alloc.rows.every((r) => r.label && r.value > 0 && r.share > 0),
        alloc.rows.map((r) => `${r.label} ${r.value} ${r.share}%`).join(", "));
      check("the shares account for the whole ring",
        Math.abs(alloc.rows.reduce((s, r) => s + r.share, 0) - 100) <= 2,
        `${alloc.rows.reduce((s, r) => s + r.share, 0)}%`);
      check("and the middle of it is what the slices add up to",
        Math.abs(alloc.centre - alloc.rows.reduce((s, r) => s + r.value, 0)) <= alloc.rows.length,
        `${alloc.centre} against ${alloc.rows.reduce((s, r) => s + r.value, 0)}`);
      // The gain the tiles used to carry has to have landed somewhere.
      check("what the holdings have made against what was paid is still said",
        /against what was paid/.test(alloc.foot) && /%/.test(alloc.foot), alloc.foot);

      await inv.locator(".nw-card .scope-pill").nth(0).click();
      await inv.waitForTimeout(600);
      const back = await inv.evaluate(() => ({
        spans: document.querySelectorAll(".nw-card .span-pill").length,
        value: document.querySelector(".nw-value")?.innerText.trim() ?? "",
      }));
      check("and going back brings the chart and its periods with it",
        back.spans === 6 && back.value === rest, `${back.spans} periods, ${back.value}`);
    }
    await inv.close();

    // ── the headline is the portfolio, the ring is the holdings ──
    //
    // In this data the two come to the same figure, so nothing above can tell
    // them apart, and a headline wired to the wrong one would read correctly
    // for as long as every account's positions happened to account for its
    // whole balance. A holding is added to force them apart: the ring is what
    // the positions come to and must move, while the line is drawn from
    // account balances and must not.
    //
    // Its own page, so its own storage: browser.newPage gives a fresh context.
    const split = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await split.goto(`${BASE}/investments`, { waitUntil: "networkidle" });
    await split.waitForTimeout(1000);
    const money = (t) => Number((t ?? "").replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0");
    const readBoth = async () => {
      const headline = money(await split.locator(".nw-value").innerText());
      await split.locator(".nw-card .scope-pill").nth(1).click();
      await split.waitForTimeout(500);
      const ring = money(await split.locator(".donut-wrap .num.bold").first().innerText());
      await split.locator(".nw-card .scope-pill").nth(0).click();
      await split.waitForTimeout(500);
      return { headline, ring };
    };
    const before = await readBoth();
    const put = await tryStep("a holding can be added", async () => {
      await split.locator('.topbar button:has-text("Holding")').click({ timeout: 5000 });
      await split.locator(".modal").waitFor({ timeout: 5000 });
      await split.locator(".modal .field:has(label:text-is('Ticker')) input").fill("ZZZTEST");
      await split.locator(".modal .field:has(label:text-is('Shares')) input").fill("100");
      await split.locator(".modal .field:has(label:text-is('Price per share')) input").fill("100.00");
      await split.locator('.modal-foot button:has-text("Save")').click({ timeout: 5000 });
      await split.locator(".modal").waitFor({ state: "detached", timeout: 5000 });
      await split.waitForTimeout(800);
    });
    if (put) {
      const after = await readBoth();
      check("a new position moves what the ring says the holdings come to",
        Math.abs((after.ring - before.ring) - 10000) <= 2,
        `${before.ring} then ${after.ring}`);
      check("and leaves the headline alone, because that is the accounts' own balance",
        after.headline === before.headline,
        `${before.headline} then ${after.headline}`);
    }
    await split.close();

    // ── measuring the portfolio against the market ──
    //
    // The provider is stubbed rather than called: there is no Tiingo token in
    // a test run and no network in CI, and what is being checked here is the
    // whole client path anyway — that the closes are asked for once, cached,
    // rebased onto the portfolio's own axis and drawn. The stub answers the
    // way the real endpoint does, windowed by the dates it was asked for, so
    // a request for the wrong window comes back short rather than silently
    // right.
    const closes = (seed, drift) => {
      const rows = [];
      let px = 100 + seed * 40;
      const d = new Date();
      d.setFullYear(d.getFullYear() - 6);
      let r = seed * 9973 + 7;
      const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
      for (let i = 0; i < 6 * 365; i++) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        px = Math.max(1, px * (1 + drift + rnd() * 0.012));
        rows.push({ date: d.toISOString().slice(0, 10), close: Math.round(px * 100) / 100 });
      }
      return rows;
    };
    // Everything the demo portfolio holds except AAPL, which is left out on
    // purpose: a symbol the provider has nothing for is the ordinary case of a
    // private fund or a stable-value option, and it has to say so rather than
    // lighting its marker and drawing nothing.
    const MARKET = {
      SPY: closes(1, 0.0004), VTI: closes(2, 0.00035), BND: closes(3, -0.00002),
      VXUS: closes(4, 0.0002), VFIAX: closes(5, 0.00038), VTIAX: closes(6, 0.00021),
      VBTLX: closes(7, -0.00001), VTWAX: closes(8, 0.0003), SPAXX: closes(9, 0.00001),
    };

    const bench = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    let asked = [];
    await bench.route("**/api/prices", async (route) => {
      const body = route.request().postDataJSON();
      if (Array.isArray(body.history)) {
        asked.push({ tickers: body.history, from: body.from, to: body.to });
        const out = {};
        for (const t of body.history) {
          const up = String(t).toUpperCase();
          out[up] = (MARKET[up] ?? []).filter((x) => x.date >= body.from && x.date <= body.to);
        }
        return route.fulfill({ json: { history: out } });
      }
      return route.fulfill({ json: { quotes: [], misses: [] } });
    });

    // Through the settings screen: the document is the app's to write, and a
    // test that edits it underneath passes against a state the app cannot be
    // in. This is also the path a reader takes to turn the feature on.
    await bench.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    await bench.waitForTimeout(900);
    const keyed = await tryStep("a Tiingo token can be entered", async () => {
      // :visible, because the settings table and the phone cards both carry
      // this field and only one of them is ever on screen.
      await bench.locator(':is(tr, .int-row):has-text("Tiingo") input:visible').first()
        .fill("test-token", { timeout: 5000 });
      await bench.waitForTimeout(700);
    });

    if (keyed) {
      await bench.goto(`${BASE}/investments`, { waitUntil: "networkidle" });
      await bench.waitForTimeout(1000);

      const offered = await bench.evaluate(() =>
        [...document.querySelectorAll(".against-pill")].map((b) => b.innerText.trim()));
      check("the portfolio can be measured against three markets, and none is forced",
        offered.join(" / ") === "S&P 500 / US Stocks / US Bonds", offered.join(" / "));

      const alone = await bench.evaluate(() => ({
        lines: document.querySelectorAll(".nw-card .chart-wrap svg path[stroke]").length,
        legend: document.querySelectorAll(".nw-versus-item").length,
        pressed: document.querySelectorAll('.against-pill[aria-pressed="true"]').length,
      }));
      check("and none of them is on until one is chosen",
        alone.pressed === 0 && alone.legend === 0 && alone.lines === 2,
        `${alone.pressed} pressed, ${alone.legend} named, ${alone.lines} lines`);

      asked = [];
      const picked = await tryStep("a benchmark can be chosen", async () => {
        await bench.locator('.against-pill:has-text("S&P 500")').click({ timeout: 5000 });
        await bench.waitForTimeout(2200);
      });
      if (picked) {
        // Six years, not the year on screen: the range pills move the window,
        // and refetching on every press would spend a request each time. The
        // table asks for every position it lists, so what matters is the width
        // of each window and that the symbol just chosen is among them.
        check("which fetches one window wide enough for every period on offer",
          asked.length > 0
          && asked.every((a) => Number(a.to.slice(0, 4)) - Number(a.from.slice(0, 4)) >= 5)
          && asked.some((a) => a.tickers.includes("SPY")),
          JSON.stringify(asked));
        // Batched rather than one connection per symbol: a page that opens
        // with a table full of positions would otherwise fan out.
        check("and asks for several symbols per request rather than one each",
          asked.every((a) => a.tickers.length <= 4) && asked.some((a) => a.tickers.length > 1),
          asked.map((a) => a.tickers.length).join(", "));

        const two = await bench.evaluate(() => ({
          lines: document.querySelectorAll(".nw-card .chart-wrap svg path[stroke]").length,
          legend: [...document.querySelectorAll(".nw-versus-item")].map((e) => e.innerText.replace(/\n/g, " ").trim()),
          own: document.querySelector(".nw-head .row")?.innerText.replace(/\n/g, " ").trim() ?? "",
          value: document.querySelector(".nw-value")?.innerText.trim() ?? "",
        }));
        check("a second line joins the first", two.lines === 3, `${two.lines} lines drawn`);
        check("and its return is said beside the portfolio's, both as proportions",
          two.legend.length === 1 && /S&P 500/.test(two.legend[0]) && /[+-][\d.]+%/.test(two.legend[0]),
          two.legend.join(" | "));
        check("while the headline stays in money, because a portfolio has some",
          /^\$[\d,]+/.test(two.value) && /\$/.test(two.own), `${two.value} — ${two.own}`);

        // Both lines are rebased to the period, so both start at the same
        // height whatever they are worth. A benchmark plotted in dollars would
        // sit somewhere off the top of a chart scaled to a portfolio.
        const startsAt = async () => bench.evaluate(() => {
          const svg = document.querySelector(".nw-card .chart-wrap svg");
          const paths = [...svg.querySelectorAll("path[stroke]")]
            .filter((p) => getComputedStyle(p).stroke !== "none")
            .map((p) => (p.getAttribute("d") ?? "").match(/M(-?[\d.]+),(-?[\d.]+)/))
            .filter(Boolean)
            .map((m) => parseFloat(m[2]));
          return { ys: paths, height: svg.getBoundingClientRect().height };
        });
        const starts = await startsAt();
        check("both lines open from the same height, because both are rebased",
          starts.ys.length >= 2 && Math.max(...starts.ys) - Math.min(...starts.ys) <= starts.height * 0.06,
          `${starts.ys.map((y) => Math.round(y)).join(" / ")} in ${Math.round(starts.height)}px`);

        // Changing the period must not go back to the provider: the cache
        // already holds six years and this is the press a reader makes most.
        asked = [];
        await bench.locator(".nw-card .span-pill").nth(1).click();
        await bench.waitForTimeout(1200);
        const after = await bench.evaluate(() =>
          document.querySelectorAll(".nw-card .chart-wrap svg path[stroke]").length);
        check("and a different period is drawn from what was already fetched",
          asked.length === 0 && after === 3, `${asked.length} more requests, ${after} lines`);

        // ── as many as you like, each in its own colour ──
        await bench.locator('.against-pill:has-text("US Bonds")').click();
        await bench.waitForTimeout(1800);
        const both = await bench.evaluate(() => ({
          lines: document.querySelectorAll(".nw-card .chart-wrap svg path[stroke]").length,
          legend: [...document.querySelectorAll(".nw-versus-item")].map((e) => e.innerText.replace(/\n/g, " ").trim()),
          pressed: document.querySelectorAll('.against-pill[aria-pressed="true"]').length,
        }));
        check("a second market joins rather than replacing the first",
          both.pressed === 2 && both.legend.length === 2 && both.lines === 4,
          `${both.pressed} pressed, ${both.legend.join(" | ")}, ${both.lines} lines`);

        // ── what every line was doing on the day under the finger ──
        //
        // The headline can only speak for one line. With four on the page the
        // question is what each was doing on that day, and it has to be
        // answered where the finger is.
        const chart = await bench.locator(".nw-card .chart-wrap").boundingBox();
        await bench.mouse.move(chart.x + chart.width * 0.55, chart.y + chart.height / 2);
        await bench.waitForTimeout(500);
        const readout = await bench.evaluate(() => {
          const el = document.querySelector(".scrub-tip");
          if (!el) return null;
          return {
            rows: [...el.querySelectorAll(".scrub-row")].map((r) => ({
              label: r.querySelector(".truncate")?.innerText.trim() ?? "",
              value: r.querySelector(".num")?.innerText.trim() ?? "",
              tone: getComputedStyle(r.querySelector(".dot")).backgroundColor,
            })),
            date: el.querySelector(".tiny")?.innerText.trim() ?? "",
          };
        });
        check("resting on the chart says what every line had done by that day",
          readout !== null && readout.rows.length === 3
          && readout.rows.every((r) => /^[+-][\d.]+%$/.test(r.value) || r.value === "-"),
          readout ? readout.rows.map((r) => `${r.label} ${r.value}`).join(" | ") : "no readout");
        check("the portfolio's own line among them, named and first",
          readout?.rows[0]?.label === "Your portfolio", readout?.rows[0]?.label);
        check("and each in the colour it is drawn in",
          readout !== null && new Set(readout.rows.map((r) => r.tone)).size === readout.rows.length,
          readout?.rows.map((r) => r.tone).join(" | "));
        check("with the day it is reading named",
          /\d{4}/.test(readout?.date ?? ""), readout?.date);

        // The figures follow the finger rather than reporting the period.
        await bench.mouse.move(chart.x + chart.width * 0.15, chart.y + chart.height / 2);
        await bench.waitForTimeout(400);
        const earlier = await bench.evaluate(() => ({
          date: document.querySelector(".scrub-tip .tiny")?.innerText.trim() ?? "",
          first: document.querySelector(".scrub-tip .scrub-row .num")?.innerText.trim() ?? "",
        }));
        check("and moving along it reads a different day",
          earlier.date !== readout?.date && earlier.date !== "",
          `${readout?.date} then ${earlier.date}`);
        await bench.mouse.move(chart.x + chart.width / 2, chart.y - 60);
        await bench.waitForTimeout(400);
        check("taking the finger off puts it away",
          (await bench.evaluate(() => document.querySelectorAll(".scrub-tip").length)) === 0);

        // ── a holding is a price series too ──
        const dots = bench.locator(".hold-dot");
        const count = await dots.count();
        check("every holding that carries a symbol can be put on the chart",
          count > 3, `${count} holdings offer it`);
        // A money-market fund typed in by hand has no symbol to ask about, so
        // the whole table must not simply sprout a button per row.
        const rows = await bench.evaluate(() =>
          document.querySelectorAll(".tbl-holdings tbody tr").length);
        check("and the toggle is a toggle, not decoration on every row",
          (await bench.evaluate(() => document.querySelectorAll('.hold-dot[aria-pressed="true"]').length)) === 0
          && count <= rows,
          `${count} of ${rows} rows`);

        // Two that are nobody's benchmark, so two colours actually come out
        // of the palette — picking one would let a palette that hands back the
        // same colour every time pass, since the benchmarks bring their own.
        // And AAPL, which the provider here has nothing for.
        for (const i of [1, 2, 4]) {
          await dots.nth(i).click();
          await bench.waitForTimeout(1500);
        }

        const many = await bench.evaluate(() => {
          const tone = (el) => getComputedStyle(el).backgroundColor;
          const svg = document.querySelector(".nw-card .chart-wrap svg");
          return {
            lines: [...svg.querySelectorAll("path[stroke]")]
              .filter((p) => getComputedStyle(p).stroke !== "none")
              .map((p) => getComputedStyle(p).stroke),
            legend: [...document.querySelectorAll(".nw-versus-item")].map((e) => ({
              text: e.innerText.replace(/\n/g, " ").trim(),
              tone: tone(e.querySelector(".dot")),
            })),
            lit: [...document.querySelectorAll('.hold-dot[aria-pressed="true"]')].map(tone),
          };
        });
        // Five named: two markets and three holdings. Six lines: the
        // portfolio's own two clipped halves plus four that had prices behind
        // them — AAPL is named but has nothing to draw.
        check("a holding put on the chart draws its own line and is named for it",
          many.legend.length === 5 && many.lines.length === 6,
          `${many.legend.length} named, ${many.lines.length} lines`);
        const quiet = many.legend.find((l) => /AAPL/.test(l.text));
        check("and a symbol the provider has nothing for says so rather than going quiet",
          quiet !== undefined && /no reading/i.test(quiet.text),
          many.legend.map((l) => l.text).join(" | "));
        // The whole point of a colour is telling one line from another.
        const tones = many.legend.map((l) => l.tone);
        check("and every line on the chart is a different colour",
          new Set(tones).size === tones.length, tones.join(" | "));
        check("with the holding's own marker painted to match its line",
          many.lit.length === 3 && many.lit.every((t) => tones.includes(t)),
          `${many.lit.join(" | ")} against ${tones.join(" | ")}`);

        await dots.nth(1).click();
        await bench.waitForTimeout(900);
        const fewer = await bench.evaluate(() => ({
          legend: document.querySelectorAll(".nw-versus-item").length,
          lit: document.querySelectorAll('.hold-dot[aria-pressed="true"]').length,
        }));
        check("taking one off removes its line and leaves the rest",
          fewer.legend === 4 && fewer.lit === 2, `${fewer.legend} named, ${fewer.lit} lit`);

        // Off again, all of it.
        for (const label of ["S&P 500", "US Bonds"]) {
          await bench.locator(`.against-pill:has-text("${label}")`).click();
          await bench.waitForTimeout(500);
        }
        while (await bench.locator('.hold-dot[aria-pressed="true"]').count()) {
          await bench.locator('.hold-dot[aria-pressed="true"]').first().click();
          await bench.waitForTimeout(500);
        }
        const off = await bench.evaluate(() => ({
          lines: document.querySelectorAll(".nw-card .chart-wrap svg path[stroke]").length,
          legend: document.querySelectorAll(".nw-versus-item").length,
        }));
        check("and clearing them all puts the card back as it was",
          off.lines === 2 && off.legend === 0, `${off.lines} lines, ${off.legend} named`);
      }

      // ── positions the sync owns are not the app's to edit ──
      //
      // Plaid sends holdings and a sync replaces every holding on an account
      // it reports for, so an edit there reverts the next morning. SimpleFIN
      // sends none and a hand-entered account has nobody else to speak for it,
      // so both keep theirs.
      //
      // The document is seeded before the app boots rather than edited under
      // it: the store flushes its own copy over localStorage on beforeunload,
      // so anything written and then reloaded into is thrown away. Handing the
      // app a document at startup is what a cloud pull does anyway.
      const seeded = await bench.evaluate(() => localStorage.getItem("sovereign.db.v1"));
      const openWith = async (edit) => {
        const doc = JSON.parse(seeded);
        edit(doc);
        const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
        await page.addInitScript((raw) => localStorage.setItem("sovereign.db.v1", raw), JSON.stringify(doc));
        await page.goto(`${BASE}/investments`, { waitUntil: "networkidle" });
        await page.waitForTimeout(1200);
        return page;
      };
      const isInvestment = (a) => ["investment", "retirement", "crypto"].includes(a.type);

      const mixed = await openWith((doc) => {
        const a = doc.accounts.find(isInvestment);
        a.syncSource = "plaid";
        a.syncId = "pl_test_1";
      });
      const split = await mixed.evaluate(() => ({
        cards: [...document.querySelectorAll(".page > .card")]
          .filter((c) => c.querySelector(".tbl-holdings"))
          .map((c) => ({
            sub: c.querySelector(".card-head.flush .small.muted")?.innerText.trim() ?? "",
            edits: c.querySelectorAll(".tbl-holdings .btn").length,
            rows: c.querySelectorAll(".tbl-holdings tbody tr").length,
          })),
        add: [...document.querySelectorAll(".topbar button")].filter((b) => /Holding/.test(b.innerText)).length,
      }));
      const owned = split.cards[0];
      const mine = split.cards.slice(1);
      check("an account whose positions the sync owns offers no way to edit them",
        owned !== undefined && owned.edits === 0 && owned.rows > 0,
        owned ? `${owned.edits} buttons over ${owned.rows} rows` : "no cards");
      check("and says where they come from, rather than just going quiet",
        /sync/i.test(owned?.sub ?? ""), owned?.sub);
      check("while an account the sync does not speak for keeps its own",
        mine.length > 0 && mine.every((c) => c.edits === c.rows && c.rows > 0),
        mine.map((c) => `${c.edits}/${c.rows}`).join(", "));
      check("and a holding can still be added while any account can take one",
        split.add === 1, `${split.add} add buttons`);
      await mixed.close();

      // Every investment account synced: nothing left to file a holding under,
      // so the button that would file it goes too.
      const every = await openWith((doc) => {
        for (const a of doc.accounts.filter(isInvestment)) {
          a.syncSource = "plaid";
          a.syncId = `pl_${a.id}`;
        }
      });
      const none = await every.evaluate(() => ({
        edits: document.querySelectorAll(".tbl-holdings .btn").length,
        rows: document.querySelectorAll(".tbl-holdings tbody tr").length,
        add: [...document.querySelectorAll(".topbar button")].filter((b) => /Holding/.test(b.innerText)).length,
      }));
      check("with every account synced, nothing on the page offers to edit a holding",
        none.edits === 0 && none.rows > 0 && none.add === 0,
        `${none.edits} edits, ${none.add} add, over ${none.rows} rows`);
      await every.close();

      // ── the holdings table reads as columns of figures, and one of names ──
      const aligned = await bench.evaluate(() => {
        const align = (c) => getComputedStyle(c).textAlign;
        const cells = [...document.querySelectorAll(".tbl-holdings th, .tbl-holdings td")];
        const figures = cells.filter((c) => !c.classList.contains("hold-name"));
        const names = cells.filter((c) => c.classList.contains("hold-name"));
        return {
          total: cells.length,
          off: figures.filter((c) => align(c) !== "center")
            .map((c) => `${c.tagName} "${c.innerText.trim().slice(0, 14)}"`),
          names: names.length,
          namesLeft: names.filter((c) => align(c) === "left").length,
        };
      });
      check("every column of figures is centred, headers included",
        aligned.total > 12 && aligned.off.length === 0,
        aligned.off.slice(0, 5).join(", ") || `${aligned.total} cells`);
      // The name is not a figure: a run of tickers wants one left edge to
      // read down, not a ragged middle.
      check("and the holding itself reads down a left edge",
        aligned.names > 4 && aligned.namesLeft === aligned.names,
        `${aligned.namesLeft} of ${aligned.names} left`);

      // ── the period the chart is showing runs through the table ──
      //
      // Set explicitly: an earlier check left the range on three months, and a
      // test that reads whatever happens to be selected is reading its own
      // neighbours rather than the feature.
      await bench.locator(".nw-card .span-pill").nth(4).click();
      await bench.waitForTimeout(1200);
      const periodCol = async () => bench.evaluate(() => {
        const heads = [...document.querySelectorAll(".tbl-holdings thead th")].map((h) => h.innerText.trim());
        const at = heads.findIndex((h) => /^past /i.test(h));
        const rows = [...document.querySelectorAll(".tbl-holdings tbody tr")];
        return {
          head: heads[at] ?? "",
          at,
          values: rows.map((r) => r.children[at]?.innerText.trim() ?? ""),
          groups: [...document.querySelectorAll(".page > .card .card-head.flush")]
            .map((h) => h.innerText.replace(/\n/g, " ").trim()),
        };
      });
      const aYear = await periodCol();
      check("each position says what it did over the period, named for it",
        /past 1 year/i.test(aYear.head) && aYear.values.length > 4
        && aYear.values.every((v) => /^[+-][\d.]+%$/.test(v) || v === "-"),
        `${aYear.head}: ${aYear.values.slice(0, 4).join(", ")}`);
      check("and so does each group it is filed under",
        aYear.groups.every((g) => /[+-][\d.]+%/.test(g)),
        aYear.groups.join(" | "));

      // Changing the range changes the table, which is the whole point.
      await bench.locator(".nw-card .span-pill").nth(0).click();
      await bench.waitForTimeout(1200);
      const aMonth = await periodCol();
      check("choosing a different period renames the column and rewrites it",
        /past 1 month/i.test(aMonth.head)
        && aMonth.values.join() !== aYear.values.join(),
        `${aMonth.head}: ${aMonth.values.slice(0, 4).join(", ")}`);
      await bench.locator(".nw-card .span-pill").nth(4).click();
      await bench.waitForTimeout(1200);

      // ── the same positions, cut a different way ──
      const cuts = await bench.evaluate(() =>
        [...document.querySelectorAll(".hold-controls select option")].map((o) => o.innerText.trim()));
      check("the table can be cut five ways",
        cuts.join(" / ") === "By account / By institution / By asset class / By security type / By security",
        cuts.join(" / "));

      const cutBy = async (value) => {
        await bench.locator(".hold-controls select").selectOption(value);
        await bench.waitForTimeout(800);
        return bench.evaluate(() => ({
          groups: [...document.querySelectorAll(".page > .card")]
            .filter((c) => c.querySelector(".card-head.flush"))
            .map((c) => ({
              label: c.querySelector(".card-head.flush h2")?.innerText.trim() ?? "",
              value: Number((c.querySelector(".card-head.flush .num.bold")?.innerText ?? "")
                .replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0"),
              rows: c.querySelectorAll(".tbl-holdings tbody tr").length,
            })),
          positions: document.querySelectorAll(".tbl-holdings tbody tr").length,
        }));
      };
      const byAccount = await cutBy("account");
      const byClass = await cutBy("class");
      const byType = await cutBy("type");
      const bySecurity = await cutBy("security");

      check("each cut names its groups differently",
        new Set([byAccount, byClass, byType, bySecurity]
          .map((c) => c.groups.map((g) => g.label).join("|"))).size === 4,
        [byAccount, byClass, byType, bySecurity].map((c) => c.groups.map((g) => g.label).join(",")).join("  //  "));
      check("and every one of them still accounts for every position",
        [byClass, byType, bySecurity].every((c) => c.positions === byAccount.positions),
        `${byAccount.positions} by account against ${[byClass, byType, bySecurity].map((c) => c.positions).join(", ")}`);
      // The question behind every cut is where the money is, so the biggest
      // group leads. Not the account cut, which keeps the order the accounts
      // are in so an empty one still appears.
      for (const [name, cut] of [["asset class", byClass], ["security type", byType], ["security", bySecurity]]) {
        const vals = cut.groups.map((g) => g.value);
        check(`the ${name} cut leads with the money`,
          vals.length > 1 && vals.every((v, i) => i === 0 || v <= vals[i - 1]),
          vals.join(" > "));
      }
      // "etf" from a provider, not "Etf" from a title-caser.
      check("a provider's own word for an instrument is written the way a reader would",
        byType.groups.some((g) => g.label === "ETF") && !byType.groups.some((g) => /^Etf$/.test(g.label)),
        byType.groups.map((g) => g.label).join(", "));
      await cutBy("account");

      // ── the prices card is gone ──
      check("the page no longer carries a card about where prices come from",
        (await bench.evaluate(() => !/previous close|refresh prices/i.test(document.body.innerText))) === true);
    }
    await bench.close();
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

    // The savings rate came across when the cash flow screen was taken out.
    // It is the proportion, which is the figure that stays comparable when the
    // months being compared are not.
    const summary = await rep.evaluate(() => {
      const rows = [...document.querySelectorAll(".report-sum")].map((r) => r.innerText.replace(/\n/g, " "));
      return { rows, rate: rows.find((r) => /savings rate/i.test(r)) ?? "" };
    });
    check("the flow summary still reports a savings rate",
      /%/.test(summary.rate), summary.rows.join(" | "));

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

    // ── fewer periods, fatter bars ──
    //
    // A quarter and a year are the same chart at two densities. When the year
    // is asked for, the slots themselves hold the bars apart; when the quarter
    // is, the bar has to take up the room the missing months left, or three
    // pencil lines sit adrift in an empty card. Measured on a desktop card,
    // which is where the emptiness was.
    const flow = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await flow.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
    await flow.waitForTimeout(900);
    const barsAt = async (range) => {
      await flow.locator(".topbar select").first().selectOption(range);
      await flow.waitForTimeout(800);
      return flow.evaluate(() => {
        const svg = document.querySelector(".card .chart-wrap svg");
        const box = [...svg.querySelectorAll("rect")]
          .filter((r) => getComputedStyle(r).fill === "rgb(53, 196, 140)")
          .map((r) => r.getBoundingClientRect())
          .sort((a, b) => a.left - b.left);
        const mids = box.map((b) => (b.left + b.right) / 2);
        // The slot each bar was given, so "wide enough" is a share of the room
        // available rather than a pixel count that means nothing on its own.
        const slot = mids.length > 1 ? mids[1] - mids[0] : svg.getBoundingClientRect().width;
        return { count: box.length, width: Math.round(box[0]?.width ?? 0), fill: (box[0]?.width ?? 0) / slot };
      });
    };
    const year = await barsAt("1y");
    const quarter = await barsAt("3m");
    check("a quarter draws fewer bars than a year", quarter.count < year.count && quarter.count > 1,
      `${quarter.count} against ${year.count}`);
    check("and draws them wider, rather than leaving the room empty",
      quarter.width > year.width && quarter.width >= 60,
      `${quarter.width}px for ${quarter.count} against ${year.width}px for ${year.count}`);
    check("a year's bars still nearly fill their own slots",
      year.fill > 0.5, `${Math.round(year.fill * 100)}% of the slot`);
    await flow.close();

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

  if (want("forecast")) {
    // ── a guess, drawn as a guess ──
    //
    // The headline is one walk out of three and the band around it is the
    // other two. A reader who sees only the line will read a figure thirty
    // years out as a promise, so the band has to actually be there and it has
    // to be wider than the line.
    const fc = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await fc.goto(`${BASE}/forecast`, { waitUntil: "networkidle" });
    await fc.waitForTimeout(900);

    const shape = await fc.evaluate(() => {
      const card = document.querySelector(".page > .nw-card");
      const svg = card?.querySelector("svg");
      const paths = svg ? [...svg.querySelectorAll("path")] : [];
      const filled = paths.filter((x) => x.getAttribute("fill") !== "none" && x.getAttribute("d"));
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      const tiles = [...document.querySelectorAll(".page > .grid.g3 > .card")].map((c) => box(c));
      return {
        first: document.querySelector(".page > *")?.className ?? "",
        headline: card?.querySelector(".nw-total")?.innerText.trim() ?? "",
        range: card?.querySelector(".fc-head .small.faint")?.innerText.trim() ?? "",
        charts: card ? card.querySelectorAll(".chart-wrap svg").length : 0,
        bands: filled.length,
        marks: [...(svg?.querySelectorAll("text.axis-text") ?? [])].map((t) => t.textContent),
        tileRows: new Set(tiles.map((b) => Math.round(b.top))).size,
        tileCount: tiles.length,
        // The assumptions card's own fields. Counting every .fc-grid on the
        // page swept up Social Security's three as well.
        dials: document.querySelectorAll(".card:not(.ss-card) > .fc-grid .field").length,
        dialRows: new Set([...document.querySelectorAll(".fc-grid .field")]
          .map((el) => Math.round(el.getBoundingClientRect().top))).size,
        accounts: document.querySelectorAll(".fc-acc").length,
      };
    });
    check("the page leads with the forecast card",
      shape.first.includes("fc-scenarios") && shape.charts === 1, `${shape.first}, ${shape.charts} charts`);
    check("with a figure and the range it could land in",
      /^\$[\d,]+$/.test(shape.headline) && /between .* and /.test(shape.range),
      `${shape.headline} — ${shape.range}`);
    check("the band is drawn, not just the line",
      shape.bands >= 1, `${shape.bands} filled paths`);

    /**
     * How far apart the good and bad cases are drawn at the end of the walk.
     *
     * In pixels, but as a floor rather than a comparison: the band closes back
     * on itself at the last x, so both outcomes are among the points there and
     * a band built from one walk three times collapses to nothing. A ratio
     * between two runs would not catch that, because the chart rescales to
     * whatever it is handed.
     */
    const bandGapAtEnd = () => fc.evaluate(() => {
      const d = document.querySelector("svg path[opacity='0.1']")?.getAttribute("d") ?? "";
      const pts = [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      if (!pts.length) return 0;
      const right = Math.max(...pts.map((q) => q[0]));
      const ys = pts.filter((q) => q[0] === right).map((q) => q[1]);
      return ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : 0;
    });
    check("and it has real height, rather than three copies of one walk",
      (await bandGapAtEnd()) > 20, `${(await bandGapAtEnd()).toFixed(0)}px apart at the end`);

    // The card leads with net worth at retirement. What is left at the end is
    // a different figure on a different tile, and reading one where the other
    // belongs draws a chart that looks entirely correct.
    // The first dollar figure in the string, and only that one: the sentence
    // ends "left at 95", and stripping every non-digit would glue the age onto
    // the money and compare a number that is in neither place.
    const money = (t) => Number((/\$([\d,]+)/.exec(t ?? "")?.[1] ?? "").replace(/,/g, ""));
    const atEnd = money(await fc.evaluate(() =>
      document.querySelector(".grid.g3 .card .small.muted")?.innerText ?? ""));
    check("the headline is the figure at retirement, not the one at the end",
      atEnd > 0 && money(shape.headline) !== atEnd, `${shape.headline} against ${atEnd}`);
    check("and the retirement age is marked on it",
      shape.marks.some((t) => /Retire at \d+/.test(t ?? "")), shape.marks.filter(Boolean).join(" "));
    check("three tiles on one row on a desktop",
      shape.tileCount === 3 && shape.tileRows === 1, `${shape.tileCount} tiles over ${shape.tileRows} rows`);
    check("and every assumption is a field on the page",
      shape.dials === 10 && shape.dialRows <= 3, `${shape.dials} fields over ${shape.dialRows} rows`);
    check("with a row per account whose tax or terms the walk needs",
      shape.accounts >= 3, `${shape.accounts} rows`);

    // ── the picture is answered, not decorated ──
    //
    // Every figure on this screen could be drawn convincingly from the wrong
    // source: the headline from the end of the plan rather than retirement,
    // the band from one walk drawn three times, the marker from a label that
    // moves while the line stays put. Each of these changes one input and
    // requires the thing it should move to move.
    const storedPlan = () => fc.evaluate(() =>
      JSON.parse(localStorage.getItem("sovereign.db.v1") ?? "{}").forecast ?? null);
    check("looking at the forecast does not write one into the document",
      (await storedPlan()) === null);

    const markerX = () => fc.evaluate(() => {
      const g = [...document.querySelectorAll("svg g")]
        .find((el) => /Retire at/.test(el.querySelector("text")?.textContent ?? ""));
      return g ? Number(g.querySelector("line")?.getAttribute("x1")) : null;
    });
    /**
     * The good case less the bad one, in dollars, as the card states them.
     *
     * Read off the words rather than measured off the drawing: the chart
     * rescales to whatever it is given, so a band twice as wide in money is
     * only a few pixels taller once it fills the plot, and a pixel check
     * quietly stops being able to tell the two apart.
     */
    const bandSpread = () => fc.evaluate(() => {
      const text = document.querySelector(".fc-head .small.faint")?.innerText ?? "";
      const nums = [...text.matchAll(/\$([\d.,]+)([kM]?)/g)]
        .map((m) => Number(m[1].replace(/,/g, "")) * (m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1));
      return nums.length === 2 ? nums[1] - nums[0] : 0;
    });
    const headline = () => fc.locator(".nw-total").first().innerText();
    const retireBox = fc.locator(".fc-grid .field").nth(1).locator("input");
    const spreadBox = fc.locator(".fc-grid .field").nth(4).locator("input");

    const wasHeadline = await headline();
    const wasMark = await markerX();
    const wasBand = await bandSpread();

    if (await tryStep("the retire-at box takes an edit", async () => {
      await retireBox.fill("55", { timeout: 5000 });
      await retireBox.blur();
      await fc.waitForTimeout(700);
    })) {
      check("retiring ten years earlier changes the answer",
        (await headline()) !== wasHeadline, `${wasHeadline} -> ${await headline()}`);
      check("and the marker moves rather than only being relabelled",
        wasMark !== null && (await markerX()) < wasMark - 20, `${wasMark} -> ${await markerX()}`);
      check("and the edit is saved to the scenario",
        (await storedPlan())?.scenarios?.[0]?.assumptions?.retireAge === 55);
      await retireBox.fill("65");
      await retireBox.blur();
      await fc.waitForTimeout(500);
    }

    if (await tryStep("the give-or-take box takes an edit", async () => {
      await spreadBox.fill("4", { timeout: 5000 });
      await spreadBox.blur();
      await fc.waitForTimeout(700);
    })) {
      check("a wider give-or-take is a wider range of outcomes",
        (await bandSpread()) > wasBand * 1.3, `${wasBand} -> ${await bandSpread()}`);
      await spreadBox.fill("2");
      await spreadBox.blur();
      await fc.waitForTimeout(500);
    }

    // ── the readout says what the band is worth ──
    //
    // The line under the finger is only ever the middle of three, and a
    // forecast whose whole point is that it is a range should not make you
    // read the edges off the shading by eye.
    const chartBox = await fc.locator(".nw-card .chart-wrap svg").boundingBox();
    const readAt = async (frac) => {
      await fc.mouse.move(chartBox.x + chartBox.width * frac, chartBox.y + chartBox.height * 0.5);
      await fc.waitForTimeout(320);
      const t = await fc.evaluate(() => document.querySelector(".chart-tip")?.innerText ?? "");
      const n = (re) => Number((re.exec(t) ?? [])[1]?.replace(/,/g, "") ?? 0);
      return { text: t, mid: n(/^\D*\$([\d,]+)/m), high: n(/High\s*\$([\d,]+)/), low: n(/Low\s*\$([\d,]+)/) };
    };

    const early = await readAt(0.2);
    const late = await readAt(0.85);
    check("the readout names both edges of the band",
      /High/.test(early.text) && /Low/.test(early.text), early.text.replace(/\n/g, " | "));
    check("and they sit either side of the line, rather than being one figure twice",
      early.low < early.mid && early.mid < early.high,
      `${early.low} < ${early.mid} < ${early.high}`);
    check("the range widens the further out it is read, because that is the point",
      (late.high - late.low) > (early.high - early.low) * 2,
      `${early.high - early.low} early against ${late.high - late.low} late`);

    // A finger has to be able to read it too. Every chart here draws its own
    // tooltip, and touch used to be wired only for the ones that hand their
    // readout to a caller, so on a phone this one did nothing at all.
    const svgSel = ".nw-card .chart-wrap svg";
    const touch = async (type, frac) => fc.locator(svgSel).dispatchEvent(type, {
      pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true,
      clientX: chartBox.x + chartBox.width * frac, clientY: chartBox.y + chartBox.height * 0.5,
    });
    await fc.mouse.move(0, 0);
    await fc.waitForTimeout(200);
    await touch("pointerdown", 0.35);
    await fc.waitForTimeout(300);
    const held = await fc.evaluate(() => document.querySelector(".chart-tip")?.innerText ?? "");
    await touch("pointermove", 0.75);
    await fc.waitForTimeout(300);
    const moved = await fc.evaluate(() => document.querySelector(".chart-tip")?.innerText ?? "");
    await touch("pointerup", 0.75);
    await fc.waitForTimeout(300);
    const lifted = await fc.evaluate(() => document.querySelectorAll(".chart-tip").length);
    check("a held finger reads the chart, band and all",
      /High/.test(held) && /Low/.test(held), held.replace(/\n/g, " | ") || "nothing under the finger");
    check("and dragging it along moves the reading",
      held !== moved && moved.length > 0, `${held.slice(0, 24)} then ${moved.slice(0, 24)}`);
    check("and lifting it puts the chart back",
      lifted === 0, `${lifted} left behind`);
    check("while the page still scrolls under a vertical drag",
      (await fc.locator(svgSel).evaluate((el) => getComputedStyle(el).touchAction)) === "pan-y",
      await fc.locator(svgSel).evaluate((el) => getComputedStyle(el).touchAction));

    // ── social security ──
    //
    // The largest single line in most retirements, and the forecast did not
    // have it: the walk stopped the pay at the retirement age and put nothing
    // back. The figure has to be typed in, so nothing in the demo carries one
    // and every way of getting this wrong looks the same until one is entered.
    /** What the first tile says is left at the end of the plan. */
    const leftAtEnd = async () => money(await fc.evaluate(
      () => document.querySelector(".grid.g3 .card .small.muted")?.innerText ?? ""));
    const beforeSS = await leftAtEnd();
    if (await tryStep("a benefit can be entered", async () => {
      await fc.locator(".ss-card input").first().fill("3000", { timeout: 8000 });
      await fc.keyboard.press("Tab");
      await fc.waitForTimeout(900);
    })) {
      check("entering a benefit leaves the household better off at the end",
        (await leftAtEnd()) > beforeSS, `${beforeSS} -> ${await leftAtEnd()}`);

      // The published factors, read off the page rather than off the module:
      // 70% at 62 and 124% at 70 on a full retirement age of 67.
      const compare = await fc.evaluate(() =>
        [...document.querySelectorAll(".ss-claim")].map((b) => b.innerText.replace(/\n/g, " ")));
      check("and the three claiming ages are compared on the page",
        compare.length === 3, compare.join(" / "));
      check("at the published factors, not an approximation of them",
        /At 62 \$2,100 70%/.test(compare[0]) && /At 67 \$3,000 full/.test(compare[1])
        && /At 70 \$3,720 124%/.test(compare[2]), compare.join(" / "));

      check("and the month it starts is marked on the chart",
        (await fc.locator("svg text").allTextContents()).some((t) => /Social Security at 67/.test(t)));

      // Claiming early is more money sooner and less money in total, which is
      // the entire trade-off and the reason this is a dial rather than a
      // fixed monthly figure.
      const atRetirement = () => fc.evaluate(() => document.querySelector(".nw-total")?.innerText ?? "");
      const late = { end: await leftAtEnd(), at65: money(await atRetirement()) };
      if (await tryStep("a different claiming age can be chosen", async () => {
        await fc.locator(".ss-claim").first().click({ timeout: 8000 });
        await fc.waitForTimeout(900);
      })) {
        const early = { end: await leftAtEnd(), at65: money(await atRetirement()) };
        check("claiming at 62 is more in hand by 65",
          early.at65 > late.at65, `${late.at65} at 67 against ${early.at65} at 62`);
        check("and less by the end, which is the trade being made",
          early.end < late.end, `${late.end} at 67 against ${early.end} at 62`);
        await fc.locator(".ss-claim").nth(1).click();
        await fc.waitForTimeout(700);
      }

      // A spouse takes their own record or half of yours, never both.
      if (await tryStep("a spouse can be added", async () => {
        await fc.locator(".ss-card .switch").click({ timeout: 8000 });
        await fc.waitForTimeout(500);
        await fc.locator(".ss-card .fc-grid").last().locator("input").first().fill("900");
        await fc.keyboard.press("Tab");
        await fc.waitForTimeout(900);
      })) {
        const note = await fc.evaluate(() =>
          document.querySelector(".ss-card .fc-foot")?.innerText ?? "");
        check("and a small record of their own is beaten by half of yours",
          /half of your record/.test(note) && /\$1,500/.test(note), note.slice(0, 110) || "no note");
        check("which is not the two added together",
          (await leftAtEnd()) < beforeSS * 10, `${await leftAtEnd()}`);
      }
    }

    // The earliest retirement age is bisected over the same walk. Lengthening
    // the horizon means more years to pay for, so the answer has to move.
    const throughBox = fc.locator(".fc-grid .field").nth(2).locator("input");
    const earliestNow = await fc.locator(".tile-value").nth(1).innerText();
    if (await tryStep("the plan-through box takes an edit", async () => {
      await throughBox.fill("120", { timeout: 5000 });
      await throughBox.blur();
      await fc.waitForTimeout(900);
    })) {
      const later = await fc.locator(".tile-value").nth(1).innerText();
      check("a longer horizon pushes the earliest retirement later",
        Number(later) > Number(earliestNow), `${earliestNow} -> ${later}`);
      await throughBox.fill("95");
      await throughBox.blur();
      await fc.waitForTimeout(600);
    }

    await fc.setViewportSize({ width: 390, height: 900 });
    await fc.waitForTimeout(500);
    const phone = await fc.evaluate(() => {
      const tiles = [...document.querySelectorAll(".page > .grid.g3 > .card")]
        .map((c) => c.getBoundingClientRect());
      const fields = [...document.querySelectorAll(".fc-grid .field")]
        .map((el) => el.getBoundingClientRect());
      const page = document.querySelector(".page").getBoundingClientRect();
      return {
        tileRows: new Set(tiles.map((b) => Math.round(b.top))).size,
        perRow: new Set(fields.filter((b) => Math.round(b.top) === Math.round(fields[0].top)).map((b) => b.left)).size,
        widest: Math.round(Math.max(...[...document.querySelectorAll(".page *")]
          .map((el) => el.getBoundingClientRect().right))),
        edge: Math.round(page.right),
      };
    });
    check("one tile per row on a phone",
      phone.tileRows === 3, `${phone.tileRows} rows`);
    check("and two dials across rather than one",
      phone.perRow === 2, `${phone.perRow} per row`);
    check("with nothing hanging off the right edge",
      phone.widest <= phone.edge + 1, `${phone.widest} against ${phone.edge}`);
    await fc.close();

    const rail = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await rail.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await rail.waitForTimeout(500);
    const order = await rail.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href]")].map((a) => a.getAttribute("href")));
    // Debt before Forecast, with Cards between them: what the cards cost, then
    // what they pay, then the long view. It used to be adjacency, which was
    // incidental - the ordering is the part that was ever meant.
    check("Forecast sits after Debt in the Plan group",
      order.indexOf("/forecast") > order.indexOf("/payoff"), order.join(" "));
    check("and Cards sits with Debt, being about the same plastic",
      order.indexOf("/cards") === order.indexOf("/payoff") + 1, order.join(" "));
    await rail.close();
  }

  if (want("estate")) {
    // ── the two halves, and the one that has to leave the app ──
    const est = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await est.goto(`${BASE}/estate`, { waitUntil: "networkidle" });
    await est.waitForTimeout(1200);

    const money = (t) => Number((/-?\$([\d,]+)/.exec(t ?? "")?.[1] ?? "").replace(/,/g, ""));
    const shape = await est.evaluate(() => ({
      headline: document.querySelector(".nw-total")?.innerText.trim() ?? "",
      sub: document.querySelector(".fc-head .small.faint")?.innerText.trim() ?? "",
      foot: document.querySelector(".est-foot")?.innerText.trim() ?? "",
      sections: [...document.querySelectorAll(".est-print .card-head h3, .est-print .card-head h2")]
        .map((h) => h.innerText.trim()),
      charging: [...document.querySelectorAll(".est-section")]
        .find((c) => /keep charging/.test(c.innerText))?.querySelectorAll(".est-line").length ?? 0,
      dials: document.querySelectorAll(".fc-grid .field").length,
    }));
    check("the estate screen leads with what happens to the people left",
      /short|all right|any policy/.test(shape.headline), shape.headline);
    check("and says how much cover it would take against how much there is",
      /life cover/.test(shape.sub) || /already carries/.test(shape.sub), shape.sub);
    check("with the four things that would change, and nothing hidden behind a menu",
      shape.dials === 4, `${shape.dials} fields`);

    // Each of these has to be here, and "Insurance" exactly once: it used to
    // appear twice, because the derived summary and the card that edits it
    // both drew it.
    const want_ = ["Accounts and savings", "Property and vehicles", "What is owed", "Insurance",
      "Things that will keep charging", "Who to call", "Where the papers are", "In your own words"];
    check("the summary carries every section, in order and once each",
      shape.sections.join(" | ") === want_.join(" | "), shape.sections.join(" | "));

    // The section only this app could have written. Recurring bills are worked
    // out from the transactions rather than stored, so reading the raw list
    // left it empty for almost every document.
    check("and the bills that will keep charging are actually in it",
      shape.charging >= 5, `${shape.charging} rows`);

    // The chart is what they could spend, not what they are worth. Against net
    // worth this line climbed for forty years after the money had gone,
    // because the house kept pace with inflation.
    const chart = await est.evaluate(() => {
      const d = document.querySelector(".nw-card .chart-wrap path[stroke-width='2']")?.getAttribute("d") ?? "";
      const pts = [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      return { first: pts[0], last: pts[pts.length - 1], n: pts.length };
    });
    const ranOut = /runs out at/.test(shape.foot);
    check("the line is money they could spend, so running out is a line on the floor",
      !ranOut || (chart.n > 10 && chart.last[1] >= chart.first[1]),
      `${shape.foot.slice(0, 60)} — from y=${chart.first?.[1]} to y=${chart.last?.[1]}`);
    check("and the month it happens is named on the chart",
      !ranOut || (await est.evaluate(() =>
        [...document.querySelectorAll("svg text")].some((t) => /Nothing left at \d+/.test(t.textContent ?? "")))),
      shape.foot.slice(0, 60));

    // A chart with no band must not grow a band readout: the survivor walk is
    // a single line, and two identical figures labelled High and Low would be
    // a confident lie.
    //
    // Inside tryStep because the way this breaks is by throwing during render:
    // reading band!.low on a chart that has no band white-screens the page,
    // and a bare locator waiting on a screen that will never paint takes the
    // whole run down one line before it prints what passed.
    let estTip = "";
    if (await tryStep("the survivor chart can be read", async () => {
      const estBox = await est.locator(".nw-card .chart-wrap svg").boundingBox({ timeout: 8000 });
      await est.mouse.move(estBox.x + estBox.width * 0.3, estBox.y + estBox.height * 0.5);
      await est.waitForTimeout(320);
      estTip = await est.evaluate(() => document.querySelector(".chart-tip")?.innerText ?? "");
      await est.mouse.move(0, 0);
    })) {
      check("a chart without a band says nothing about one",
        estTip.length > 0 && !/High/.test(estTip) && !/Low/.test(estTip),
        estTip.replace(/\n/g, " | ") || "no readout at all");
    }

    // ── on paper ──
    //
    // The summary is the one thing this app makes that is meant to leave it.
    // It goes in a safe or to an attorney, and on that day a dark screenshot
    // with a nav rail down the side is not what anybody needs.
    await est.emulateMedia({ media: "print" });
    await est.waitForTimeout(400);
    const paper = await est.evaluate(() => {
      const shown = (sel) => Boolean(document.querySelector(sel)?.getClientRects().length);
      // Every read goes through this, missing element and all: getComputedStyle
      // throws on null, and a page that failed to render has nothing to
      // measure - which is a result to report, not a reason to end the run.
      const style = (sel, prop) => {
        const el = typeof sel === "string" ? document.querySelector(sel) : sel;
        return el ? getComputedStyle(el)[prop] : "";
      };
      const ink = (sel) => style(sel, "color");
      return {
        sidebar: shown(".sidebar"),
        topbar: shown(".topbar"),
        forecast: shown(".est-screen > .nw-card"),
        owners: shown(".est-owners"),
        summary: shown(".est-print"),
        buttons: [...document.querySelectorAll(".est-section .btn")].filter((b) => b.getClientRects().length).length,
        body: style(document.body, "backgroundColor"),
        faint: ink(".est-section .tiny.faint"),
        bold: ink(".est-line .bold"),
        page: style(".est-print", "backgroundColor"),
      };
    });
    check("printing drops the app and keeps the document",
      !paper.sidebar && !paper.topbar && paper.summary, JSON.stringify(paper).slice(0, 90));
    check("along with everything that was for deciding rather than keeping",
      !paper.forecast && !paper.owners && paper.buttons === 0, `${paper.buttons} buttons left`);
    // Measured rather than looked at: the same faint grey that reads correctly
    // on screen is most of a cartridge and barely legible on paper, and a
    // downscaled screenshot will not tell you which one you have.
    // A chart with no band must not grow a band readout: the survivor walk is
    // a single line, and two identical figures labelled High and Low would be
    // a confident lie.

    check("and it comes out as ink on paper, whatever theme is on screen",
      paper.faint === "rgb(0, 0, 0)" && paper.bold === "rgb(0, 0, 0)"
      && paper.page === "rgb(255, 255, 255)" && paper.body === "rgb(255, 255, 255)",
      `${paper.faint} and ${paper.bold} on ${paper.page}, body ${paper.body}`);
    await est.emulateMedia({ media: "screen" });
    await est.waitForTimeout(300);

    // ── the cover in force is the policies, not a zero ──
    //
    // Nothing in the demo carries a policy, so every way of getting the cover
    // wrong looks identical until one is actually entered. Adding it here is
    // the whole point of this block: the shortfall has to fall by exactly what
    // was added, which no amount of reading the figure off the requirement
    // instead of off the gap can fake.
    // Through the DOM rather than a locator: on a page that fails to render
    // there is nothing to wait for, and waiting anyway kills the run before it
    // prints a single result.
    const shortfall = async () => money(
      await est.evaluate(() => document.querySelector(".nw-total")?.innerText ?? ""));
    /** The age the line reaches the floor, which is a different reading of the
     *  same cover: the headline is arithmetic on a solved figure, this is the
     *  walk the chart is actually drawn from. */
    const runsOutAt = async () => Number((/runs out at (\d+)/.exec(
      await est.evaluate(() => document.querySelector(".est-foot")?.innerText ?? "")) ?? [])[1] ?? 0);
    const beforeCover = await shortfall();
    const beforeRunOut = await runsOutAt();
    const added = await tryStep("a policy can be added", async () => {
      await est.locator(".est-section", { hasText: "Insurance" })
        .getByRole("button", { name: "Add one" }).click({ timeout: 5000 });
      await est.waitForTimeout(300);
      await est.locator(".modal input[type=text]").first().fill("Northwestern");
      await est.locator(".modal input.num").fill("1000000");
      await est.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
      await est.waitForTimeout(900);
    });
    if (added) {
      const afterLife = await shortfall();
      check("a million of life cover takes a million off the shortfall",
        Math.abs((beforeCover - afterLife) - 1_000_000) < 2, `${beforeCover} -> ${afterLife}`);
      check("and it carries them years further before the money goes",
        beforeRunOut > 0 && (await runsOutAt()) > beforeRunOut,
        `ran out at ${beforeRunOut}, now ${await runsOutAt()}`);
      check("and the policy is listed where a family would look for it",
        (await est.locator(".est-section", { hasText: "Insurance" })
          .locator(".est-line", { hasText: "Northwestern" }).count()) === 1);

      // Only a death benefit pays out on a death. A disability policy belongs
      // in the document and must not move this figure.
      if (await tryStep("a second policy can be added", async () => {
        await est.locator(".est-section", { hasText: "Insurance" })
          .getByRole("button", { name: "Add", exact: true }).first().click({ timeout: 5000 });
        await est.waitForTimeout(300);
        await est.locator(".modal select").first().selectOption("disability");
        await est.locator(".modal input[type=text]").first().fill("Guardian");
        await est.locator(".modal input.num").fill("500000");
        await est.locator(".modal").getByRole("button", { name: "Add", exact: true }).click();
        await est.waitForTimeout(900);
      })) {
        check("a disability policy is listed but does not pay out on a death",
          (await shortfall()) === afterLife
          && (await est.locator(".est-section", { hasText: "Insurance" })
            .locator(".est-line", { hasText: "Guardian" }).count()) === 1,
          `${afterLife} -> ${await shortfall()}`);
      }
    }

    // ── it is answered, not decorated ──
    const spendBox = est.locator(".fc-grid .field").nth(1).locator("input");
    // `headline()` rather than a locator, for the reason above: these run
    // outside tryStep and a page that will never paint must produce a failed
    // check, not a dead run.
    const headline = () => est.evaluate(() => document.querySelector(".nw-total")?.innerText ?? "");
    const before = await headline();
    if (await tryStep("the spending box takes an edit", async () => {
      await spendBox.fill("50", { timeout: 5000 });
      await spendBox.blur();
      await est.waitForTimeout(900);
    })) {
      const after = await headline();
      check("halving what they would spend changes what it would take",
        money(after) < money(before) || /all right/.test(after), `${before} -> ${after}`);
      await spendBox.fill("100");
      await spendBox.blur();
      await est.waitForTimeout(700);
    }

    const lostBox = est.locator(".fc-grid .field").nth(0).locator("input");
    if (await tryStep("the lost-pay box takes an edit", async () => {
      await lostBox.fill("0", { timeout: 5000 });
      await lostBox.blur();
      await est.waitForTimeout(900);
    })) {
      check("and losing no pay at all needs no cover",
        /all right/.test(await headline()), await headline());
    }
    await est.close();

    const rail = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await rail.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await rail.waitForTimeout(500);
    const order = await rail.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href]")].map((a) => a.getAttribute("href")));
    check("Estate sits after Forecast in the rail",
      order.indexOf("/estate") === order.indexOf("/forecast") + 1, order.join(" "));
    await rail.close();
  }

  if (want("books")) {
    // ── two sets of books ──
    //
    // Nothing in the demo keeps any, which is the point and also the trap:
    // every way of getting this wrong looks identical until an account is
    // actually marked, so this marks one and then checks that the figures
    // move by exactly what was moved.
    const bk = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await bk.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
    await bk.waitForTimeout(900);

    const money = (t) => Number((/-?\$([\d,]+)/.exec(t ?? "")?.[1] ?? "").replace(/,/g, ""));
    check("a household with one set of books is never asked which",
      (await bk.locator(".scope-select").count()) === 0,
      `${await bk.locator(".scope-select").count()} scope pickers in the bar`);

    /**
     * The spending tab's total, and the ring's own rows.
     *
     * Both, because they come from different functions over the same
     * transactions: the figure in the middle is `summarise` and the bands
     * around it are `breakdown`. Scoping one and not the other draws a ring
     * whose slices do not add up to the number inside it, and reading only
     * the total will not notice.
     */
    const spendView = async () => {
      await bk.locator(".page > .seg button", { hasText: "Spending" }).click({ timeout: 8000 }).catch(() => {});
      await bk.waitForTimeout(700);
      return bk.evaluate(() => ({
        total: Number(((/-?\$([\d,]+)/.exec(
          [...document.querySelectorAll(".donut-wrap .num.bold")].map((n) => n.innerText).join(" ")) ?? [])[1] ?? "0")
          .replace(/,/g, "")),
        // Two separate readings that both have to move. The ring's own key
        // comes from `breakdown`; the list of rows below it comes from a
        // second BreakdownCard that calls `breakdown` again with its own
        // arguments. Scoping one and not the other is invisible in the total.
        key: [...document.querySelectorAll(".donut-key")]
          .map((k) => k.innerText.replace(/\s+/g, " ").trim()).join(" || "),
        rows: [...document.querySelectorAll(".report-row")]
          .map((r) => r.innerText.replace(/\s+/g, " ").trim()).join(" | "),
      }));
    };
    const everything = await spendView();

    // Mark the card the demo puts most of its subscriptions on.
    const marked = await tryStep("an account can be told which books it keeps", async () => {
      await bk.goto(`${BASE}/accounts`, { waitUntil: "networkidle" });
      await bk.waitForTimeout(700);
      await bk.locator(".list-row.click", { hasText: "Sapphire Reserve" }).click({ timeout: 5000 });
      await bk.waitForTimeout(800);
      // In the edit dialog, with the rest of what the account *is*. It used to
      // be three levels down a menu called "Visibility and actions", where
      // nobody found it.
      await bk.getByTitle("More").click({ timeout: 5000 });
      await bk.waitForTimeout(300);
      await bk.getByRole("button", { name: /Edit account details/ }).click({ timeout: 5000 });
      await bk.waitForTimeout(600);
      await bk.locator(".modal .field", { hasText: "Which books" }).locator("select")
        .selectOption("business", { timeout: 5000 });
      await bk.waitForTimeout(300);
      await bk.locator(".modal").getByRole("button", { name: "Save" }).click();
      await bk.waitForTimeout(700);
    });

    if (marked) {
      await bk.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
      await bk.waitForTimeout(900);
      check("and then the reports offer to show one set at a time",
        (await bk.locator(".scope-select").count()) === 1);
      const scope = bk.locator(".scope-select select").first();
      const options = await bk.evaluate(() =>
        [...document.querySelectorAll(".scope-select option")].map((o) => o.textContent).join("/"));
      check("naming all four, everything first",
        options === "Everything/Personal/Business/Rental", options || "no options");

      const stillEverything = await spendView();
      check("marking an account does not change what everything adds up to",
        stillEverything.total === everything.total, `${everything.total} -> ${stillEverything.total}`);

      const pick = async (v) => {
        await scope.selectOption(v, { timeout: 8000 }).catch(() => {});
        await bk.waitForTimeout(800);
        return spendView();
      };
      const personal = await pick("personal");
      const business = await pick("business");

      check("the business books are not empty, or nothing was actually moved",
        business.total > 0, `${business.total}`);
      check("and the two sets add up to the one",
        Math.abs(personal.total + business.total - everything.total) <= 2,
        `${personal.total} + ${business.total} against ${everything.total}`);
      check("neither being the whole of it",
        personal.total > 0 && personal.total < everything.total && business.total < everything.total,
        `${personal.total} and ${business.total} of ${everything.total}`);
      // The bands too, not only the figure in the middle: scoping the total
      // and not the breakdown draws a ring that disagrees with itself.
      check("and the ring's own bands change with it, not just the figure inside",
        personal.key !== business.key && personal.key.length > 0,
        `${personal.key.slice(0, 70)} :: ${business.key.slice(0, 70)}`);
      check("as do the rows listed under it",
        personal.rows !== business.rows && personal.rows.length > 0,
        `${personal.rows.slice(0, 70)} :: ${business.rows.slice(0, 70)}`);

      // A budget is the household's plan. A business card's spending is real
      // money and belongs in the reports, but letting it into the grocery line
      // turns every category red.
      // Read through the DOM, not through a locator: if the figure is not
      // there that is a result, and a locator timing out here would abandon
      // the run one line before it prints what passed.
      const budgetSpent = async () => {
        await bk.goto(`${BASE}/budget`, { waitUntil: "networkidle" });
        await bk.waitForTimeout(900);
        // The actual line under the plan, not the plan: the plan is a number
        // somebody typed and cannot move when an account changes books.
        return money(await bk.evaluate(() =>
          [...document.querySelectorAll(".budget-stats > *")]
            .find((el) => /Planned expenses/i.test(el.innerText))
            ?.querySelector(".tiny")?.innerText ?? ""));
      };
      const afterBudget = await budgetSpent();
      check("and the household budget counts the household's spending only",
        afterBudget > 0, `${afterBudget}`);

      // Put it back, and the budget has to come back with it: this is the one
      // change here that alters a figure somebody was already looking at.
      if (await tryStep("the books can be set back", async () => {
        await bk.goto(`${BASE}/accounts`, { waitUntil: "networkidle" });
        await bk.waitForTimeout(700);
        await bk.locator(".list-row.click", { hasText: "Sapphire Reserve" }).click({ timeout: 8000 });
        await bk.waitForTimeout(800);
        await bk.getByTitle("More").click({ timeout: 8000 });
        await bk.waitForTimeout(300);
        await bk.getByRole("button", { name: /Edit account details/ }).click({ timeout: 8000 });
        await bk.waitForTimeout(600);
        await bk.locator(".modal .field", { hasText: "Which books" }).locator("select")
          .selectOption("personal", { timeout: 8000 });
        await bk.waitForTimeout(300);
        await bk.locator(".modal").getByRole("button", { name: "Save" }).click();
        await bk.waitForTimeout(700);
      })) {
        const restored = await budgetSpent();
        check("putting it back puts the budget back",
          restored > afterBudget, `${afterBudget} -> ${restored}`);
        await bk.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
        await bk.waitForTimeout(800);
        check("and the control goes away again with the last set of books",
          (await bk.locator(".scope-select").count()) === 0);
      }
    }
    await bk.close();
  }

  if (want("sorting")) {
    // ── a heading that sorts, three states ──
    //
    // Ascending, descending, then back to the order the table came in. The
    // third state is the one worth testing: two-state sorting is a trap,
    // because once a table has been sorted there is no way back to the order
    // it chose, and that order usually means something.
    const so = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await so.goto(`${BASE}/investments`, { waitUntil: "networkidle" });
    await so.waitForTimeout(1400);

    /**
     * One column, one array per card.
     *
     * Per card rather than across the page, because each group is its own
     * table: read as one run the values drop back at every boundary and
     * "sorted" becomes impossible to state.
     */
    const column = (n) => so.evaluate((i) => [...document.querySelectorAll(".tbl-holdings")]
      .map((t) => [...t.querySelectorAll("tbody tr")]
        .map((r) => Number((r.children[i]?.innerText ?? "").replace(/[^0-9.-]/g, "")) || 0)), n);
    const rising = (cards) => cards.every((v) => v.every((x, i) => i === 0 || x >= v[i - 1]));
    const falling = (cards) => cards.every((v) => v.every((x, i) => i === 0 || x <= v[i - 1]));
    const flat = (cards) => cards.map((v) => v.join(" ")).join(" | ");
    const ariaOf = () => so.evaluate(() =>
      [...document.querySelectorAll(".tbl-holdings")[0].querySelectorAll("th")]
        .map((t) => t.getAttribute("aria-sort")).filter(Boolean).join(","));
    const clickTh = (name) => so.locator(".tbl-holdings").first()
      .locator("th", { hasText: name }).first().click({ timeout: 8000 });

    const natural = await column(5);
    check("the holdings table has sortable headings",
      (await so.locator(".tbl-holdings th.th-sort").count()) >= 6,
      `${await so.locator(".tbl-holdings th.th-sort").count()} of them`);
    check("and nothing is sorted until it is asked for",
      /^(none,)*none$/.test(await ariaOf()), await ariaOf());

    if (await tryStep("a heading can be clicked", async () => { await clickTh("Value"); await so.waitForTimeout(400); })) {
      const asc = await column(5);
      check("one click sorts low to high, in every card",
        asc.length > 1 && rising(asc) && !falling(asc), flat(asc));
      check("and says so, for a screen reader as well as an arrow",
        /ascending/.test(await ariaOf()), await ariaOf());

      await clickTh("Value");
      await so.waitForTimeout(400);
      const desc = await column(5);
      check("a second click turns it round",
        falling(desc) && !rising(desc), flat(desc));
      check("and says that too", /descending/.test(await ariaOf()), await ariaOf());

      await clickTh("Value");
      await so.waitForTimeout(400);
      check("a third click gives back the order it came in",
        flat(await column(5)) === flat(natural),
        `${flat(await column(5))} against ${flat(natural)}`);
      check("with nothing left marked",
        /^(none,)*none$/.test(await ariaOf()), await ariaOf());
    }

    // Moving to another column starts it over. Reached from *descending*
    // deliberately: from ascending, a sort that wrongly carries the previous
    // direction across looks exactly like one that starts fresh.
    if (await tryStep("a second column can be sorted", async () => {
      await clickTh("Value");
      await so.waitForTimeout(250);
      await clickTh("Value");
      await so.waitForTimeout(250);
      await clickTh("Shares");
      await so.waitForTimeout(400);
    })) {
      check("moving to another column starts it ascending and clears the first",
        (await ariaOf()).split(",").filter((x) => x !== "none").join() === "ascending",
        await ariaOf());
      check("and the new column really is ascending, not the old direction carried over",
        rising(await column(2)), flat(await column(2)));
    }
    await so.close();

    // The same headings on the other table that has them.
    const ints = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await ints.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    await ints.waitForTimeout(1200);
    const names = () => ints.evaluate(() => [...document.querySelectorAll(".int-table tbody tr")]
      .map((r) => r.children[0]?.innerText.trim()));
    const order = await names();
    check("the integrations table sorts too",
      (await ints.locator(".int-table th.th-sort").count()) >= 6);
    if (await tryStep("its headings can be clicked", async () => {
      await ints.locator(".int-table th", { hasText: "Process" }).first().click({ timeout: 8000 });
      await ints.waitForTimeout(400);
    })) {
      const asc = await names();
      check("by name, alphabetically",
        asc.join() === [...order].sort((a, b) => a.localeCompare(b)).join(), asc.join(" / "));
      await ints.locator(".int-table th", { hasText: "Process" }).first().click();
      await ints.waitForTimeout(300);
      await ints.locator(".int-table th", { hasText: "Process" }).first().click();
      await ints.waitForTimeout(400);
      check("and back to the order the work runs in",
        (await names()).join() === order.join(), (await names()).join(" / "));
    }
    await ints.close();
  }


  if (want("payoff")) {
    // ── where the next spare dollar goes ──
    const po = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await po.goto(`${BASE}/payoff`, { waitUntil: "networkidle" });
    await po.waitForTimeout(1000);

    const money = (t) => Number((/\$([\d,]+)/.exec(t ?? "")?.[1] ?? "").replace(/,/g, ""));
    const read = () => po.evaluate(() => ({
      big: document.querySelector(".nw-total")?.innerText ?? "",
      sub: document.querySelector(".fc-head .small.faint")?.innerText ?? "",
      note: document.querySelector(".payoff-order .tiny")?.innerText ?? "",
      rows: [...document.querySelectorAll(".payoff-row")].map((r) => r.innerText.replace(/\n/g, " | ")),
      chart: document.querySelectorAll(".nw-card .chart-wrap svg").length,
    }));

    const base = await read();
    check("the list names the rule it is following",
      /Highest rate first\./.test(await po.evaluate(() =>
        [...document.querySelectorAll(".card-head")].map((h) => h.innerText).join(" "))));
    check("the debt page says how long it takes and what it costs",
      /\d+ months?/.test(base.big) && /interest/.test(base.sub), `${base.big} — ${base.sub}`);
    check("with every debt in the order it gets cleared",
      base.rows.length >= 3 && /1 \|/.test(base.rows[0]), base.rows.join(" // ").slice(0, 100));
    check("and a curve of what is still owed", base.chart === 1);

    // Paying more has to end it sooner and cost less. This is the entire
    // reason the page exists, so it is the thing worth asserting.
    const months = (t) => Number((/(\d+) month/.exec(t) ?? [])[1] ?? 0);
    if (await tryStep("an extra payment can be entered", async () => {
      await po.locator(".fc-grid input").first().fill("500", { timeout: 8000 });
      await po.keyboard.press("Tab");
      await po.waitForTimeout(900);
    })) {
      const more = await read();
      check("putting more at it ends it sooner",
        months(more.big) > 0 && months(more.big) < months(base.big),
        `${base.big} -> ${more.big}`);
      check("and costs less in interest",
        lastMoney(more.sub) > 0 && lastMoney(more.sub) < lastMoney(base.sub),
        `${lastMoney(base.sub)} -> ${lastMoney(more.sub)}`);
      check("and the monthly outlay is the minimums plus what was added",
        money(more.sub) === money(base.sub) + 500, `${money(base.sub)} -> ${money(more.sub)}`);
    }

    // Both orders are run and the difference between them is stated, rather
    // than one being recommended.
    const labels = await po.evaluate(() =>
      [...document.querySelectorAll(".payoff-order .seg-spread button")].map((b) => b.innerText.trim()));
    check("both orders are offered, neither preferred",
      labels.join(" / ") === "Highest rate first / Smallest balance first", labels.join(" / "));
    const before = await read();
    if (await tryStep("the other order can be chosen", async () => {
      await po.locator(".payoff-order button", { hasText: "Smallest balance" }).click({ timeout: 8000 });
      await po.waitForTimeout(800);
    })) {
      const snow = await read();
      check("and choosing it says what it costs, or that it costs nothing",
        /costs \$[\d,]+ more|cost the same/.test(snow.note), snow.note.slice(0, 110));
      // Read off the plan that was rendered, not off the switch: this is what
      // catches the wrong plan being drawn under the right label.
      const ruleNow = await po.evaluate(() =>
        [...document.querySelectorAll(".card-head")].map((h) => h.innerText).join(" "));
      check("and the list says it is following that rule",
        /Smallest balance first\./.test(ruleNow), ruleNow.slice(0, 120));
      // Against the other order, not against itself: both are the same money
      // a month, and the only things that differ are the order and the total.
      check("at the same monthly outlay as the other order",
        money(snow.sub) === money(before.sub), `${money(before.sub)} then ${money(snow.sub)}`);
      check("and never cheaper than paying the highest rate first",
        lastMoney(snow.sub) >= lastMoney(before.sub),
        `${lastMoney(before.sub)} then ${lastMoney(snow.sub)}`);
    }
    // The rate every figure on this page is worked out from has to be
    // correctable here. It lives on the forecast's assumptions and used to be
    // reachable only there, a page away from the screen that prints it.
    const rateOf = () => po.evaluate(() =>
      document.querySelector(".payoff-row .payoff-rate")?.innerText.trim() ?? "");
    const wasRate = await rateOf();
    check("a debt's rate is printed against it, and offers to be changed",
      /^\d+(\.\d+)?%$/.test(wasRate), wasRate || "no rate button");

    if (await tryStep("the rate opens an editor where it is read", async () => {
      await po.locator(".payoff-row .payoff-rate").first().click({ timeout: 8000 });
      await po.locator(".menu input").first().waitFor({ timeout: 5000 });
    })) {
      const fields = await po.evaluate(() =>
        [...document.querySelectorAll(".menu .field label")].map((l) => l.innerText));
      check("holding both halves of the term, not the rate alone",
        fields.includes("Interest rate") && fields.includes("Years left"), fields.join(", "));

      if (await tryStep("a corrected rate can be typed in", async () => {
        await po.locator(".menu .field:has(label:text-is('Interest rate')) input").fill("3.9", { timeout: 8000 });
        await po.keyboard.press("Tab");
        await po.waitForTimeout(700);
        await po.keyboard.press("Escape");
        await po.waitForTimeout(400);
      })) {
        check("which is what the page then says",
          (await rateOf()) === "3.9%", `${wasRate} -> ${await rateOf()}`);
        // Stored where the forecast reads it, or the two screens would
        // disagree about the same loan.
        const stored = await po.evaluate(() => {
          const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
          const sc = db.forecast?.scenarios.find((x) => x.id === db.forecast.activeId);
          return Object.values(sc?.assumptions?.debts ?? {}).map((t) => t.apr);
        });
        check("and is kept where the forecast reads it, not beside it",
          stored.includes(3.9), JSON.stringify(stored));
        check("and the years it was set with are still there",
          await po.evaluate(() => {
            const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
            const sc = db.forecast?.scenarios.find((x) => x.id === db.forecast.activeId);
            return Object.values(sc?.assumptions?.debts ?? {}).every((t) => t.termMonths > 0);
          }));
      }
    }
    // A card cleared every month is owed but is not a balance to pay down,
    // and leaving it in puts a 22% rate at the top of a plan it does not
    // belong in. Setting it aside must not lose it: net worth still counts it,
    // and the way back has to be visible from here.
    // Scoped to the card that holds the order: "Left out" draws payoff-rows of
    // its own, and the month on the right of each row is bold as well.
    const plan = () => po.evaluate(() => {
      const card = [...document.querySelectorAll(".card")]
        .find((c) => /In the order they go/.test(c.querySelector(".card-head")?.innerText ?? ""));
      return {
        rows: card ? [...card.querySelectorAll(".payoff-row .col.grow > .bold")].map((b) => b.innerText.trim()) : [],
        owed: document.querySelector(".fc-head .small.faint")?.innerText ?? "",
        back: [...document.querySelectorAll(".card-head")].some((h) => /Left out/.test(h.innerText)),
      };
    });
    const full = await plan();
    if (await tryStep("a debt can be left out from its own row", async () => {
      await po.locator(".payoff-row .payoff-rate").first().click({ timeout: 8000 });
      await po.locator(".menu button", { hasText: "Leave out of this plan" }).click({ timeout: 8000 });
      await po.waitForTimeout(800);
    })) {
      const rest = await plan();
      check("which takes it out of the order",
        rest.rows.length === full.rows.length - 1 && !rest.rows.includes(full.rows[0]),
        `${full.rows.join(", ")} -> ${rest.rows.join(", ")}`);
      check("and out of what the plan says is owed",
        rest.owed !== full.owed && /owed/.test(rest.owed), `${full.owed} | ${rest.owed}`);
      check("while still being listed, so it can be brought back", rest.back);
      // Set aside, not deleted: the balance is real and net worth counts it.
      check("and the account is untouched apart from the one flag",
        await po.evaluate((name) => {
          const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
          const a = db.accounts.find((x) => x.name === name);
          return !!a && a.excludeFromPayoff === true && a.balance < 0 && a.includeInNetWorth !== false;
        }, full.rows[0]), full.rows[0]);

      if (await tryStep("and it can be put back", async () => {
        await po.locator(".payoff-row button", { hasText: "Put it back" }).first().click({ timeout: 8000 });
        await po.waitForTimeout(800);
      })) {
        const again = await plan();
        check("which returns it to the order it was in",
          again.rows.join("|") === full.rows.join("|") && !again.back,
          `${again.rows.join(", ")} against ${full.rows.join(", ")}`);
      }
    }
    await po.close();

    const rail = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await rail.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await rail.waitForTimeout(500);
    const order = await rail.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href]")].map((a) => a.getAttribute("href")));
    check("Debt sits before Forecast in the rail",
      order.indexOf("/payoff") < order.indexOf("/forecast"), order.join(" "));
    await rail.close();
  }

  if (want("tax")) {
    // ── the year, arranged the way a return asks for it ──
    const tx = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await tx.goto(`${BASE}/tax`, { waitUntil: "networkidle" });
    await tx.waitForTimeout(1000);

    const readTax = () => tx.evaluate(() => ({
      heading: document.querySelector(".tax-print h2")?.innerText ?? "",
      big: document.querySelector(".tax-head .nw-total")?.innerText ?? "",
      sub: document.querySelector(".tax-head .small.faint")?.innerText ?? "",
      lines: [...document.querySelectorAll(".tax-print .est-section .est-line")]
        .map((r) => r.innerText.replace(/\n/g, " | ")),
      suggestions: [...document.querySelectorAll(".card")]
        .filter((c) => /These look like tax lines/.test(c.innerText))
        .flatMap((c) => [...c.querySelectorAll(".est-line")].map((r) => r.innerText.split("\n")[0])),
      editorInPrint: document.querySelectorAll(".tax-print select").length,
      selects: document.querySelectorAll(".card select").length,
    }));

    const t0 = await readTax();
    check("the tax page says what year it is summarising",
      /^\d{4} tax summary$/.test(t0.heading), t0.heading);
    check("and says plainly that it is not a return",
      /not a return/.test(await tx.evaluate(() => document.querySelector(".est-print-head .small")?.innerText ?? "")));
    check("a document with nothing tagged says so rather than showing an empty card",
      /Nothing is tagged|No category has been put on a tax line/.test(`${t0.sub} ${t0.lines.join(" ")}`
        + (await tx.evaluate(() => document.querySelector(".tax-print .est-section")?.innerText ?? ""))),
      t0.sub.slice(0, 80));
    check("the obvious categories are offered, and giving is one of them",
      t0.suggestions.some((s) => /Charity/.test(s)), t0.suggestions.join(" / ").slice(0, 120));
    check("a mortgage payment is never guessed as mortgage interest",
      !t0.suggestions.some((s) => /^Mortgage$/.test(s)), t0.suggestions.join(" / ").slice(0, 120));

    if (await tryStep("a suggestion can be accepted", async () => {
      await tx.locator(".card", { hasText: "These look like tax lines" })
        .locator(".est-line", { hasText: "Charity" }).getByText("Tag it").click({ timeout: 8000 });
      await tx.waitForTimeout(900);
    })) {
      const t1 = await readTax();
      check("tagging a category puts its year on the return",
        t1.lines.some((l) => /Charitable giving/.test(l) && /\$[\d,]+/.test(l)),
        t1.lines.join(" // ").slice(0, 140));
      check("and names the form it belongs on",
        t1.lines.some((l) => /Charitable giving/.test(l) && /Schedule A/.test(l)),
        t1.lines.find((l) => /Charitable/.test(l))?.slice(0, 120) ?? "");
      check("and the headline is no longer nothing",
        lastMoney(t1.big) > 0, t1.big);
      check("and it stops being offered as a guess",
        !t1.suggestions.some((s) => /^Charity$/.test(s)), t1.suggestions.join(" / ").slice(0, 120));
    }

    check("the editor is not part of what prints",
      (await readTax()).editorInPrint === 0);
    check("but the editor is on the page",
      (await readTax()).selects > 5);

    await tx.close();

    const rail = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await rail.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await rail.waitForTimeout(500);
    const order = await rail.evaluate(() =>
      [...document.querySelectorAll(".sidebar a[href]")].map((a) => a.getAttribute("href")));
    check("Tax sits after Estate in the rail",
      order.indexOf("/tax") === order.indexOf("/estate") + 1, order.join(" "));
    await rail.close();
  }


  if (want("price")) {
    // ── subscriptions that quietly went up ──
    const pw = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await pw.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await pw.waitForTimeout(1000);

    const watch = await pw.evaluate(() => {
      const card = [...document.querySelectorAll(".card")].find((c) => c.querySelector(".price-row"));
      if (!card) return null;
      return {
        head: card.querySelector(".card-head")?.innerText.replace(/\n/g, " | ") ?? "",
        rows: [...card.querySelectorAll(".price-row")].map((r) => ({
          text: r.innerText.replace(/\n/g, " | "),
          up: !!r.querySelector(".price-arrow.neg"),
        })),
      };
    });

    check("the recurring page says what has changed price", watch !== null);
    if (watch) {
      check("each row says what it was, what it is, and when it moved",
        watch.rows.every((r) => (r.text.match(/\$[\d,.]+/g) ?? []).length >= 3 && /from \w+ \d+, \d{4}/.test(r.text)),
        watch.rows[0]?.text.slice(0, 110) ?? "");
      check("and what the change costs over a year",
        watch.rows.every((r) => /(costs|saves) \$[\d,]+ a year/.test(r.text)),
        watch.rows[0]?.text.slice(0, 110) ?? "");
      // A price is a price. Showing it as a negative amount because the
      // transaction was an outflow reads as a refund.
      check("prices are quoted as prices, not as outflows",
        watch.rows.every((r) => !/-\$/.test(r.text)),
        watch.rows.find((r) => /-\$/.test(r.text))?.text.slice(0, 110) ?? "");
      check("a rise and a cut are told apart at a glance",
        watch.rows.some((r) => r.up) && watch.rows.some((r) => !r.up),
        watch.rows.map((r) => (r.up ? "up" : "down")).join(" "));
      // The dearest rise is the one worth acting on, so it is the one at the top.
      const yearly = watch.rows.map((r) => {
        const n = Number((/(costs|saves) \$([\d,]+) a year/.exec(r.text)?.[2] ?? "0").replace(/,/g, ""));
        return r.up ? n : -n;
      });
      check("the dearest rise is first and the cuts are last",
        yearly.every((n, i) => i === 0 || yearly[i - 1] >= n), yearly.join(" "));
      check("and the card says what the year comes to either way",
        /(more|less) a year/.test(watch.head), watch.head.slice(0, 120));
      // The season swings it every month, so it never has a settled price to
      // have moved away from. This is the whole reason for the settled rule.
      check("a bill that swings with the season is not called a price rise",
        !watch.rows.some((r) => /PG&E|Water/.test(r.text)),
        watch.rows.map((r) => r.text.split(" | ")[0]).join(", "));
    }
    await pw.close();
  }


  if (want("year")) {
    // ── the year, told back to you ──
    const yr = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    await yr.goto(`${BASE}/year`, { waitUntil: "networkidle" });
    await yr.waitForTimeout(1200);

    const readYear = () => yr.evaluate(() => ({
      heading: document.querySelector(".yr-print h2")?.innerText ?? "",
      intro: document.querySelector(".est-print-head .small")?.innerText ?? "",
      big: document.querySelector(".nw-total")?.innerText ?? "",
      sub: document.querySelector(".fc-head .small.faint")?.innerText ?? "",
      tiles: [...document.querySelectorAll(".yr-tiles .card")].map((t) => t.innerText.replace(/\n/g, " | ")),
      bars: document.querySelectorAll(".chart-wrap svg g, .chart-wrap svg rect").length,
      monthNote: [...document.querySelectorAll(".card-head")]
        .map((h) => h.innerText).find((t) => /Month by month/.test(t)) ?? "",
      cats: [...document.querySelectorAll(".bar")].length,
      catRows: [...document.querySelectorAll(".card")]
        .filter((c) => /Where it went/.test(c.innerText))
        .flatMap((c) => [...c.querySelectorAll(".spread")].map((r) => r.innerText.replace(/\n/g, " "))),
      merchants: [...document.querySelectorAll(".card")]
        .filter((c) => /Who got it/.test(c.innerText))
        .flatMap((c) => [...c.querySelectorAll(".est-line")].map((r) => r.innerText.replace(/\n/g, " | "))),
    }));

    const y = await readYear();
    check("the year page says which year, and how much of it has run",
      /^(Your )?\d{4}( so far)?$/.test(y.heading) && /transactions/.test(y.intro),
      `${y.heading} — ${y.intro.slice(0, 90)}`);
    check("the headline is what was kept, against what came in and went out",
      lastMoney(y.big) !== 0 && /came in and .* went out/.test(y.sub), `${y.big} — ${y.sub.slice(0, 90)}`);
    check("four tiles: in, out, net worth and debt",
      y.tiles.length === 4 && /Money in/i.test(y.tiles[0]) && /Money out/i.test(y.tiles[1]),
      y.tiles.map((t) => t.split(" | ")[0]).join(", "));
    check("and each one is put beside the year before",
      y.tiles.slice(0, 2).every((t) => /than last year|the same as last year|nothing to compare/.test(t)),
      y.tiles[0].slice(0, 90));

    // The month still running is short, not thrifty. Naming it the leanest
    // month of the year is the mistake this page is most likely to make.
    const now = await yr.evaluate(() => new Date().toISOString().slice(0, 7));
    const running = new Date(`${now}-01T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric" });
    check("the month that is still running is not called the leanest",
      !new RegExp(`${running} kept the least`).test(y.monthNote), `${running} / ${y.monthNote.slice(0, 110)}`);
    check("but the best and the leanest finished months are named",
      /kept the most, \$/.test(y.monthNote) && /kept the least, -?\$/.test(y.monthNote),
      y.monthNote.slice(0, 120));

    check("the biggest categories are listed largest first, with their share",
      y.catRows.length >= 3 && /%/.test(y.catRows[0]), y.catRows[0]?.slice(0, 90) ?? "");
    const catMoney = y.catRows.map((r) => lastMoney(r));
    check("and each one is smaller than the one above it",
      catMoney.every((n, i) => i === 0 || catMoney[i - 1] >= n), catMoney.join(" "));

    const merchMoney = y.merchants.map((r) => lastMoney(r));
    check("who got the money, most first",
      merchMoney.length >= 3 && merchMoney.every((n, i) => i === 0 || merchMoney[i - 1] >= n),
      merchMoney.join(" "));
    check("and how many times each one was paid",
      y.merchants.every((r) => /\d+ times?/.test(r)), y.merchants[0]?.slice(0, 90) ?? "");

    // A different year is a different set of figures, not the same page with a
    // new number at the top.
    const options = await yr.evaluate(() =>
      [...document.querySelectorAll(".topbar select option")].map((o) => o.value));
    if (options.length > 1 && await tryStep("an earlier year can be chosen", async () => {
      await yr.locator(".topbar select").selectOption(options[1], { timeout: 8000 });
      await yr.waitForTimeout(900);
    })) {
      const prior = await readYear();
      check("choosing an earlier year redraws it",
        prior.heading !== y.heading && prior.big !== y.big,
        `${y.heading} ${y.big} -> ${prior.heading} ${prior.big}`);
      check("and a year that is over is not labelled as still running",
        !/so far/.test(prior.heading), prior.heading);
    }
    await yr.close();
  }


  if (want("drill-pick")) {
    // ── clicking a bar opens that bar ──
    //
    // The bug this exists for: the chart handed back the bar's label, and at a
    // monthly grain over two years two bars are called "Aug". The caller
    // matched on it and got the first, so clicking last August selected the
    // August before it and the panel filled with a month nobody had clicked.
    const dp = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

    const state = () => dp.evaluate(() => {
      const groups = [...document.querySelectorAll(".bar-group")];
      return {
        count: groups.length,
        title: document.querySelector(".period-title")?.innerText ?? "",
        // The selected bar is drawn in the full tone; every other one is
        // mixed down against the surface.
        litUp: groups.findIndex((g) => {
          const bar = g.querySelectorAll("rect")[1];
          return bar && !/color-mix/.test(bar.getAttribute("fill") ?? "");
        }),
        heights: groups.map((g) => Number(g.querySelectorAll("rect")[1]?.getAttribute("height") ?? 0)),
        // How many are drawn at full strength. One while a period is picked,
        // all of them once it is let go: a chart of dimmed bars over a list
        // showing everything would say the opposite of what is happening.
        lit: groups.filter((g) => {
          const bar = g.querySelectorAll("rect")[1];
          return bar && !/color-mix/.test(bar.getAttribute("fill") ?? "");
        }).length,
        clear: Boolean([...document.querySelectorAll("button")]
          .find((b) => /^Show all /.test(b.innerText.trim()))),
        empty: /Nothing in/.test(document.querySelector(".empty")?.innerText ?? ""),
        counted: document.querySelector(".card-head .tiny.faint")?.innerText ?? "",
      };
    });
    const clickBar = async (i) => {
      await dp.locator(".bar-group").nth(i).click({ timeout: 8000 });
      await dp.waitForTimeout(500);
      return state();
    };
    /**
     * Open this bar, whatever was open before.
     *
     * Clicking is a toggle now, so pressing the bar that happens to be picked
     * already lets it go instead. For the checks about which bar opens which
     * month, that is noise: they want the bar open.
     */
    const pick = async (i) => {
      const once = await clickBar(i);
      return once.lit === 1 ? once : clickBar(i);
    };

    await dp.goto(`${BASE}/categories/c_groceries?by=month`, { waitUntil: "networkidle" });
    await dp.waitForTimeout(1200);

    const start = await state();
    check("two years of months are drawn", start.count === 24, String(start.count));

    if (start.count === 24) {
      const last = await pick(23);
      const year = await dp.evaluate(() => new Date().getFullYear());
      const thisMonthName = await dp.evaluate(() =>
        new Date().toLocaleString("en-US", { month: "long", year: "numeric" }));
      check("clicking the newest bar opens the newest month",
        last.title === thisMonthName, `${last.title} should be ${thisMonthName}`);
      check("and that bar is the one lit up", last.litUp === 23, String(last.litUp));

      // The whole bug in one check: the bar a year earlier carries the same
      // label and must open a different month.
      const before = await pick(11);
      check("the bar with the same label a year earlier opens the earlier year",
        before.title.endsWith(String(year - 1)) && before.title !== last.title,
        `${last.title} then ${before.title}`);
      check("and it is that bar that lights up, not the one that shares its name",
        before.litUp === 11, String(before.litUp));

      // A bar with height has something behind it. An empty panel under a
      // full bar is what the user sees when the wrong month was picked.
      const tall = start.heights.indexOf(Math.max(...start.heights));
      const opened = await pick(tall);
      check("a bar with height opens a month with transactions in it",
        !opened.empty && /[1-9]/.test(opened.counted),
        `${opened.title}: ${opened.counted || "no count"}${opened.empty ? " (empty panel)" : ""}`);
      check("and the tall bar is the one lit up", opened.litUp === tall, `${opened.litUp} should be ${tall}`);

      // Every bar opens its own month: twenty-four clicks, twenty-four
      // different headings.
      const seen = [];
      for (const i of [0, 5, 11, 17, 23]) seen.push((await pick(i)).title);
      check("each bar opens a month of its own",
        new Set(seen).size === seen.length, seen.join(" / "));

      // ── and clicking it again lets it go ──
      //
      // Click to narrow, click again to stop narrowing. Pressing the bar that
      // is already picked used to pick it a second time, which does nothing
      // and reads as broken.
      const picked = await pick(23);
      check("a picked bar is the only one lit", picked.lit === 1, `${picked.lit} lit`);
      check("and it offers a second way out, for a bar too thin to press twice",
        picked.clear === true);

      const released = await clickBar(23);
      check("clicking the picked bar again shows the whole range",
        released.title !== picked.title && / to /.test(released.title), released.title);
      check("every bar is lit, because every bar is being shown",
        released.lit === 24, `${released.lit} of 24 lit`);
      check("and the list underneath holds more than the one month did",
        Number((released.counted.match(/\d[\d,]*/) ?? ["0"])[0].replace(/,/g, ""))
          > Number((picked.counted.match(/\d[\d,]*/) ?? ["0"])[0].replace(/,/g, "")),
        `${picked.counted} then ${released.counted}`);
      check("the way out goes away once there is nothing to get out of",
        released.clear === false);

      // And it is not a one-way door.
      const again = await pick(11);
      check("a bar can be picked again afterwards", again.lit === 1 && again.title !== released.title, again.title);

      // The choice survives a reload, because it lives in the URL rather than
      // in a variable that a refresh forgets.
      await dp.goto(`${BASE}/categories/c_groceries?by=month&at=all`, { waitUntil: "networkidle" });
      await dp.waitForTimeout(1000);
      const reloaded = await state();
      check("and it survives a reload", reloaded.lit === 24 && / to /.test(reloaded.title), reloaded.title);
    }

    // Quarterly is the other grain broken at the width the app draws: twelve
    // quarters is Q1 to Q4 three times over.
    await dp.goto(`${BASE}/categories/c_groceries?by=quarter`, { waitUntil: "networkidle" });
    await dp.waitForTimeout(1000);
    const q = await state();
    // However many the data reaches back for, up to the twelve it asks for.
    check("enough quarters are drawn for a label to repeat", q.count >= 5, String(q.count));
    if (q.count >= 5) {
      const last = q.count - 1;
      const yearBefore = q.count - 5;
      const newest = await pick(last);
      const oldest = await pick(yearBefore);
      check("the same quarter in a different year is a different quarter",
        newest.title !== oldest.title
        && newest.title.slice(0, 2) === oldest.title.slice(0, 2)
        && newest.litUp === last && oldest.litUp === yearBefore,
        `${newest.title} (lit ${newest.litUp}) then ${oldest.title} (lit ${oldest.litUp})`);
    }
    await dp.close();
  }


  if (want("smoke")) {
    // ── every page, twice: with two years of data and with none ──
    //
    // The cheap sweep that catches a whole class at once. A figure that came
    // out NaN, a label that came out "undefined", a divide by a total that was
    // zero, a screen that throws on an empty document: none of those need a
    // bespoke check, they just need somebody to look at every page.
    //
    // The empty pass matters more than the full one. Every division in this
    // app has a denominator that is zero on the day somebody installs it.
    const ROT = /\bNaN\b|\bInfinity\b|\[object Object\]|\bundefined\b|\$-0(?!\d)|Invalid Date/;

    const sweep = async (label, seedDoc) => {
      const pg = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const broke = [];
      pg.on("pageerror", (e) => broke.push(`threw: ${String(e.message).slice(0, 90)}`));
      pg.on("console", (m) => {
        if (m.type() === "error") broke.push(`console: ${m.text().slice(0, 90)}`);
      });
      if (seedDoc) {
        await pg.addInitScript((d) => {
          if (sessionStorage.getItem("bp-smoke")) return;
          localStorage.setItem("sovereign.db.v1", d);
          sessionStorage.setItem("bp-smoke", "1");
        }, seedDoc);
      }

      const rotten = [];
      const blank = [];
      let confirmed = null;
      for (const path of PAGES) {
        await pg.goto(BASE + path, { waitUntil: "networkidle" });
        await pg.waitForTimeout(350);
        const seen = await pg.evaluate(() => ({
          text: document.body.innerText,
          cards: document.querySelectorAll(".page .card, .page .empty").length,
        }));
        const hit = ROT.exec(seen.text);
        if (hit) {
          const at = Math.max(0, hit.index - 45);
          rotten.push(`${path}: …${seen.text.slice(at, hit.index + 45).replace(/\n/g, " ")}…`);
        }
        // A page that drew nothing at all is a page that threw on the way in.
        if (seen.cards === 0) blank.push(path);
        confirmed ??= await pg.evaluate(() => {
          const db = JSON.parse(localStorage.getItem("sovereign.db.v1") ?? "null");
          return db ? { accounts: db.accounts.length, txns: db.transactions.length } : null;
        });
      }

      // Otherwise the empty pass could quietly be a second run of the full one,
      // and would prove nothing at all.
      check(`${label} — is the document it says it is`,
        confirmed !== null && (seedDoc ? confirmed.txns === 0 : confirmed.txns > 100),
        JSON.stringify(confirmed));

      check(`${label} — no page shows a figure that is not a figure`,
        rotten.length === 0, rotten.slice(0, 3).join(" || "));
      check(`${label} — every page draws something`,
        blank.length === 0, blank.join(", "));
      check(`${label} — nothing throws on the way in`,
        broke.length === 0, [...new Set(broke)].slice(0, 3).join(" || "));
      await pg.close();
    };

    await sweep("with two years of data", null);

    // The same document with its contents taken out: no accounts, no
    // transactions, no goals, nothing to divide by.
    const reader = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await reader.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await reader.waitForTimeout(1200);
    const emptied = await reader.evaluate(() => {
      const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
      return JSON.stringify({
        ...db,
        accounts: [], transactions: [], holdings: [], goals: [],
        recurring: [], rules: [], tags: [], budgets: {},
        forecast: undefined, estate: undefined,
      });
    });
    await reader.close();
    await sweep("on a document with nothing in it", emptied);
  }


  if (want("draw")) {
    // ── a chart draws itself in, left to right ──
    const dr = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

    // How far across the wipe has got: the scaleX out of the clip rect's own
    // computed transform. 0 is nothing drawn, 1 is the whole series.
    const across = () => dr.evaluate(() => {
      const el = document.querySelector(".nw-card .chart-reveal");
      if (!el) return null;
      const t = getComputedStyle(el).transform;
      if (!t || t === "none") return 1;
      return Number(t.replace(/matrix\(([^,]+),.*/, "$1"));
    });
    const running = () => dr.evaluate(() =>
      document.getAnimations().filter((a) => a.animationName === "chart-reveal" && a.playState === "running").length);
    // Read off the stylesheet rather than written down here, so the checks
    // follow the animation instead of having to be edited alongside it.
    const duration = () => dr.evaluate(() => {
      const el = document.querySelector(".chart-reveal");
      const d = el ? getComputedStyle(el).animationDuration : "0s";
      return d.endsWith("ms") ? Number.parseFloat(d) : Number.parseFloat(d) * 1000;
    });
    const settle = async () => dr.waitForTimeout((await duration()) + 400);

    await dr.goto(`${BASE}/accounts`, { waitUntil: "domcontentloaded" });
    await dr.waitForTimeout(200);
    const first = await across();
    await dr.waitForTimeout(500);
    const second = await across();
    // Two readings rather than one magnitude: this says it is being drawn,
    // which a single number under a threshold does not.
    check("the chart is drawn in rather than simply appearing",
      first !== null && second !== null && first < second && second < 0.97,
      `${first} then ${second}`);
    // Long enough to watch, which is the point of asking for four seconds.
    const ms = await duration();
    check("and takes its time over it", ms >= 1000, `${ms}ms`);
    await settle();
    const settled = await across();
    check("and finishes drawn all the way across",
      settled !== null && Math.abs(settled - 1) < 0.001, String(settled));
    check("and stops animating once it is there", (await running()) === 0);

    // Changing the period runs it again. This is the half that does not come
    // free: the element has to be rebuilt, or the animation has already played
    // and will not play a second time.
    if (await tryStep("a different period can be chosen", async () => {
      await dr.locator(".span-pill", { hasText: "1Y" }).click({ timeout: 8000 });
    })) {
      await dr.waitForTimeout(160);
      const again = await across();
      check("changing the period draws it again",
        again !== null && again < 0.97, String(again));
      await settle();
      check("and that one finishes too", Math.abs((await across()) - 1) < 0.001);
    }

    // So does changing which accounts are being shown.
    if (await tryStep("a different slice can be chosen", async () => {
      await dr.locator(".scope-pill", { hasText: "Cash" }).first().click({ timeout: 8000 });
    })) {
      await dr.waitForTimeout(160);
      const sliced = await across();
      check("changing which accounts are drawn draws it again",
        sliced !== null && sliced < 0.97, String(sliced));
      await settle();
    }

    // And dragging a finger along it does not. A chart that redrew itself
    // every time it was read would be unusable.
    const box = await dr.locator(".nw-card .chart-wrap svg").first().boundingBox();
    if (box) {
      await dr.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
      await dr.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
      await dr.waitForTimeout(140);
      check("but reading the chart with a finger does not redraw it",
        (await running()) === 0 && Math.abs((await across()) - 1) < 0.001);
    }
    await dr.close();

    // Somebody who has asked for less movement gets the chart whole, at once.
    const still = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    await still.goto(`${BASE}/accounts`, { waitUntil: "domcontentloaded" });
    await still.waitForTimeout(200);
    const shown = await still.evaluate(() => {
      const el = document.querySelector(".nw-card .chart-reveal");
      if (!el) return null;
      const t = getComputedStyle(el).transform;
      return t === "none" ? 1 : Number(t.replace(/matrix\(([^,]+),.*/, "$1"));
    });
    check("reduced motion means no wipe at all, not a quicker one",
      shown !== null && Math.abs(shown - 1) < 0.001, String(shown));
    await still.close();

    // Every chart with an x-axis arrives the same way.
    const others = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
    for (const [path, what] of [
      ["/categories/c_groceries", "the drill-down's bars"],
      ["/reports", "the cash flow chart"],
      ["/year", "the year in review"],
    ]) {
      await others.goto(BASE + path, { waitUntil: "domcontentloaded" });
      await others.waitForTimeout(240);
      const n = await others.evaluate(() => document.querySelectorAll(".chart-reveal").length);
      check(`${what} draws itself in too`, n > 0, `${n} on ${path}`);
    }
    await others.close();
  }


  if (want("import-route")) {
    // ── a CSV that names its accounts goes to them ──
    //
    // The Account column was detected, mapped, read into every row, and then
    // dropped: a Monarch export covering ten accounts landed entirely in
    // whichever account was picked from the dropdown.
    // From the transactions page, which is where importing is reached now that
    // Settings no longer carries a box of its own.
    const im = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await im.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await im.waitForTimeout(1200);

    // Two of the demo's own accounts by name, plus one it has never heard of.
    const named = await im.evaluate(() => {
      const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
      const live = db.accounts.filter((a) => !a.hidden && !a.closedAt);
      return [live[0].name, live[1].name];
    });
    const csv = [
      "Date,Merchant,Account,Amount",
      `2026-09-01,Test Alpha,${named[0]},-12.34`,
      `2026-09-02,Test Beta,${named[1]},-56.78`,
      `2026-09-03,Test Gamma,${named[1]},-9.10`,
      "2026-09-04,Test Delta,A Bank That Is Not Here,-1.00",
    ].join("\n");

    if (await tryStep("the import dialog opens and takes a file", async () => {
      await im.locator('.topbar button[title="Import a CSV"]').click({ timeout: 8000 });
      await im.waitForTimeout(400);
      await im.locator('.modal input[type="file"]').setInputFiles({
        name: "monarch.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
      });
      await im.waitForTimeout(900);
    })) {
      const seen = await im.evaluate(() => {
        const modal = document.querySelector(".modal");
        const text = modal?.innerText ?? "";
        // The heading is uppercased by the stylesheet, and innerText reports
        // what is rendered, so this reads it back the way it is drawn.
        const from = text.search(/going to/i);
        return { text, going: from < 0 ? "" : text.slice(from) };
      });
      check("the column is recognised as the account name",
        /Account name/.test(seen.text), seen.text.slice(0, 160).replace(/\n/g, " | "));
      check("and the review says where the rows are going, by name",
        seen.going.includes(named[0]) && seen.going.includes(named[1]),
        seen.going.slice(0, 160).replace(/\n/g, " | "));
      // Really split, rather than every row under one heading. Four rows go
      // in; the unmatched one falls back to the chosen account, so it is two
      // and two, and neither account may hold all four.
      const counts = [...seen.going.matchAll(/(\d+) rows?/g)].map((m) => Number(m[1]));
      check("split the way the file says, not all into one",
        counts.length === 2 && counts.reduce((a, b) => a + b, 0) === 4 && !counts.includes(4),
        `${counts.join(" + ")} from: ${seen.going.slice(0, 120).replace(/\n/g, " | ")}`);
      check("and says plainly that one name matched nothing here",
        /matches no account|match no account/.test(seen.text)
        && /A Bank That Is Not Here/.test(seen.text),
        seen.text.slice(0, 200).replace(/\n/g, " | "));
    }
    await im.close();

    // ── and the same import, reached from an account ──
    //
    // The menu on an account offers it with that account already chosen, so a
    // statement downloaded from a bank goes in from the page you were on
    // rather than from Settings with a dropdown to find.
    const acct = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    await acct.goto(`${BASE}/accounts/a_sapphire`, { waitUntil: "networkidle" });
    await acct.waitForTimeout(900);
    const wanted = await acct.evaluate(() => document.querySelector("h1")?.innerText ?? "");
    check("the account page names the account it is on", wanted.length > 1, wanted);

    if (await tryStep("its menu offers importing transactions", async () => {
      await acct.locator('.topbar button[title="More"]').click({ timeout: 8000 });
      await acct.waitForTimeout(400);
      await acct.locator(".menu button", { hasText: "Import transactions" }).click({ timeout: 8000 });
      await acct.waitForTimeout(500);
    })) {
      const name = wanted.replace(/\s*\(…\d+\)$/, "").trim();
      // Before a file is chosen, because that is when it is reassuring.
      const upfront = await acct.evaluate(() => document.querySelector(".import-into")?.innerText ?? "");
      check("and says up front which account it is going into",
        upfront.includes(name), `"${upfront}" for ${name}`);

      // And the picker itself, which only exists once there is a file, agrees.
      await acct.locator('.modal input[type="file"]').setInputFiles({
        name: "plain.csv", mimeType: "text/csv",
        buffer: Buffer.from("Date,Merchant,Amount\n2026-09-01,From The Account Page,-3.21"),
      });
      await acct.waitForTimeout(900);
      const chosen = await acct.evaluate(() => {
        const sel = document.querySelector(".modal select");
        return sel ? (sel.options[sel.selectedIndex]?.text ?? "") : null;
      });
      check("and the picker is already on it, not on whichever account is first",
        chosen !== null && chosen.startsWith(name), `${chosen} for ${name}`);
      const going = await acct.evaluate(() => {
        const t = document.querySelector(".modal")?.innerText ?? "";
        const at = t.search(/going to/i);
        return at < 0 ? "" : t.slice(at, at + 120);
      });
      check("so a file that names no account lands there",
        going.includes(name), going.replace(/\n/g, " | "));
      await acct.locator(".modal button", { hasText: "Cancel" }).first().click().catch(() => {});
    }
    await acct.close();
  }


  if (want("duplicate")) {
    // ── a second one like this ──
    //
    // The importer's duplicate check is a good one and still occasionally
    // wrong: two rent payments of the same amount on the same day from two
    // tenants are one key and two real transactions. There has to be a way to
    // put back what it decided was a copy.
    const du = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await du.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await du.waitForTimeout(1200);

    const count = () => du.evaluate(() =>
      JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions.length);
    const openFirst = async () => {
      await du.locator(".list-row.tx-grid:not(.head) .tx-amount").first().click({ timeout: 8000 });
      await du.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
    };

    if (await tryStep("a transaction opens", openFirst)) {
      const foot = await du.evaluate(() =>
        [...document.querySelectorAll(".modal-foot button")].map((b) => b.innerText.trim()));
      check("its footer offers to duplicate it, beside delete",
        foot.join(" | ") === "Delete | Duplicate | Save changes", foot.join(" | "));

      const was = await count();
      // Every id before, so the copy can be found by being the one that is
      // new rather than by a merchant name fifty other rows also carry.
      const idsBefore = await du.evaluate(() =>
        JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions.map((t) => t.id));

      if (await tryStep("it can be duplicated", async () => {
        await du.locator(".modal-foot button", { hasText: "Duplicate" }).click({ timeout: 8000 });
        await du.waitForTimeout(900);
      })) {
        check("which makes one more transaction, not two and not none",
          (await count()) === was + 1, `${was} -> ${await count()}`);

        const made = await du.evaluate((before) => {
          const seen = new Set(before);
          const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
          const fresh = db.transactions.filter((t) => !seen.has(t.id));
          if (fresh.length !== 1) return { fresh: fresh.length };
          const copy = fresh[0];
          // Its twin: same account, day, amount and merchant, different row.
          const twin = db.transactions.find((t) =>
            t.id !== copy.id && t.accountId === copy.accountId && t.date === copy.date
            && t.amount === copy.amount && t.merchant === copy.merchant);
          return {
            fresh: 1,
            hasTwin: !!twin,
            sameCategory: twin ? twin.categoryId === copy.categoryId : false,
            sameTags: twin ? JSON.stringify(twin.tags) === JSON.stringify(copy.tags) : false,
            saysSo: (copy.activity ?? []).some((e) => /from another one/.test(e.source ?? "")),
            ownHistory: (copy.activity ?? []).length === 1,
          };
        }, idsBefore);
        check("exactly one new transaction came out of it",
          made.fresh === 1, JSON.stringify(made));
        check("the copy carries the same money, day, category and tags",
          made.hasTwin && made.sameCategory && made.sameTags, JSON.stringify(made));
        // Two transactions, not one drawn twice: a shared id would be a list
        // that looks right and a document that holds one row.
        check("and its history is its own, saying where it came from",
          made.saysSo && made.ownHistory, JSON.stringify(made));
        check("and it is undoable like every other write",
          await du.evaluate(() => /Undo/.test(document.querySelector(".toast")?.innerText ?? "")));

        // Undo really puts it back, or the safety net is decoration.
        if (await tryStep("the duplicate can be undone", async () => {
          await du.locator(".toast button", { hasText: "Undo" }).click({ timeout: 8000 });
          await du.waitForTimeout(700);
        })) {
          check("and undoing it leaves the document as it was",
            (await count()) === was, `${await count()} should be ${was}`);
        }
      }
    }

    // Nothing to duplicate when there is nothing there yet.
    await du.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await du.waitForTimeout(700);
    if (await tryStep("a new transaction can be started", async () => {
      await du.locator(".topbar button", { hasText: "Transaction" }).first().click({ timeout: 8000 });
      await du.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
    })) {
      const foot = await du.evaluate(() =>
        [...document.querySelectorAll(".modal-foot button")].map((b) => b.innerText.trim()));
      check("and a transaction that does not exist yet is not offered a copy",
        !foot.some((t) => /Duplicate/.test(t)), foot.join(" | "));
    }
    await du.close();
  }


  if (want("amounts")) {
    // ── finding a transaction by what it cost ──
    const am = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await am.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await am.waitForTimeout(1200);

    const count = () => am.evaluate(() => {
      const m = /([\d,]+) transaction/.exec(document.body.innerText);
      return m ? Number(m[1].replace(/,/g, "")) : null;
    });
    const amounts = () => am.evaluate(() =>
      [...document.querySelectorAll(".list-row.tx-grid:not(.head) .tx-amount")]
        .map((e) => Number(e.innerText.replace(/[^0-9.-]/g, "")) * 100)
        .filter((n) => Number.isFinite(n)));
    const search = async (text) => {
      await am.locator(".search input").fill(text);
      await am.waitForTimeout(650);
    };

    const all = await count();
    check("the page starts with everything", all !== null && all > 100, String(all));

    // One of the amounts actually on screen, so this does not depend on the
    // demo happening to contain a figure written down here.
    const [one] = await amounts();
    check("an amount could be read off a row", Number.isFinite(one) && one !== 0, String(one));

    if (Number.isFinite(one) && one !== 0) {
      const typed = (one / 100).toFixed(2);
      await search(typed);
      const found = await amounts();
      check("typing a figure into the search box finds it",
        found.length > 0 && found.every((n) => Math.abs(n) === Math.abs(one)),
        `${found.length} rows for ${typed}: ${found.slice(0, 4).join(", ")}`);
      check("and that is fewer than everything", (await count()) < all);

      // A sign that was typed is meant.
      const wrongWay = (one > 0 ? "-" : "") + Math.abs(one / 100).toFixed(2);
      await search(one > 0 ? wrongWay : `+${Math.abs(one / 100).toFixed(2)}`);
      const opposite = await amounts();
      check("a sign that was typed is meant, so the other direction is not shown",
        opposite.every((n) => Math.sign(n) !== Math.sign(one)),
        opposite.slice(0, 4).join(", "));

      // Typed one key at a time, the way a search box is actually filled in.
      // The list must narrow towards the figure and never fall off it: "31"
      // used to find a mortgage by its name, "313" matched neither the name
      // nor $313.00, and the list emptied three characters into a figure that
      // was really there.
      const shown = Math.abs(one / 100).toFixed(2);
      const steps = [];
      let dropped = null;
      for (let i = 1; i <= shown.length; i++) {
        const part = shown.slice(0, i);
        await search(part);
        const n = await count();
        const here = await amounts();
        steps.push(`${part}:${n}`);
        if (!here.some((v) => Math.abs(v) === Math.abs(one))) dropped ??= part;
      }
      check("typing a figure one key at a time never loses it",
        dropped === null, `lost it at "${dropped}" — ${steps.join(" ")}`);
      const counts = steps.map((x) => Number(x.split(":")[1]));
      check("and each key narrows the list rather than widening it",
        counts.every((n, i) => i === 0 || n <= counts[i - 1]), steps.join(" "));

      // Words still search words.
      await search("Starbucks");
      const byName = await count();
      check("and searching for a name still searches names", byName !== null && byName > 0, String(byName));
      await search("");
    }

    // ── the range filter ──
    if (await tryStep("the filter panel opens", async () => {
      await am.locator(".filter-toggle").click({ timeout: 8000 });
      await am.waitForTimeout(400);
    })) {
      const setBound = async (which, text) => {
        await am.locator(`.filter-panel input[placeholder="${which}"]`).fill(text);
        await am.waitForTimeout(700);
      };

      await setBound("At least", "-5000");
      await setBound("At most", "-1000");
      const between = await amounts();
      // The list itself is paged, so the totals come off the count and only
      // the bound is checked against the rows on screen. Comparing rendered
      // row counts proves nothing once a page is full.
      const betweenTotal = await count();
      check("a range shows only what falls inside it",
        between.length > 0 && between.every((n) => n >= -500000 && n <= -100000),
        between.slice(0, 5).join(", "));
      check("and it is narrower than no filter at all",
        betweenTotal !== null && betweenTotal < all, `${betweenTotal} of ${all}`);
      check("and the funnel counts it as one filter that is on",
        (await am.evaluate(() => document.querySelector(".filter-count")?.innerText)) === "1");
      check("and it is in the address bar, so the view is a link",
        /min=-500000/.test(am.url()) && /max=-100000/.test(am.url()), new URL(am.url()).search);

      // One end on its own is a half-open range.
      await setBound("At most", "");
      const overOnly = await amounts();
      const overTotal = await count();
      check("the lower bound on its own shows everything over it",
        overTotal !== null && overTotal > betweenTotal && overOnly.every((n) => n >= -500000),
        `${overTotal} over vs ${betweenTotal} between`);

      // A hundred rather than a thousand, because the demo holds nothing
      // below five thousand: an upper bound of -1000 would select exactly the
      // same rows as the range did, and prove nothing about the bound.
      await setBound("At least", "");
      await setBound("At most", "-100");
      const underOnly = await amounts();
      const underTotal = await count();
      check("and the upper bound on its own shows everything under it",
        underOnly.length > 0 && underOnly.every((n) => n <= -10000)
        && underTotal !== null && underTotal > betweenTotal && underTotal < all,
        `${underTotal} under, ${betweenTotal} between, ${all} in all`);

      // Clearing really clears, address bar included.
      if (await tryStep("the filters can be cleared", async () => {
        await am.locator(".filter-panel button", { hasText: "Clear all" }).click({ timeout: 8000 });
        await am.waitForTimeout(700);
      })) {
        check("clearing puts everything back", (await count()) === all, `${await count()} of ${all}`);
        check("and takes the range out of the address bar",
          !/min=|max=/.test(am.url()), new URL(am.url()).search);
      }
    }
    await am.close();
  }


  if (want("calendar")) {
    // ── a day with more than one bill on it ──
    //
    // The amounts used to live in a card that appeared on hover, positioned
    // inside the cell and below the first row - which put it squarely over the
    // second and third items on any day that had them. The things you were
    // reaching for were underneath the thing that appeared when you reached.
    const cal = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await cal.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await cal.waitForTimeout(1500);

    // The demo puts its bills on separate days, so a busy one is made here.
    const seed = await cal.evaluate(() => {
      const db = JSON.parse(localStorage.getItem("sovereign.db.v1"));
      const day = `${new Date().toISOString().slice(0, 7)}-19`;
      const bill = (id, merchant, amount) => ({
        id, merchant, categoryId: "c_insurance", accountId: db.accounts[0].id,
        amount, cadence: "monthly", nextDate: day, kind: "bill", detected: false,
      });
      db.recurring = [
        ...(db.recurring ?? []),
        bill("r_a", "Alpha Insurance", -184_50),
        bill("r_b", "Beta Broadband Services", -99_99),
        bill("r_c", "Gamma Gym", -210_00),
      ];
      return JSON.stringify(db);
    });
    await cal.close();

    const busy = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
    await busy.addInitScript((d) => {
      if (sessionStorage.getItem("bp-cal")) return;
      localStorage.setItem("sovereign.db.v1", d);
      sessionStorage.setItem("bp-cal", "1");
    }, seed);
    await busy.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await busy.waitForTimeout(1800);

    const where = await busy.evaluate(() => {
      const cells = [...document.querySelectorAll(".cal-cell")];
      let at = -1;
      let most = 0;
      cells.forEach((c, i) => {
        const n = c.querySelectorAll(".cal-name").length;
        if (n > most) { most = n; at = i; }
      });
      return { at, most };
    });
    check("a day can carry more than one bill", where.most > 1, `${where.most} on one day`);

    if (where.at >= 0 && where.most > 1) {
      const cell = busy.locator(".cal-cell").nth(where.at);

      // Every item says what it costs, in its own row.
      const rows = await busy.evaluate((i) =>
        [...document.querySelectorAll(".cal-cell")[i].querySelectorAll(".cal-name")].map((n) => ({
          name: (n.querySelector(".cal-name-text")?.textContent ?? "").trim(),
          amount: (n.querySelector(".cal-name-amount")?.textContent ?? "").trim(),
        })), where.at);
      check("each one shows its amount beside its name",
        rows.length > 1 && rows.every((r) => r.name.length > 1 && /^-?\$[\d,]+/.test(r.amount)),
        JSON.stringify(rows));

      // And nothing appears over them when the cell is pointed at.
      await cell.hover();
      await busy.waitForTimeout(400);
      check("and pointing at the day puts nothing on top of them",
        (await busy.evaluate(() => document.querySelectorAll(".chart-tip").length)) === 0);

      // Worth having, but not the regression test for this: .chart-tip is
      // pointer-events:none, so a click at these coordinates always got
      // through even when the card was drawn over the rows. What the card
      // took away was the ability to see and aim at them, which is what the
      // check above pins.
      const links = cell.locator("a.cal-name");
      const n = await links.count();
      const went = [];
      for (let i = 0; i < n; i++) {
        const label = (await links.nth(i).innerText()).split("\n")[0].trim();
        await links.nth(i).click({ timeout: 8000 });
        await busy.waitForTimeout(600);
        went.push({ label, at: decodeURIComponent(new URL(busy.url()).pathname) });
        await busy.goBack();
        await busy.waitForTimeout(700);
      }
      check("and every one of them opens its own merchant",
        n > 1 && went.every((g) => g.at === `/merchants/${g.label}`),
        went.map((g) => `${g.label} -> ${g.at}`).join(" | "));
    }
    await busy.close();
  }


  if (want("history")) {
    // ── a way back that is not a rewind ──
    //
    // The undo toast lasts six seconds and puts the whole document back. The
    // mistake this exists for is noticed an hour later, with an hour of real
    // work sitting on top of it, so what has to be proved here is that one
    // action can be taken back while the hour survives.
    const hi = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await hi.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await hi.waitForTimeout(1200);

    const txns = () => hi.evaluate(() =>
      JSON.parse(localStorage.getItem("sovereign.db.v1")).transactions);
    const merchantOf = async (id) => (await txns()).find((t) => t.id === id)?.merchant;

    /** Opens the nth row, renames the merchant, saves, and says which row it was. */
    const rename = async (nth, name) => {
      await hi.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(nth).click({ timeout: 8000 });
      await hi.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
      await hi.locator(".modal .drow-btn").first().click({ timeout: 8000 });
      await hi.locator('.modal input[aria-label="Merchant"]').fill(name, { timeout: 8000 });
      await hi.locator(".modal-foot button", { hasText: "Save changes" }).click({ timeout: 8000 });
      await hi.waitForTimeout(700);
      // Found by the name just typed rather than by position: the list resorts
      // on a rename, so the row that was nth is not necessarily nth after it.
      const hits = (await txns()).filter((t) => t.merchant === name);
      return hits.length === 1 ? hits[0].id : null;
    };

    /**
     * The rule offer must not land on the dialog's own buttons.
     *
     * A rename raises the "make this a rule?" offer, which is fixed to the
     * bottom of the window and sits above the dialog scrim. On a tall dialog
     * that is where the footer is, so opening another transaction inside the
     * offer's few seconds used to put it over the one button being reached
     * for. Measured between the two renames rather than after them, because
     * with the bug in place the second rename is what it breaks.
     */
    const offerClear = async () => {
      await hi.locator(".list-row.tx-grid:not(.head) .tx-amount").first().click({ timeout: 8000 });
      await hi.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
      const seen = await hi.evaluate(() => {
        const p = document.querySelector(".rule-prompt");
        const foot = document.querySelector(".modal-foot");
        if (!p || !foot) return { prompt: !!p, foot: !!foot, over: false };
        const a = p.getBoundingClientRect(), b = foot.getBoundingClientRect();
        return {
          prompt: true, shown: getComputedStyle(p).display !== "none",
          over: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
        };
      });
      check("the rule offer does not sit over an open dialog's own buttons",
        !seen.over, JSON.stringify(seen));
      // Escape rather than a Cancel button: the transaction footer does not
      // carry one, because four buttons did not fit on a phone.
      await hi.keyboard.press("Escape");
      await hi.waitForTimeout(400);
    };

    let first = null, second = null;
    const ok = await tryStep("two transactions can be renamed, one after the other", async () => {
      first = await rename(0, "First Edit Co");
      await offerClear();
      second = await rename(1, "Second Edit Co");
    });

    if (ok) {
      check("both renames landed", first && second && first !== second,
        `${first} / ${second}`);


      await hi.goto(`${BASE}/history`, { waitUntil: "networkidle" });
      await hi.waitForTimeout(800);

      const rows = () => hi.evaluate(() =>
        [...document.querySelectorAll(".hist-row")].map((r) => ({
          label: r.querySelector(".hist-label")?.innerText ?? "",
          sub: r.querySelector(".hist-head .tiny")?.innerText ?? "",
          done: !!r.querySelector(".hist-done"),
        })));

      const listed = await rows();
      check("both edits are listed, newest first",
        listed.length >= 2 && listed.slice(0, 2).every((r) => /Merchant changed on 1 transaction/.test(r.label)),
        JSON.stringify(listed.slice(0, 3)));
      const top = listed[0] ?? { label: "", sub: "" };
      check("and each one says what it did, not just that something happened",
        top.sub.includes("·") && /\d/.test(top.sub), top.sub || "nothing is listed");

      // Expanded, a row has to say what it did or there is no way to tell one
      // sweep from another before pressing the button that takes it back.
      if (await tryStep("an entry opens to show what it changed", async () => {
        await hi.locator(".hist-head").nth(1).click({ timeout: 8000 });
        await hi.locator(".hist-detail").first().waitFor({ timeout: 5000 });
      })) {
        const detail = await hi.evaluate(() =>
          document.querySelector(".hist-detail")?.innerText.replace(/\n/g, " | ") ?? "");
        check("naming the field, what it was, and what it became",
          /Merchant/.test(detail) && /First Edit Co/.test(detail) && /→/.test(detail), detail.slice(0, 140));
      }

      // The whole point: undo the older one, keep the newer one.
      if (await tryStep("the older edit can be put back", async () => {
        await hi.locator(".hist-row").nth(1).locator("button", { hasText: "Put it back" })
          .click({ timeout: 8000 });
        await hi.waitForTimeout(800);
      })) {
        check("which puts that transaction back the way it was",
          (await merchantOf(first)) !== "First Edit Co", await merchantOf(first));
        check("and leaves the edit made after it exactly where it was",
          (await merchantOf(second)) === "Second Edit Co", await merchantOf(second));
        const after = await rows();
        check("the entry then says it has been put back",
          after.some((r) => r.done), JSON.stringify(after.slice(0, 3)));
        check("and the undo is itself an entry, so it can be taken back too",
          after.some((r) => /Put back/.test(r.label)), JSON.stringify(after.slice(0, 2)));
      }

      // The in-memory undo stack dies with the tab. This must not.
      await hi.reload({ waitUntil: "networkidle" });
      await hi.waitForTimeout(800);
      const kept = await rows();
      check("the history survives a reload, unlike the undo toast",
        kept.length >= 3, String(kept.length));

      // A long label beside a button is the shape that runs off a phone, and
      // the page is only ever empty in the overflow sweep, which is where a
      // full one would have shown it.
      await hi.setViewportSize({ width: 390, height: 844 });
      await hi.waitForTimeout(400);
      const phone = await hi.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        button: !!document.querySelector(".hist-row button"),
      }));
      check("and a full list still fits a phone",
        phone.doc <= phone.vw && phone.button, JSON.stringify(phone));
    }
    await hi.close();
  }


  if (want("mark-recurring")) {
    // ── saying a charge repeats, from the charge itself ──
    //
    // The Recurring page could only ever be told about a schedule from its own
    // add button, which means from memory: the merchant, the amount and the
    // day all typed again with the transaction that prompted it on another
    // screen. This is the same editor reached from the row itself, with all of
    // that already filled in.
    const mr = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await mr.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await mr.waitForTimeout(1200);

    const listed = () => mr.evaluate(() =>
      JSON.parse(localStorage.getItem("sovereign.db.v1")).recurring ?? []);
    const recRow = () => mr.evaluate(() =>
      [...document.querySelectorAll(".modal .drow")]
        .find((r) => /^Recurring/.test(r.innerText))?.innerText.replace(/\n/g, " ") ?? "");
    const merchantOf = () => mr.evaluate(() =>
      document.querySelector(".modal .drow .truncate")?.innerText.trim() ?? "");
    const openRow = async (nth) => {
      await mr.locator(".list-row.tx-grid:not(.head) .tx-amount").nth(nth).click({ timeout: 8000 });
      await mr.locator(".modal .txn-amount").waitFor({ timeout: 5000 });
    };
    const closeRow = async () => {
      // Escape, since the transaction footer has no Cancel of its own. The
      // editor nested inside it still does, and is closed by its own button
      // below so that this one only ever shuts the outer dialog.
      await mr.keyboard.press("Escape");
      await mr.waitForTimeout(400);
    };
    const openEditor = async () => {
      await mr.locator(".modal .drow", { hasText: "Recurring" }).locator("button").click({ timeout: 8000 });
      await mr.locator(".rec-switch").waitFor({ timeout: 5000 });
    };
    /** The editor on top, read as a whole; there are two modals up by then. */
    const editor = () => mr.evaluate(() => {
      const modal = [...document.querySelectorAll(".modal")].pop();
      return {
        on: !!modal.querySelector(".rec-switch .switch.on"),
        labels: [...modal.querySelectorAll(".field label")].map((l) => l.innerText),
        name: modal.querySelector(".bold.truncate")?.innerText ?? "",
        date: modal.querySelector('input[type="date"]')?.value ?? "",
      };
    });

    if (await tryStep("a transaction opens", () => openRow(0))) {
      const rows = await mr.evaluate(() =>
        [...document.querySelectorAll(".modal .drow")].map((r) => r.innerText.replace(/\n/g, " | ")));
      const at = rows.findIndex((r) => /^Recurring/.test(r));
      check("the detail has a recurring row, under the books it belongs to",
        at >= 0, rows.map((r) => r.split(" | ")[0]).join(", "));
      // Under Books, or under Hide from reports where there is only one set of
      // books to be in. Either way it is below what the charge *is*.
      check("and it sits below them rather than among the amounts",
        at > rows.findIndex((r) => /^Hide from reports/.test(r)),
        `recurring at ${at}, of ${rows.length}`);
    }

    // Find one the detector already knows about, and one it does not. The demo
    // holds both, and which row is which is not something to write down here.
    let known = -1, fresh = -1;
    await tryStep("the transactions can be read for which of them repeat", async () => {
      for (let i = 0; i < 14 && (known < 0 || fresh < 0); i++) {
        if (!(await mr.locator(".modal .txn-amount").count())) await openRow(i);
        const said = await recRow();
        if (/Set up/.test(said)) { if (fresh < 0) fresh = i; } else if (said) { if (known < 0) known = i; }
        await closeRow();
      }
    });
    check("the list holds both a charge that repeats and one that does not",
      known >= 0 && fresh >= 0, `known ${known}, fresh ${fresh}`);

    if (known >= 0 && await tryStep("one that already repeats opens its editor", async () => {
      await openRow(known);
      await openEditor();
    })) {
      const e = await editor();
      check("a charge the detector already found says so on the transaction itself",
        e.on && e.labels.includes("Frequency") && e.labels.includes("Amount"), JSON.stringify(e));
      await mr.locator(".modal-foot button", { hasText: "Cancel" }).last().click({ timeout: 8000 });
      await mr.waitForTimeout(300);
      check("and the row under Books says how often, not that there is nothing there",
        /Monthly|Weekly|Yearly|Quarterly|Twice a year|Every 2 weeks/i.test(await recRow())
        && /next/.test(await recRow()), await recRow());
      await closeRow();
    }

    let merchant = "", was = 0;
    if (fresh >= 0 && await tryStep("one that does not repeat opens its editor", async () => {
      await openRow(fresh);
      merchant = await merchantOf();
      was = (await listed()).length;
      await openEditor();
    })) {
      const off = await editor();
      // Off until somebody says otherwise, and nothing to fill in while the
      // answer is no: a form for a schedule that does not exist is noise.
      check("a charge that does not repeat starts off, with its fields put away",
        !off.on && off.labels.length === 0, JSON.stringify(off));
      check("and names the merchant it would be for",
        off.name === merchant, `${off.name} against ${merchant}`);

      if (await tryStep("turning it on offers the schedule, already filled in", async () => {
        await mr.locator(".rec-switch .switch").click({ timeout: 5000 });
        await mr.locator(".modal .field").first().waitFor({ timeout: 5000 });
      })) {
        const on = await editor();
        check("with everything a schedule needs on it",
          ["Frequency", "Type", "Next date", "Amount", "Category", "Account"]
            .every((l) => on.labels.includes(l)), on.labels.join(", "));
        check("and a next date worked out from this charge, not left blank",
          /^\d{4}-\d{2}-\d{2}$/.test(on.date) && on.date > new Date().toISOString().slice(0, 10), on.date);

        if (await tryStep("it can be saved", async () => {
          await mr.locator(".modal-foot button", { hasText: "Save" }).last().click({ timeout: 8000 });
          await mr.waitForTimeout(800);
        })) {
          const now = await listed();
          check("which writes one schedule, for this merchant",
            now.length === was + 1 && now.some((r) => r.merchant === merchant),
            `${was} -> ${now.length}: ${now.map((r) => r.merchant).join(", ")}`);
          check("and leaves the transaction open behind it, not closed under it",
            (await mr.locator(".modal .txn-amount").count()) === 1);
          check("and the row now says how often and when next, rather than offering to set it up",
            /Monthly/.test(await recRow()) && !/Set up/.test(await recRow()), await recRow());

          await mr.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
          await mr.waitForTimeout(900);
          check("and it shows on the page it is a schedule for",
            await mr.evaluate((m) => [...document.querySelectorAll(".rec-row")]
              .some((r) => r.innerText.includes(m)), merchant), merchant);

          // And back on the list every charge at that merchant now says so,
          // not only the one it was set up from.
          await mr.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
          await mr.waitForTimeout(1200);
          const marked = await mr.evaluate((m) => {
            const rows = [...document.querySelectorAll(".list-row.tx-grid:not(.head)")];
            const at = rows.filter((r) => r.querySelector(".truncate")?.innerText.trim() === m);
            return { at: at.length, withMark: at.filter((r) => r.querySelector(".tx-repeat")).length };
          }, merchant);
          check("and every charge at it carries the marker, not just the one it was set up from",
            marked.at > 0 && marked.withMark === marked.at, JSON.stringify(marked));
        }
      }
    }
    await mr.close();
  }


  if (want("repeat-mark")) {
    // ── which of these comes round again ──
    //
    // A list of five thousand charges says nothing about which of them are the
    // ones that turn up every month. The marker is the whole point of the
    // schedules being there at all: it is what makes a page of transactions
    // readable as a page of commitments.
    const rm = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await rm.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await rm.waitForTimeout(1400);

    const read = () => rm.evaluate(() =>
      [...document.querySelectorAll(".list-row.tx-grid:not(.head)")].map((r) => ({
        name: r.querySelector(".truncate")?.innerText.trim() ?? "",
        mark: !!r.querySelector(".tx-repeat"),
        title: r.querySelector(".tx-repeat")?.getAttribute("title") ?? "",
      })));

    const rows = await read();
    const marked = rows.filter((r) => r.mark);
    check("some of the list is marked as repeating, and not all of it",
      marked.length > 0 && marked.length < rows.length, `${marked.length} of ${rows.length}`);
    check("and the marker says how often, rather than only that it does",
      marked.every((r) => /^Repeats (weekly|every 2 weeks|monthly|quarterly|twice a year|yearly)$/.test(r.title)),
      [...new Set(marked.map((r) => r.title))].join(" | "));

    // The same merchant cannot be marked on one line and not the next: what
    // repeats is the charge at a merchant, so the answer is per name.
    const byName = new Map();
    for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? new Set()).add(r.mark));
    check("and a merchant is either marked on every line or on none",
      [...byName.values()].every((s) => s.size === 1),
      [...byName].filter(([, s]) => s.size > 1).map(([n]) => n).join(", "));

    // It has to agree with the schedules themselves, or it is decoration.
    await rm.goto(`${BASE}/recurring`, { waitUntil: "networkidle" });
    await rm.waitForTimeout(900);
    const scheduled = await rm.evaluate(() =>
      // The first truncate in a row is the name; the second is the cadence.
      [...document.querySelectorAll(".rec-row")].map((r) => r.querySelector(".truncate")?.innerText.trim() ?? ""));
    check("and every marked merchant is one the Recurring page lists",
      marked.length > 0 && [...new Set(marked.map((r) => r.name))].every((n) => scheduled.includes(n)),
      `marked: ${[...new Set(marked.map((r) => r.name))].join(", ")} | scheduled: ${scheduled.join(", ")}`);

    // Hovering brings the merchant's own arrow up beside it rather than in
    // place of it: both belong to the name, and neither may push the other out.
    await rm.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await rm.waitForTimeout(1400);
    const hovered = rm.locator(".list-row.tx-grid:not(.head)").filter({ has: rm.locator(".tx-repeat") }).first();
    if (await tryStep("a marked row can be hovered", async () => {
      await hovered.hover({ timeout: 8000 });
      await rm.waitForTimeout(400);
    })) {
      const line = await hovered.evaluate((r) => {
        const mark = r.querySelector(".tx-repeat");
        const open = r.querySelector(".tx-merchant-open");
        const name = r.querySelector(".truncate");
        if (!mark || !open || !name) return { mark: !!mark, open: !!open };
        const m = mark.getBoundingClientRect(), o = open.getBoundingClientRect(), n = name.getBoundingClientRect();
        return {
          mark: true, open: true,
          shown: getComputedStyle(open).opacity !== "0",
          afterName: m.left >= n.right - 1,
          arrowAfterMark: o.left >= m.right - 1,
          sameLine: Math.abs(m.top - o.top) < 12,
        };
      });
      check("and the merchant's own arrow comes up beside the marker, after it",
        line.shown && line.afterName && line.arrowAfterMark && line.sameLine, JSON.stringify(line));
    }
    await rm.close();
  }


  if (want("wallet")) {
    // ── which card to reach for ──
    //
    // The arithmetic is pinned in scripts/selftest.mjs. What this checks is
    // that the page is wired to it: that saying what a card pays changes what
    // the page says, and that a figure nobody has confirmed is not dressed up
    // as one that has been.
    const wl = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
    const dollars = (t) => Number(t.replace(/[$,]/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "0");
    // A deadline that is always ahead of today, whenever this is run.
    const SOON = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await wl.goto(`${BASE}/cards`, { waitUntil: "networkidle" });
    await wl.waitForTimeout(1500);

    const read = () => wl.evaluate(() => ({
      best: document.querySelector(".nw-total")?.innerText ?? "",
      tiles: [...document.querySelectorAll(".card-head + .grid .card, .grid .card")]
        .map((t) => t.innerText.replace(/\n/g, " | ")),
      // Scoped to the wallet: the candidates below draw the same kind of row,
      // and a card nobody holds must not read as one that is held.
      cards: [...(([...document.querySelectorAll(".card")]
        .find((c) => /Your wallet/.test(c.querySelector(".card-head")?.innerText ?? ""))
        ?.querySelectorAll(".card-row")) ?? [])].map((r) => ({
        // The logo's initials are the first line of the row, so the name is
        // read off the element that holds it rather than off the text.
        name: r.querySelector(".bold")?.innerText.trim() ?? "",
        text: r.innerText.replace(/\n/g, " | "),
      })),
      rows: [...document.querySelectorAll(".card-cat:not(.head)")].map((r) => ({
        name: r.querySelector(".chip")?.innerText.trim() ?? "",
        reach: r.querySelector(".card-cat-best")?.innerText.trim() ?? "",
        missed: r.querySelector(".card-cat-gap")?.innerText.trim() ?? "",
      })),
      unset: [...document.querySelectorAll(".card-unset")].length,
      warns: [...document.querySelectorAll(".card-head")].some((h) => /Nobody has checked/.test(h.innerText)),
    }));

    const before = await read();
    check("the page opens on a wallet with cards in it",
      before.cards.length >= 2 && before.rows.length > 3,
      `${before.cards.length} cards, ${before.rows.length} categories`);
    // A page that quietly assumed 1% and said nothing would be presenting a
    // guess as a finding.
    check("and says plainly that nobody has said what these cards pay",
      before.warns && before.unset === before.cards.length,
      `${before.unset} marked unset of ${before.cards.length}`);
    check("with nothing to move while every card pays the same",
      before.rows.every((r) => r.missed === "-" && /stay put/i.test(r.reach)),
      before.rows.slice(0, 3).map((r) => `${r.name}: ${r.reach} ${r.missed}`).join(" | "));

    // Say one card pays more on one category and the page has to find it.
    const named = before.rows.find((r) => r.name)?.name ?? "";
    if (await tryStep("a card's terms can be filled in", async () => {
      await wl.locator(".card-row").nth(1).click({ timeout: 8000 });
      await wl.locator(".modal").waitFor({ timeout: 5000 });
      await wl.locator('.modal .field:has(label:text-is("On everything")) input').fill("4", { timeout: 8000 });
      await wl.locator(".modal-foot button", { hasText: "Save and confirm" }).click({ timeout: 8000 });
      await wl.waitForTimeout(900);
    })) {
      const after = await read();
      const second = before.cards[1].name;
      check("which is what the wallet then says it pays",
        after.cards[1].text.includes("4%"), after.cards[1].text);
      check("and the card stops being marked as unchecked",
        after.unset === before.unset - 1, `${before.unset} -> ${after.unset}`);
      // Only the rows with something in them: a category whose saving rounds
      // to nothing says "stay put" on purpose, and reading those as failures
      // would be asserting the opposite of what the page is for.
      const worth = after.rows.filter((r) => /^\+\$/.test(r.missed));
      check("the better card becomes the one to reach for",
        worth.length > 0 && worth.every((r) => r.reach.includes(second)),
        `${second}: ${worth.slice(0, 3).map((r) => r.reach).join(" | ")} of ${worth.length}`);
      check("and the page now says what reaching for the wrong one cost",
        after.rows.some((r) => /^\+\$/.test(r.missed)),
        after.rows.slice(0, 3).map((r) => r.missed).join(" | "));
      check("with a bigger figure than before at the top",
        dollars(after.best) > dollars(before.best), `${before.best} -> ${after.best}`);
      check("and the daily driver is the card that pays more on everything",
        await wl.evaluate((n) => document.body.innerText.includes(n), second), second);
    }

    // Saving a half-finished draft must not promote a guess to a checked
    // figure. The two buttons mean different things and the page leans on the
    // difference to tell the reader which of the two it is showing them.
    if (await tryStep("a card's terms can be saved without confirming them", async () => {
      await wl.locator(".card-row").first().click({ timeout: 8000 });
      await wl.locator(".modal").waitFor({ timeout: 5000 });
      await wl.locator('.modal .field:has(label:text-is("On everything")) input').fill("3", { timeout: 8000 });
      await wl.locator(".modal-foot button", { hasText: "Save" }).first().click({ timeout: 8000 });
      await wl.waitForTimeout(900);
    })) {
      const draft = await read();
      check("which keeps the rate that was typed",
        draft.cards[0].text.includes("3%"), draft.cards[0].text);
      check("and still says nobody has checked it",
        draft.unset === 1 && draft.warns, `${draft.unset} unset, warned ${draft.warns}`);
    }

    // The draft button, and what it does when there is nothing behind it.
    // A button that silently fails is worse than no button.
    if (await tryStep("the editor offers a first draft", async () => {
      await wl.locator(".card-row").first().click({ timeout: 8000 });
      await wl.locator(".card-ask").waitFor({ timeout: 5000 });
    })) {
      const ask = await wl.evaluate(() => document.querySelector(".card-ask")?.innerText ?? "");
      check("saying what it sends and that it is a draft, not an answer",
        /card's name and your category names/.test(ask) && /will sometimes be wrong/.test(ask),
        ask.replace(/\n/g, " | ").slice(0, 120));

      if (await tryStep("and it can be pressed", async () => {
        await wl.locator(".card-ask button").click({ timeout: 8000 });
        await wl.waitForTimeout(1200);
      })) {
        // This preview has no key and no passphrase, so the honest outcome is
        // a message. What must not happen is a silent nothing, or a form that
        // fills itself with invented figures.
        const after = await wl.evaluate(() => ({
          // Playwright's :text-is() is not CSS, so inside the page the field is
          // found by its label the long way round.
          said: [...document.querySelectorAll(".modal .tiny")].map((e) => e.innerText).join(" | "),
          rules: document.querySelectorAll(".card-rule").length,
        }));
        check("and says so when it cannot reach Hopper, rather than failing quietly",
          /not connected|could not be reached|no API key/i.test(after.said), after.said.slice(0, 140));
        check("leaving the form as it was rather than filling it with guesses",
          after.rules === 0, `${after.rules} rules appeared`);
      }
      await wl.locator(".modal-foot button", { hasText: "Cancel" }).click({ timeout: 8000 });
      await wl.waitForTimeout(400);
    }

    // A fee that does not clear, a bonus with a deadline, and a card nobody
    // holds measured against the year that happened. Between them these are
    // the difference between a rewards page and a scoreboard.
    if (await tryStep("a fee and a bonus can be entered", async () => {
      await wl.locator(".card-row").first().click({ timeout: 8000 });
      await wl.locator(".modal").waitFor({ timeout: 5000 });
      await wl.locator('.modal .field:has(label:text-is("Annual fee")) input').fill("395", { timeout: 8000 });
      await wl.locator('.modal .field:has(label:text-is("Spend to earn it")) input').fill("4000", { timeout: 8000 });
      await wl.waitForTimeout(400);
      await wl.locator('.modal .field:has(label:text-is("By")) input').fill(SOON, { timeout: 8000 });
      await wl.locator(".modal-foot button", { hasText: "Save and confirm" }).click({ timeout: 8000 });
      await wl.waitForTimeout(900);
    })) {
      const row = await wl.evaluate(() =>
        document.querySelector(".card-row")?.innerText.replace(/\n/g, " | ") ?? "");
      check("and the card says whether what it earned covers its fee",
        /Clears its fee|short of its fee/.test(row), row.slice(0, 160));
      check("and how far along the bonus is, with the days still to run",
        /still to spend for the bonus, \d+ days? left|Bonus earned/.test(row), row.slice(0, 160));
    }

    // A card nobody holds, weighed against the spending that happened.
    const candidates = () => wl.evaluate(() => {
      const card = [...document.querySelectorAll(".card")]
        .find((c) => /weighing up/.test(c.querySelector(".card-head")?.innerText ?? ""));
      return card ? [...card.querySelectorAll(".card-row")].map((r) => r.innerText.replace(/\n/g, " | ")) : null;
    });
    check("the page offers to weigh up a card nobody holds", (await candidates())?.length === 0,
      JSON.stringify(await candidates()));

    if (await tryStep("one can be typed in", async () => {
      await wl.locator(".card-head button", { hasText: "Add" }).last().click({ timeout: 8000 });
      await wl.locator(".modal").waitFor({ timeout: 5000 });
      await wl.locator('.modal .field:has(label:text-is("Card")) input').fill("A Better Card", { timeout: 8000 });
      await wl.locator('.modal .field:has(label:text-is("On everything")) input').fill("9", { timeout: 8000 });
      await wl.locator('.modal .field:has(label:text-is("Annual fee")) input').fill("50", { timeout: 8000 });
      await wl.locator(".modal-foot button", { hasText: "Save and confirm" }).click({ timeout: 8000 });
      await wl.waitForTimeout(900);
    })) {
      const listed = await candidates();
      check("and is measured against the year that happened, net of its fee",
        listed?.length === 1 && /A Better Card/.test(listed[0])
        && /more than your wallet earned/.test(listed[0]) && /\+\$/.test(listed[0]),
        (listed ?? []).join(" // ").slice(0, 190));
      // It is not a card anybody holds: it must not turn up in the wallet or
      // change what the wallet is said to have earned.
      const after = await read();
      check("without joining the wallet or changing what the wallet earned",
        after.cards.length === before.cards.length
        && !after.cards.some((c) => /A Better Card/.test(c.name)),
        after.cards.map((c) => c.name).join(", "));

      // One that is no better than what is already held, with a fee. The fee
      // has to come off, or a page could recommend paying for nothing.
      if (await tryStep("a card that is no better can be typed in too", async () => {
        await wl.locator(".card-head button", { hasText: "Add" }).last().click({ timeout: 8000 });
        await wl.locator(".modal").waitFor({ timeout: 5000 });
        await wl.locator('.modal .field:has(label:text-is("Card")) input').fill("No Better Card", { timeout: 8000 });
        await wl.locator('.modal .field:has(label:text-is("On everything")) input').fill("1", { timeout: 8000 });
        await wl.locator('.modal .field:has(label:text-is("Annual fee")) input').fill("95", { timeout: 8000 });
        await wl.locator(".modal-foot button", { hasText: "Save and confirm" }).click({ timeout: 8000 });
        await wl.waitForTimeout(900);
      })) {
        const both = await candidates();
        const dud = (both ?? []).find((r) => /No Better Card/.test(r)) ?? "";
        check("and comes out behind by its fee, rather than looking free",
          /Nothing you buy would go on it/.test(dud) && /-\$95/.test(dud), dud.slice(0, 190));
        await wl.locator(".card-row", { hasText: "No Better Card" }).click({ timeout: 8000 });
        await wl.locator(".modal-foot button", { hasText: "Remove" }).click({ timeout: 8000 });
        await wl.waitForTimeout(700);
      }

      if (await tryStep("and it can be dropped again", async () => {
        await wl.locator(".card-row", { hasText: "A Better Card" }).click({ timeout: 8000 });
        await wl.locator(".modal-foot button", { hasText: "Remove" }).click({ timeout: 8000 });
        await wl.waitForTimeout(800);
      })) {
        check("leaving nothing behind", (await candidates())?.length === 0, JSON.stringify(await candidates()));
      }
    }

    // A bonus rate with a cap has to be enterable, because a cap is most of
    // what a cash-back card is.
    if (await tryStep("a capped bonus rate can be added", async () => {
      await wl.locator(".card-row").first().click({ timeout: 8000 });
      await wl.locator(".modal").waitFor({ timeout: 5000 });
      await wl.locator(".modal button", { hasText: "Add" }).click({ timeout: 8000 });
      await wl.locator(".card-rule").waitFor({ timeout: 5000 });
    })) {
      const rule = await wl.evaluate(() => {
        const r = document.querySelector(".card-rule");
        return {
          fields: r ? r.innerText.replace(/\n/g, " | ") : "",
          periods: [...(r?.querySelectorAll("select option") ?? [])].map((o) => o.innerText),
        };
      });
      check("holding a rate, a category, a cap and what the cap resets on",
        /up to/.test(rule.fields) && rule.periods.join(",") === "a month,a quarter,a year,ever",
        `${rule.fields.slice(0, 80)} // ${rule.periods.join(",")}`);
      check("and saying so when it would do nothing without a category",
        /Pick at least one category/.test(rule.fields), rule.fields.slice(0, 90));
    }
    await wl.close();
  }


  if (want("settings-trim")) {
    // ── settings holds settings, not switches nobody moves ──
    //
    // Every toggle on this page had one sensible position and was left in it.
    // What replaced them is nothing: logos always resolve, prices and property
    // values always refresh with the accounts, and the theme is switched from
    // the bar at the top of every screen rather than from a page you have to
    // go and find.
    const st = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
    await st.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
    await st.waitForTimeout(1200);

    const page = await st.evaluate(() => ({
      cards: [...document.querySelectorAll(".card-head h2")].map((h) => h.innerText.trim()),
      switches: document.querySelectorAll(".page .switch").length,
      buttons: [...document.querySelectorAll(".page button")].map((b) => b.innerText.trim()),
    }));

    check("settings carries no toggles at all", page.switches === 0, `${page.switches} left`);
    for (const gone of ["Danger zone", "Import transactions", "What's stored where"]) {
      check(`and no "${gone}" box`, !page.cards.includes(gone), page.cards.join(", "));
    }
    // The pushback: that box held the only way to take a copy out or put one
    // back, and those buttons had to survive it.
    check("but the way to take a backup and put one back survives",
      ["Back up JSON", "Export CSV", "Restore backup"].every((b) => page.buttons.some((t) => t.includes(b))),
      page.buttons.join(" | ").slice(0, 160));

    // The theme is still switchable, from the bar rather than from here.
    const themed = await st.evaluate(() => {
      const was = document.documentElement.dataset.theme;
      document.querySelector('.topbar button[title="Toggle theme"]')?.click();
      return { was, button: !!document.querySelector('.topbar button[title="Toggle theme"]') };
    });
    await st.waitForTimeout(400);
    check("and the theme is still switched, from the bar on every screen",
      themed.button && (await st.evaluate(() => document.documentElement.dataset.theme)) !== themed.was,
      JSON.stringify(themed));

    // Always-on means always on: the logos have to be there with nothing set.
    await st.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
    await st.waitForTimeout(1400);
    const logos = await st.evaluate(() => ({
      merchant: document.querySelectorAll(".tx-mark .institution-logo img").length,
      rows: document.querySelectorAll(".list-row.tx-grid:not(.head)").length,
    }));
    check("and merchant logos resolve with nothing to switch them on",
      logos.merchant > 0, JSON.stringify(logos));
    await st.close();
  }


  if (want("not-saved")) {
    // ── a save that is not happening has to be impossible to miss ──
    //
    // The failure this exists for: every save failed for three weeks, said so
    // each time in a toast that went away after three seconds, was never seen,
    // and the work went when the browser's data was cleared for an unrelated
    // reason. The toast was honest. The design was wrong.
    const ns = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await ns.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await ns.waitForTimeout(1500);

    const pill = () => ns.evaluate(() => {
      const el = document.querySelector(".save-pill");
      return el ? { text: el.innerText.trim(), stuck: el.classList.contains("stuck") } : null;
    });
    /** Put a cloud state in place the way the app does, and tell the page. */
    const say = (state) => ns.evaluate((s) => {
      localStorage.setItem("sovereign.cloud.state.v1", JSON.stringify(s));
      window.dispatchEvent(new CustomEvent("sovereign:cloud"));
    }, state);

    check("a browser keeping up says nothing", (await pill()) === null, JSON.stringify(await pill()));

    // Never connected is not failing: this must stay quiet for somebody who
    // has never asked for the cloud at all.
    await say({ version: 0, dirty: true });
    await ns.waitForTimeout(300);
    check("and neither does one that never asked for the cloud",
      (await pill()) === null, JSON.stringify(await pill()));

    await say({
      version: 12, dirty: true, failures: 3, okAt: Date.now() - 3 * 3600_000,
      lastError: { status: 500, message: "Your project has exceeded the data transfer quota.", at: Date.now() },
    });
    await ns.waitForTimeout(400);
    const shown = await pill();
    check("but work the cloud has not taken is said in the bar, without a reload",
      shown !== null && /not saved/i.test(shown.text), JSON.stringify(shown));

    if (await tryStep("and it opens on what is wrong", async () => {
      await ns.locator(".save-pill").click({ timeout: 8000 });
      await ns.locator(".menu").waitFor({ timeout: 5000 });
    })) {
      const panel = await ns.evaluate(() => document.querySelector(".menu")?.innerText.replace(/\n/g, " | ") ?? "");
      check("naming the reason and when it last got through",
        /exceeded the data transfer quota/.test(panel) && /Last saved to the cloud 3 hours ago/.test(panel),
        panel.slice(0, 170));
      // The one thing that actually rescues this, one press away rather than
      // four screens away.
      check("and offering the copy that does not depend on the cloud",
        /Back up to a file now/.test(panel), panel.slice(0, 170));
      await ns.keyboard.press("Escape");
      await ns.waitForTimeout(300);
    }

    // It has to be on every screen, not just the one that was open.
    for (const path of ["/transactions", "/settings"]) {
      await ns.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await ns.waitForTimeout(900);
      const here = await pill();
      check(`and it is still there on ${path}`, here !== null && /not saved/i.test(here.text), JSON.stringify(here));
    }

    // A blocked sync is louder, and says so with nothing waiting to go.
    await say({ version: 12, dirty: false, blocked: "Wrong passphrase." });
    await ns.waitForTimeout(400);
    const stuck = await pill();
    check("a sync that waiting cannot fix is louder, and does not wait for an edit",
      stuck !== null && stuck.stuck === true, JSON.stringify(stuck));

    // ── on a phone it is the cloud alone ──
    //
    // The bar there is a title and three marks wide, and two words of "Not
    // saved" were a fifth of it. What it must not lose is the thing that makes
    // it work: the colour it is shouting in, and a name for anyone who cannot
    // see the mark.
    await say({ version: 12, dirty: true, blocked: "Wrong passphrase." });
    await ns.waitForTimeout(400);
    const skin = () => ns.evaluate(() => {
      const el = document.querySelector(".save-pill");
      if (!el) return null;
      const s = getComputedStyle(el);
      const txt = el.querySelector(".save-pill-text");
      const box = el.getBoundingClientRect();
      return {
        background: s.backgroundColor,
        color: s.color,
        words: txt ? getComputedStyle(txt).display !== "none" : false,
        icon: !!el.querySelector("svg"),
        name: el.getAttribute("aria-label") ?? "",
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    });
    const wide = await skin();
    await ns.setViewportSize({ width: 390, height: 844 });
    await ns.waitForTimeout(400);
    const narrow = await skin();
    check("on a phone the pill is the cloud on its own",
      narrow !== null && narrow.icon && !narrow.words && wide !== null && wide.words,
      JSON.stringify(narrow));
    check("in the same colours it was shouting in",
      narrow !== null && wide !== null
      && narrow.background === wide.background && narrow.color === wide.color,
      `${narrow?.background} on ${narrow?.color}, was ${wide?.background} on ${wide?.color}`);
    check("round rather than a pill with nothing in it",
      narrow !== null && Math.abs(narrow.width - narrow.height) <= 2 && narrow.width >= 24,
      `${narrow?.width}x${narrow?.height}`);
    // display:none takes the words out of the accessibility tree too, so the
    // button would otherwise be a mark with no name at all.
    check("and it still says what it is to anyone who cannot see it",
      narrow !== null && /not saved/i.test(narrow.name), JSON.stringify(narrow?.name));
    await ns.setViewportSize({ width: 1280, height: 900 });
    await ns.waitForTimeout(300);

    // And it goes when the work lands, rather than needing to be dismissed.
    await say({ version: 13, dirty: false, okAt: Date.now() });
    await ns.waitForTimeout(400);
    check("and it goes by itself once the save gets through",
      (await pill()) === null, JSON.stringify(await pill()));
    await ns.close();
  }


  if (want("rule-conditions")) {
    // ── a rule can ask for more than one thing about the merchant ──
    //
    // One shop bills as Coopershawk and as Coopers Hawk Wine, and telling
    // those apart from a tyre shop called Cooper takes two conditions. The
    // matching is unit-tested; what cannot be seen from there is whether the
    // editor can actually be used to write one, at the width it is used at.
    for (const w of [1280, 390]) {
      const rp = await browser.newPage({ viewport: { width: w, height: 1000 } });
      await rp.goto(`${BASE}/rules`, { waitUntil: "networkidle" });
      await rp.waitForTimeout(900);
      await rp.locator("button.btn-primary").first().click({ timeout: 8000 });
      await rp.waitForTimeout(500);

      const row = () => rp.locator(".rule-cond");
      check(`${w}px — a new rule opens with one merchant condition`,
        await row().count() === 1, `${await row().count()} rows`);

      // The comparison is the thing that was in the engine and not on screen.
      const modes = await rp.locator(".rule-cond select").first()
        .locator("option").allTextContents();
      check(`${w}px — and it can be changed from "contains" to an exact match`,
        modes.join("/") === "contains/is exactly/starts with/ends with", modes.join("/"));

      await rp.locator(".rule-cond .input").first().fill("cooper");
      await rp.locator('button[aria-label="Add a condition"]').click({ timeout: 5000 });
      await rp.waitForTimeout(300);
      check(`${w}px — the plus adds a second one`, await row().count() === 2, `${await row().count()} rows`);

      // The second carries the join the first cannot have.
      const joins = await rp.locator(".rule-cond").nth(1).locator("select").first()
        .locator("option").allTextContents();
      check(`${w}px — which can be joined with and or with or`, joins.join("/") === "and/or", joins.join("/"));

      await rp.locator(".rule-cond").nth(1).locator(".input").fill("hawk");
      await rp.waitForTimeout(400);

      // Nothing may spill sideways, which is the whole reason this runs at 390.
      const overflow = await rp.evaluate(() => {
        const m = document.querySelector(".modal");
        return m ? m.scrollWidth - m.clientWidth : -1;
      });
      check(`${w}px — two conditions fit the dialog`, overflow <= 0, `${overflow}px over`);

      // And the minus takes one away again, leaving the first without one.
      check(`${w}px — the first condition has no way to be removed`,
        await rp.locator(".rule-cond").first().locator('button[aria-label="Remove this condition"]').count() === 0);
      await rp.locator(".rule-cond").nth(1).locator('button[aria-label="Remove this condition"]').click({ timeout: 5000 });
      await rp.waitForTimeout(300);
      check(`${w}px — and the minus takes it away again`, await row().count() === 1, `${await row().count()} rows`);
      await rp.close();
    }
  }

} finally {
  await browser.close();
}

for (const [state, name, msg] of results) console.log(`${state}  ${name}${msg ? ` — ${msg}` : ""}`);
if (skipped.length) console.log(`\nSKIPPED  ${skipped.join(", ")} — this was not a full run`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

/**
 * Renders public/icon.svg to the PNGs a phone needs.
 *
 * iOS will not use an SVG for a home screen icon — it wants a PNG, opaque,
 * and it composites anything transparent onto black — so the one drawing has
 * to become files. They are committed rather than built, because they change
 * about as often as the brand does; run `npm run icons` after editing the SVG.
 *
 * Chromium does the rasterising. It is already here for the layout checks, and
 * it renders the same engine the icon will be judged in.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "public/icon.svg");

// Same escape hatch the breakpoint checks use: the bundled browser is not always
// the one this machine has on disk.
const CHROME = process.env.CHROME_PATH;

/** Every size, and why it exists. */
const TARGETS = [
  ["public/apple-touch-icon.png", 180, "iOS home screen, and what Safari and DuckDuckGo look for first"],
  ["public/icon-192.png", 192, "the manifest's small icon — Android home screen, install prompts"],
  ["public/icon-512.png", 512, "the manifest's large icon — splash screens and app listings"],
];

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("icons: playwright is not installed — skipping. The committed PNGs are unchanged.");
  process.exit(0);
}

if (!existsSync(source)) {
  console.error(`icons: ${source} is missing.`);
  process.exit(1);
}

const svg = await readFile(source, "utf8");
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
try {
  for (const [file, size, why] of TARGETS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    // The margin reset matters: a stray body margin would shrink the drawing
    // and leave a black seam down two edges once iOS composites it.
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:#e8894a}
       svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: resolve(root, file), omitBackground: false });
    await page.close();
    console.log(`icons: ${file} — ${size}×${size} (${why})`);
  }
} finally {
  await browser.close();
}

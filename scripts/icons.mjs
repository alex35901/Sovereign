/**
 * Turns design/logo-source.png into the icons the app actually serves.
 *
 * The master is a raster, so nothing here traces or redraws it — the shape
 * that ships is the shape that was drawn. Three things are done to it, all of
 * them reversible by changing a number:
 *
 *   flattened  The master arrived with a little generator noise: the orange
 *              wanders a few levels either side of #ec7132 and the white
 *              averages 253. Every pixel is re-expressed as "how far along the
 *              line from background to white is it" and repainted from the two
 *              exact colours, so edges keep their anti-aliasing and the tile
 *              matches the app's own flat orange instead of looking dirty
 *              beside it.
 *   centred    It arrived sitting high in the frame, which shows once the
 *              corners are rounded.
 *   scaled     To FILL of the tile's width. An icon's real job is 32px in the
 *              sidebar and 60px on a home screen, and the master was composed
 *              to be looked at large.
 *
 * Chromium does the arithmetic and the resampling: it is already here for the
 * layout checks, it is the engine the icon will be judged in, and it means
 * this needs no image library the project does not already have.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "design/logo-source.png");

/** The brand orange, and the share of the tile's width the mark should span. */
export const ORANGE = [0xec, 0x71, 0x32];
const FILL = 0.72;

const CHROME = process.env.CHROME_PATH;

/** Every size, and why it exists. */
const TARGETS = [
  ["public/favicon-32.png", 32, "the browser tab"],
  ["public/icon-96.png", 96, "the sidebar's brand chip, at up to 3x"],
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

const data = `data:image/png;base64,${(await readFile(source)).toString("base64")}`;
const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
try {
  const page = await browser.newPage();
  await page.setContent("<!doctype html><body></body>");

  // The mark alone, cut out and flattened, on transparency — so it can be
  // moved and resized without dragging a tile of background around with it.
  const cut = await page.evaluate(async ({ data, orange }) => {
    const img = new Image();
    img.src = data;
    await img.decode();
    const n = img.naturalWidth;

    const src = new OffscreenCanvas(n, n);
    const sx = src.getContext("2d", { willReadFrequently: true });
    sx.drawImage(img, 0, 0);
    const px = sx.getImageData(0, 0, n, n).data;

    // How far each pixel lies along background -> white.
    const axis = [255 - orange[0], 255 - orange[1], 255 - orange[2]];
    const len2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
    const alpha = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const r = px[i * 4] - orange[0], g = px[i * 4 + 1] - orange[1], b = px[i * 4 + 2] - orange[2];
      alpha[i] = (r * axis[0] + g * axis[1] + b * axis[2]) / len2;
    }
    // The master's white sits a shade under 255; stretch so the body of the
    // mark reaches a true 1 rather than leaving a grey cast across all of it.
    const body = Array.from(alpha).filter((v) => v > 0.5).sort((a, b) => a - b);
    const peak = body[Math.floor(body.length * 0.6)] || 1;
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.min(1, Math.max(0, alpha[i] / peak));

    let x0 = n, y0 = n, x1 = 0, y1 = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (alpha[y * n + x] > 0.5) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }

    const c = new OffscreenCanvas(n, n);
    const g = c.getContext("2d");
    const out = g.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      out.data[i * 4] = 255; out.data[i * 4 + 1] = 255; out.data[i * 4 + 2] = 255;
      out.data[i * 4 + 3] = Math.round(alpha[i] * 255);
    }
    g.putImageData(out, 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    const url = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
    return { url, n, box: [x0, y0, x1, y1], peak };
  }, { data, orange: ORANGE });

  const width = cut.box[2] - cut.box[0];
  const scale = (FILL * cut.n) / width;
  const dx = cut.n / 2 - ((cut.box[0] + cut.box[2]) / 2) * scale;
  const dy = cut.n / 2 - ((cut.box[1] + cut.box[3]) / 2) * scale;
  console.log(`icons: ${cut.n}x${cut.n} master, mark ${width}px wide`);
  console.log(`icons: white stretched by ${(1 / cut.peak).toFixed(3)}, scaled x${scale.toFixed(3)}, `
    + `shifted (${dx.toFixed(0)}, ${dy.toFixed(0)})`);
  await page.close();

  for (const [file, size, why] of TARGETS) {
    // Screenshot rather than canvas: a canvas PNG always carries an alpha
    // channel, and iOS composites transparency onto black — which would put a
    // dark halo around the mark on an orange ground.
    const shot = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const k = size / cut.n;
    await shot.setContent(`<!doctype html><style>
      html,body{margin:0;padding:0;background:rgb(${ORANGE.join(",")})}
      img{position:absolute;left:${dx * k}px;top:${dy * k}px;width:${cut.n * scale * k}px;height:auto}
    </style><img src="${cut.url}">`);
    await shot.screenshot({ path: resolve(root, file), omitBackground: false });
    await shot.close();
    console.log(`icons: ${file} — ${size}x${size} (${why})`);
  }
} finally {
  await browser.close();
}

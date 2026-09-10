/**
 * The whole app as one HTML file.
 *
 * Usage:
 *   node scripts/preview.mjs [out.html]
 *
 * Built for somewhere that is not the deployment: no server to rewrite paths,
 * no functions to answer /api, nothing to fetch a second file from. So the
 * routing moves into the fragment, the JavaScript and the CSS are inlined, and
 * code splitting is turned off, because a dynamic import would go looking for a
 * chunk that no longer exists anywhere.
 *
 * What it cannot do is anything that needs the server: no sync, no bank
 * providers, no Hopper. It opens on the demo budget held in the browser's own
 * storage, which is the point: it is for looking at, on a phone, without a
 * deployment.
 */
import { build } from "vite";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

const out = process.argv[2] ?? "preview/sovereign.html";
const dir = "dist-preview";

await rm(dir, { recursive: true, force: true });

await build({
  root: process.cwd(),
  // Relative, so nothing is looked up from the root of whatever serves this.
  base: "./",
  define: { "import.meta.env.VITE_HASH_ROUTER": "true" },
  build: {
    outDir: dir,
    emptyOutDir: true,
    // One chunk. An inlined script cannot fetch the others.
    rollupOptions: { output: { inlineDynamicImports: true } },
    rolldownOptions: { output: { codeSplitting: false, inlineDynamicImports: true } },
    // Nothing to serve a .map from either.
    sourcemap: false,
  },
  logLevel: "warn",
});

const html = await readFile(join(dir, "index.html"), "utf8");

const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)];
const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
if (!scripts.length) throw new Error("no script tag found in the built index.html");

const asset = async (href) => readFile(join(dir, href.replace(/^\.?\//, "")), "utf8");

/**
 * Its own name, not the app's. This ends up in a tab and in a gallery beside
 * the real thing, and two entries called the same is how somebody comes to
 * look at demo data believing it is their money.
 */
const title = "Sovereign Preview";

/**
 * The one image the app asks for by path. There is no /icon-96.png next to a
 * single file, so it goes in as its own bytes rather than as a broken frame in
 * the corner of every screen.
 */
const logo = await readFile("public/icon-96.png").then((b) => `data:image/png;base64,${b.toString("base64")}`);
const css = (await Promise.all(styles.map((m) => asset(m[1])))).join("\n");
const js = (await Promise.all(scripts.map((m) => asset(m[1]))))
  .join("\n")
  .replaceAll("/icon-96.png", logo);

/**
 * The artifact host wraps whatever is written here in its own document, so
 * this file carries page content only: no doctype, no <html>, no <head>, no
 * <body>. The theme attribute the app expects on the root element is set from
 * script instead of written into the markup.
 */
const page = `<title>${title}</title>
<style>
${css}
</style>
<div id="root"></div>
<script>
document.documentElement.setAttribute("data-theme", "dark");
</script>
<script type="module">
${js}
</script>
`;

await writeFile(out, page);
await rm(dir, { recursive: true, force: true });

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`${out}  ${kb(page.length)}  (css ${kb(css.length)}, js ${kb(js.length)})`);

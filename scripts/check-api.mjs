/**
 * Loads every serverless function the way the deployment does.
 *
 * Vercel compiles each api/*.ts to its own ESM .js and lets Node resolve the
 * relative imports between them. Node's ESM resolver requires an explicit file
 * extension, so `import "./_auth"` becomes ERR_MODULE_NOT_FOUND at runtime —
 * a clean build, and then FUNCTION_INVOCATION_FAILED on every request.
 *
 * Type-checking cannot catch this on its own: under `bundler` resolution the
 * extensionless form is perfectly legal, it just doesn't survive to runtime.
 * So this compiles the functions and actually imports them.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = mkdtempSync(join(tmpdir(), "api-check-"));
let failed = 0;

const entrypoints = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) entrypoints(full, acc);
    // files beginning with _ are helpers, not routes, but are still imported
    else if (name.endsWith(".ts") && !name.startsWith("_")) acc.push(full);
  }
  return acc;
};

try {
  try {
    execFileSync("npx", ["tsc", "-p", "tsconfig.emit.json", "--outDir", out], {
      cwd: root, stdio: "pipe", encoding: "utf8",
    });
  } catch (err) {
    console.error("api/ did not compile:\n" + (err.stdout ?? err.message));
    process.exit(1);
  }

  for (const src of entrypoints(join(root, "api"))) {
    const route = "/" + relative(root, src).replace(/\.ts$/, "").split(sep).join("/");
    const js = join(out, relative(root, src).replace(/\.ts$/, ".js"));
    try {
      execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(js).href)});`], {
        cwd: root, stdio: "pipe", encoding: "utf8",
      });
      console.log(`OK   ${route}`);
    } catch (err) {
      failed += 1;
      const why = String(err.stderr ?? err.message).split("\n").filter((l) => /Error|Cannot find/.test(l))[0] ?? "failed to load";
      console.error(`FAIL ${route}\n       ${why.trim()}`);
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} function(s) would fail to load on the deployment.`);
  console.error("Relative imports in api/ and anything it reaches need an explicit .js extension.");
  process.exit(1);
}
console.log("every function loads under Node's ESM resolver");

/**
 * Type-checks the serverless functions the way the deployment does.
 *
 * Vercel type-checks each api/ entrypoint against the root tsconfig.json —
 * not the referenced projects — and where that file carries no compilerOptions
 * it falls back to TypeScript's defaults: nodenext resolution and no node
 * types. Every extensionless import and every use of Buffer, process and
 * node:http is then an error, and the deployment fails while `tsc -b` passes
 * locally. This asserts the root file actually says what it needs to, then
 * checks the functions under exactly those settings.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = JSON.parse(
  readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""),
);
const opts = root.compilerOptions;
const problems = [];

if (!opts) {
  problems.push("tsconfig.json has no compilerOptions, so the deployment will type-check api/ with TypeScript's defaults");
} else {
  if (!Array.isArray(opts.types) || !opts.types.includes("node")) {
    problems.push('compilerOptions.types must include "node", or Buffer, process and node: imports are unresolved');
  }
  const resolution = String(opts.moduleResolution ?? "").toLowerCase();
  if (!["bundler", "node", "node10"].includes(resolution)) {
    problems.push(`compilerOptions.moduleResolution is "${opts.moduleResolution}", which requires an explicit .js on every relative import`);
  }
}

if (problems.length) {
  console.error("api/ would not compile on Vercel:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

try {
  execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.api.json"], { stdio: "inherit" });
} catch {
  process.exit(1);
}
console.log("api/ type-checks under the options the deployment uses");

/**
 * Whether anything here is running past the end of its upstream support.
 *
 * The attestation this exists for says end-of-life software is monitored. A
 * policy document saying so is not monitoring: the date arrives quietly, the
 * runtime keeps working, and nobody finds out until a vulnerability is
 * published against a line that will never be patched again.
 *
 * So the dates are written down and checked. Node's release schedule is the
 * only one that needs a table, because it is the only component here whose
 * version this repository pins. Postgres is the provider's to upgrade, and
 * dependency support is what Dependabot and `npm run audit` cover.
 *
 * Exits non-zero when something is already out of support, and says so without
 * failing when something is within the warning window, so that a release is
 * stopped by an expiry rather than by an approaching one.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Node's own schedule, from nodejs.org/en/about/previous-releases.
 *
 * Kept here rather than fetched, because a check that needs the network is a
 * check that passes by being unable to run. Even-numbered lines only: an
 * odd-numbered Node line never becomes LTS and is not something to deploy.
 */
export const NODE_EOL = {
  18: "2025-04-30",
  20: "2026-04-30",
  22: "2027-04-30",
  24: "2028-04-30",
};

/** How long before an end-of-life date to start saying so. */
export const WARN_DAYS = 90;

/** The major version a semver range asks for, or null when it asks for nothing. */
export function majorOf(range) {
  const found = /(\d+)/.exec(String(range ?? ""));
  return found ? Number(found[1]) : null;
}

/**
 * What to say about one component, given the day.
 *
 * Pure, so the interesting cases can be tested without waiting years for them
 * to happen.
 */
export function checkEol(name, major, table, now) {
  if (major === null) {
    return { name, level: "unknown", line: `${name}: no version is pinned, so nothing can be checked.` };
  }
  const eol = table[major];
  if (!eol) {
    return { name, level: "unknown", line: `${name} ${major}: not in the table, so its end-of-life date is unknown.` };
  }
  const left = Math.round((Date.parse(`${eol}T00:00:00Z`) - now) / 86400000);
  if (left < 0) {
    return { name, level: "expired", line: `${name} ${major}: out of support since ${eol}. Move to a supported line.` };
  }
  if (left <= WARN_DAYS) {
    return { name, level: "soon", line: `${name} ${major}: out of support on ${eol}, in ${left} days.` };
  }
  return { name, level: "ok", line: `${name} ${major}: supported until ${eol}.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const now = Date.now();

  const results = [
    checkEol("node (engines)", majorOf(pkg.engines?.node), NODE_EOL, now),
    checkEol("node (running)", majorOf(process.versions.node), NODE_EOL, now),
  ];

  for (const r of results) console.log(`eol: ${r.line}`);
  const expired = results.filter((r) => r.level === "expired");
  const unknown = results.filter((r) => r.level === "unknown");

  if (unknown.length) console.log("eol: add the line to NODE_EOL in scripts/eol.mjs, from nodejs.org.");
  if (expired.length) {
    console.error(`eol: ${expired.length} component${expired.length === 1 ? " is" : "s are"} past end of life.`);
    process.exit(1);
  }
  console.log("eol: nothing is running past the end of its support.");
}

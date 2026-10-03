/**
 * The layout suite, several sections at a time.
 *
 *   node scripts/layout.mjs [--jobs=4] [--only=budget,rules]
 *
 * The suite is fifty-eight independent sections, each opening its own browser
 * context and asserting against a preview build. Run end to end in one process
 * it takes long enough that no harness will hold the command open for it, so
 * it was run in three hand-written batches and the batches were kept in step
 * by hand. One section forgotten is a section nobody runs again.
 *
 * So the sections are the unit of work and this hands them out. A worker takes
 * the next one off the queue, runs it in its own process, and comes back for
 * another. Nothing has to be balanced because nothing is assigned in advance:
 * a section that takes a minute simply means that worker fetches fewer of
 * them.
 *
 * Each section already makes its own browser and its own contexts, so they do
 * not interfere; what they share is the preview server, which only serves
 * files.
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";

const arg = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

/**
 * How many at once.
 *
 * Each worker is a browser, so this is bounded by memory rather than by cores.
 * Four is comfortable on a laptop and on the machines this runs on; past that
 * the browsers start competing for the same preview server and the wins flatten.
 */
const JOBS = Math.max(1, Math.min(Number(arg("jobs", 0)) || 4, 12));
const ONLY = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean);

const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/breakpoints.mjs", ...args], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.on("close", (code) => resolve({ code, out, err }));
});

const listed = await run(["--list"]);
const all = listed.out.split("\n").map((s) => s.trim()).filter(Boolean);
if (!all.length) {
  console.error("Could not read the section list.", listed.err.split("\n")[0] ?? "");
  process.exit(1);
}
// Friendly here, exact in the worker: "--only=budget" should still mean every
// budget section, and each of those is then asked for by name.
const queue = ONLY.length ? all.filter((n) => ONLY.some((o) => n.includes(o))) : [...all];
if (!queue.length) {
  console.error(`Nothing matched --only=${ONLY.join(",")}. Known sections:\n  ${all.join("\n  ")}`);
  process.exit(1);
}

const started = Date.now();
const done = new Map();
let next = 0;
let failedToRun = 0;

const worker = async () => {
  for (;;) {
    const i = next++;
    const name = queue[i];
    if (!name) return;
    const at = Date.now();
    const { code, out, err } = await run([`--only=${name}`, "--exact"]);
    const lines = out.split("\n");
    const results = lines
      .map((l) => /^(PASS|FAIL)\s\s(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]);
    // A section that produced no checks at all is not a section that passed.
    // It is a crash, a rename, or a browser that would not start, and each of
    // those is silent otherwise.
    if (!results.length && code !== 0) {
      failedToRun += 1;
      results.push(["FAIL", `${name} — the section did not run. ${(err || out).split("\n").find(Boolean) ?? ""}`]);
    }
    done.set(name, { results, ms: Date.now() - at, code });
    const n = done.size;
    const bad = results.filter((r) => r[0] === "FAIL").length;
    process.stderr.write(`[${String(n).padStart(2)}/${queue.length}] ${name}${bad ? ` — ${bad} FAILED` : ""}\n`);
  }
};

await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, worker));

let passed = 0;
let failed = 0;
for (const name of queue) {
  for (const [state, text] of done.get(name)?.results ?? []) {
    if (state === "FAIL") { failed += 1; console.log(`FAIL  ${text}`); } else passed += 1;
  }
}

const slowest = [...done.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5);
console.log(`\nslowest: ${slowest.map(([n, d]) => `${n} ${(d.ms / 1000).toFixed(0)}s`).join(", ")}`);
if (ONLY.length) console.log(`ran ${queue.length} of ${all.length} sections`);
console.log(`${passed}/${passed + failed} passed in ${((Date.now() - started) / 1000).toFixed(0)}s across ${Math.min(JOBS, queue.length)} workers`);
process.exit(failed || failedToRun ? 1 : 0);

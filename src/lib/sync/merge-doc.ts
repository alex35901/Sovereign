import type { DB } from "../../types.js";

/**
 * Merging two copies of the budget that both moved.
 *
 * The rule used to be that the server's copy won and the other one was set
 * aside: a whole document, put in a drawer, with a line saying where to find
 * it. That is honest but it is not a merge. A forecast assumption changed on a
 * phone and a transaction categorised on a laptop are not a disagreement, and
 * treating them as one cost a household an evening's work and, later, a
 * provider's monthly allowance.
 *
 * So the two copies are compared against the one they both came from. Three
 * answers at every point:
 *
 *   - only one side moved it → that side's value, whichever side it is
 *   - both moved it the same way → that value
 *   - both moved it differently → the stored copy's, and it is reported
 *
 * The third is the only one that loses anything, and it is rare: it needs two
 * people to change the same field between the same two saves. Everything else
 * is kept, from both sides.
 *
 * What makes this safe to run on a document holding real money is that it
 * never invents a value. Every leaf of the result is a value one of the three
 * documents already held.
 */

export interface DocMerge {
  db: DB;
  /**
   * Where both sides moved the same thing, as paths a person can place.
   *
   * Short, and capped: this goes in a line of prose, and a reader who needs
   * the full list has both copies on two devices in front of them.
   */
  conflicts: string[];
  /** Whether anything of this browser's own survived into the result. */
  kept: boolean;
}

/** How many conflicting paths are worth carrying back to a sentence. */
const MAX_REPORTED = 6;

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep equality, written out rather than compared as JSON.
 *
 * Two devices build the same object through the same code and usually in the
 * same key order, which is what makes stringifying tempting and wrong: the one
 * time the orders differ, every field of an untouched record reads as changed
 * and the merge reports a conflict about nothing.
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (plain(a) && plain(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
  }
  // NaN is the only value that is not equal to itself, and a balance that is
  // NaN on both sides has not changed.
  return a !== a && b !== b;
}

/** What one id's record is called, for a path somebody has to read. */
const labelOf = (item: unknown, id: string): string => {
  if (plain(item)) {
    for (const key of ["name", "merchant", "question", "label"]) {
      const v = item[key];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
    }
  }
  return id;
};

/** The id a record is known by. Most carry `id`; a Plaid item carries its own. */
const idOf = (item: unknown): string | null => {
  if (!plain(item)) return null;
  for (const key of ["id", "itemId", "syncId", "key"]) {
    const v = item[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
};

interface Ctx {
  conflicts: string[];
  /** Set when a value from `mine` is taken, so the caller can say so. */
  kept: boolean;
}

const note = (ctx: Ctx, path: string): void => {
  if (ctx.conflicts.length < MAX_REPORTED && !ctx.conflicts.includes(path)) ctx.conflicts.push(path);
};

/**
 * One value, three versions.
 *
 * The order of the tests is the whole algorithm: agreement first, then the
 * side that moved, then the structures worth going inside, and only then the
 * last resort of preferring the stored copy.
 */
function mergeValue(path: string, base: unknown, mine: unknown, theirs: unknown, ctx: Ctx): unknown {
  if (same(mine, theirs)) return theirs;
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) { ctx.kept = true; return mine; }

  // The two places where a difference is arithmetic rather than opinion, and
  // where the general rule below would throw half the answer away.
  if (path === "settings/usage") { ctx.kept = true; return mergeMeters(path, base, mine, theirs, ctx); }
  if (path.startsWith("accounts/") && path.endsWith("/history")) {
    ctx.kept = true;
    return mergeHistory(base, mine, theirs);
  }

  // Both moved. Where the thing is made of parts, the disagreement is usually
  // not about the same part.
  if (plain(mine) && plain(theirs)) {
    return mergeObjects(path, plain(base) ? base : {}, mine, theirs, ctx);
  }
  if (Array.isArray(mine) && Array.isArray(theirs)) {
    return mergeArrays(path, Array.isArray(base) ? base : [], mine, theirs, ctx);
  }

  // A scalar both sides moved differently. The stored copy wins, because every
  // other device already has it and a merge that disagreed with them would
  // make a third version of the truth.
  note(ctx, path);
  return theirs;
}

function mergeObjects(
  path: string,
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
  for (const key of keys) {
    const inBase = Object.prototype.hasOwnProperty.call(base, key);
    const inMine = Object.prototype.hasOwnProperty.call(mine, key);
    const inTheirs = Object.prototype.hasOwnProperty.call(theirs, key);
    const at = path ? `${path}/${key}` : key;

    // A key one side removed. Removal is a change like any other: it stands
    // unless the other side changed what was there.
    if (inBase && (!inMine || !inTheirs)) {
      const kept = inMine ? mine[key] : theirs[key];
      if (!inMine && !inTheirs) continue;
      if (same(kept, base[key])) continue; // removed by one, untouched by the other
      note(ctx, at);
      if (inMine) ctx.kept = true;
      out[key] = kept;
      continue;
    }
    if (!inMine && !inTheirs) continue;
    if (!inBase && !inMine) { out[key] = theirs[key]; continue; }
    if (!inBase && !inTheirs) { ctx.kept = true; out[key] = mine[key]; continue; }

    const merged = mergeValue(at, base[key], mine[key], theirs[key], ctx);
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

/**
 * Two lists that both moved.
 *
 * Keyed where the records carry ids, which is every list in this document that
 * matters: transactions, accounts, categories, goals, rules. Then the question
 * is asked per record rather than per list, so two devices adding a
 * transaction each end up with both.
 *
 * A list of anything else is a value: a handful of strings or numbers whose
 * order is the content. Unioned when both sides added to it, because that is
 * what a list of keys or ids is for, and taken from the stored copy otherwise.
 */
function mergeArrays(path: string, base: unknown[], mine: unknown[], theirs: unknown[], ctx: Ctx): unknown[] {
  const keyed = [...base, ...mine, ...theirs].every((x) => idOf(x) !== null);
  if (!keyed) {
    const scalars = [...mine, ...theirs].every((x) => typeof x === "string" || typeof x === "number");
    if (scalars) {
      // Union, keeping the stored order first. Removing one and adding another
      // at the same time is two changes to a set, not a disagreement about it.
      const gone = new Set(base.filter((x) => !mine.includes(x) || !theirs.includes(x))
        .filter((x) => !mine.includes(x) && !theirs.includes(x)));
      const out: unknown[] = [];
      // Through a set rather than scanning the list each time: these are
      // short today and a list of keys is the kind of thing that grows.
      const held = new Set<unknown>();
      for (const x of [...theirs, ...mine]) {
        if (gone.has(x) || held.has(x)) continue;
        held.add(x);
        out.push(x);
      }
      ctx.kept = ctx.kept || out.length !== theirs.length;
      return out;
    }
    note(ctx, path);
    return theirs;
  }

  const byId = (list: unknown[]) => new Map(list.map((x) => [idOf(x)!, x]));
  const b = byId(base);
  const m = byId(mine);

  const out: unknown[] = [];
  const done = new Set<string>();
  // The stored copy is the spine, so rows keep the order every other device
  // sees them in, and anything added here is appended rather than woven in.
  for (const item of theirs) {
    const id = idOf(item)!;
    done.add(id);
    const at = `${path}/${labelOf(item, id)}`;
    if (!b.has(id)) {
      // New to both, with one id. Not something random ids produce; if it
      // happens, the stored copy is the one everybody else has.
      if (m.has(id) && !same(m.get(id), item)) note(ctx, at);
      out.push(item);
      continue;
    }
    if (!m.has(id)) {
      // Deleted here. It stands unless the other side changed it, in which
      // case the change is the thing that cannot be recovered and the deletion
      // is one press to repeat.
      if (same(b.get(id), item)) continue;
      note(ctx, at);
      out.push(item);
      continue;
    }
    out.push(mergeValue(at, b.get(id), m.get(id), item, ctx));
  }
  for (const item of mine) {
    const id = idOf(item)!;
    if (done.has(id)) continue;
    const at = `${path}/${labelOf(item, id)}`;
    if (!b.has(id)) { ctx.kept = true; out.push(item); continue; } // added here
    // Deleted on the stored copy. Same rule the other way round.
    if (same(b.get(id), m.get(id))) continue;
    note(ctx, at);
    ctx.kept = true;
    out.push(m.get(id));
  }
  return out;
}

/**
 * A provider's meter, where both sides counted.
 *
 * The one place in the document where the sides are not two opinions about a
 * value but two counts of real events: a lookup spent on a phone and one spent
 * on a laptop are two lookups, and the provider will say so. Taking either
 * side's number loses the other's, which is how a count of eighteen came to be
 * presented against a provider's forty-two.
 *
 * The same reasoning gives the rest: a period that has rolled over starts
 * again rather than taking the larger of two periods, the error is whatever
 * the later run saw, and the things seen are a set.
 */
function mergeMeters(path: string, base: unknown, mine: unknown, theirs: unknown, ctx: Ctx): unknown {
  if (!plain(mine) || !plain(theirs)) return mergeValue(path, base, mine, theirs, ctx);
  const b = plain(base) ? base : {};
  const out: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const a = mine[id];
    const c = theirs[id];
    if (!plain(a) || !plain(c)) { out[id] = c ?? a; continue; }
    if (a.period !== c.period) {
      // Different months: the later one is the live one, and the older is
      // spent history nobody reads.
      out[id] = String(a.period ?? "") > String(c.period ?? "") ? a : c;
      continue;
    }
    const seen = [...new Set([...(Array.isArray(a.seen) ? a.seen : []), ...(Array.isArray(c.seen) ? c.seen : [])])];
    const counted = Math.max(Number(a.count ?? 0), Number(c.count ?? 0));
    // Built field by field rather than merged generally, and nothing here is
    // reported: a meter is written by the app and never typed by anybody, so
    // two sides holding different counts is the normal state of a household
    // with two devices rather than a disagreement to tell them about.
    const later = String(a.at ?? "") >= String(c.at ?? "") ? a : c;
    out[id] = {
      ...mergeValue(`${path}/${id}`, plain(b[id]) ? b[id] : {}, a, c, { conflicts: [], kept: false }) as Record<string, unknown>,
      period: c.period,
      // Both counted real calls, so the larger number is the one that saw
      // more of them, and the set is the union of what each side saw.
      count: seen.length ? seen.length : counted,
      ...(seen.length ? { seen } : {}),
      ...(later.at === undefined ? {} : { at: later.at }),
      // The last word on whether it is working belongs to whichever ran last.
      ...(later.error === undefined ? {} : { error: later.error }),
    };
  }
  return out;
}

/**
 * A balance history, where both sides added a reading.
 *
 * One point per day, which is what the rest of the app assumes, so the two
 * lists are unioned by date with the stored copy's reading winning a day they
 * both wrote. Dropping one side's points would lose the chart's shape rather
 * than a figure, which is the kind of loss nobody notices until the line looks
 * wrong a year later.
 */
function mergeHistory(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (!Array.isArray(mine) || !Array.isArray(theirs)) return theirs;
  const dropped = new Set(
    (Array.isArray(base) ? base : [])
      .filter((p) => plain(p) && !mine.some((q) => plain(q) && q.date === p.date)
        && !theirs.some((q) => plain(q) && q.date === p.date))
      .map((p) => (p as { date: string }).date),
  );
  const byDate = new Map<string, unknown>();
  for (const p of [...mine, ...theirs]) {
    if (!plain(p) || typeof p.date !== "string" || dropped.has(p.date)) continue;
    byDate.set(p.date, p);
  }
  return [...byDate.values()].sort((x, y) =>
    String((x as { date: string }).date).localeCompare(String((y as { date: string }).date)));
}

/**
 * The two copies, settled.
 *
 * `theirs` is the stored document and `mine` is what this browser is holding;
 * `base` is the version this browser last agreed with the server about, which
 * is what makes the difference between "changed" and "different" knowable.
 */
export function mergeDocs(base: DB, mine: DB, theirs: DB): DocMerge {
  const ctx: Ctx = { conflicts: [], kept: false };
  const merged = mergeObjects(
    "",
    base as unknown as Record<string, unknown>,
    mine as unknown as Record<string, unknown>,
    theirs as unknown as Record<string, unknown>,
    ctx,
  ) as unknown as DB;

  // The schema's own number is never a disagreement: a browser running an
  // older bundle must not pull the document back to a shape the other one has
  // already migrated away from.
  merged.version = Math.max(base.version ?? 0, mine.version ?? 0, theirs.version ?? 0);

  return { db: merged, conflicts: ctx.conflicts, kept: ctx.kept };
}

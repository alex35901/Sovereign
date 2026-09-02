import { useMemo, useState } from "react";
import { AlertTriangle, Check, FileInput, Info } from "lucide-react";
import { useDB, useStore } from "../store";
import { duplicatesOf, parseMonarchRules } from "../lib/rules-import";
import type { ParsedRule } from "../lib/rules-import";
import { Btn, Card, CardHead, Toggle } from "../components/ui";

/**
 * Bringing a set of rules over from Monarch.
 *
 * Their export is prose — "If merchant name exactly matches fair oaks farms" —
 * so the whole design here is: read it, show exactly what was understood, and
 * create nothing until someone has looked. A hundred rules imported with six
 * quietly dropped is the bad outcome, because the six only surface months later
 * as transactions in the wrong category.
 */

const VERB: Record<string, string> = {
  exact: "is exactly", contains: "contains", starts: "starts with", ends: "ends with",
};

const money = (n: number): string =>
  `$${(n / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** The amount and direction part of a rule, in words. */
function criteriaTail(r: ParsedRule): string {
  const bits: string[] = [];
  if (r.amountMin !== undefined && r.amountMin === r.amountMax) bits.push(`exactly ${money(r.amountMin)}`);
  else if (r.amountMin !== undefined && r.amountMax !== undefined) bits.push(`${money(r.amountMin)}–${money(r.amountMax)}`);
  else if (r.amountMin !== undefined) bits.push(`over ${money(r.amountMin)}`);
  else if (r.amountMax !== undefined) bits.push(`under ${money(r.amountMax)}`);
  if (r.direction === "in") bits.push("money in");
  if (r.direction === "out") bits.push("money out");
  return bits.join(", ");
}

export function ImportRules() {
  const db = useDB();
  const { actions, notify } = useStore();
  const [text, setText] = useState("");
  const [backfill, setBackfill] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  const parsed = useMemo(
    () => (text.trim() ? parseMonarchRules(text, db.categories, db.tags) : null),
    [text, db.categories, db.tags],
  );
  const dupes = useMemo(
    () => (parsed ? duplicatesOf(parsed.rules, db.rules) : new Set<number>()),
    [parsed, db.rules],
  );

  const ready = parsed?.rules.filter((r) => r.categoryId && !dupes.has(r.line)) ?? [];
  const unmapped = parsed?.rules.filter((r) => !r.categoryId) ?? [];
  const skipped = parsed?.rules.filter((r) => r.categoryId && dupes.has(r.line)) ?? [];
  // Only tags the rules actually being imported ask for — a tag named only by
  // a rule that is being skipped should not be created for nothing.
  const newTags = [...new Set(ready.flatMap((r) => r.tags))]
    .filter((t) => !db.tags.some((x) => x.name.toLowerCase() === t.toLowerCase()));

  const run = () => {
    const n = ready.length;
    const tags = newTags.length;
    actions.importRules(ready, backfill);
    setDone(n);
    setText("");
    notify(`Imported ${n} rule${n === 1 ? "" : "s"}${tags ? `, and made ${tags} tag${tags === 1 ? "" : "s"}` : ""}.`);
  };

  return (
    <Card>
      <CardHead
        title="Import rules from Monarch"
        sub="Paste the exported rules — one per line"
      />

      <div className="col" style={{ gap: 12 }}>
        <div className="tiny faint" style={{ maxWidth: 640 }}>
          Copy the rules straight out of Monarch&rsquo;s export and paste them below. Each becomes a rule
          that sets the category and marks the transaction reviewed. Nothing is created until you press
          Import, and everything that could not be read is listed first.
        </div>

        <textarea
          className="input"
          rows={7}
          spellCheck={false}
          placeholder={"If merchant name exactly matches fair oaks farms\tRecategorize to 🍽 Restaurants & Bars"}
          value={text}
          onChange={(e) => { setText(e.target.value); setDone(null); }}
          style={{ fontFamily: "var(--mono, monospace)", fontSize: 12, resize: "vertical", width: "100%" }}
        />

        {done !== null ? (
          <div className="setting-row" style={{ borderColor: "var(--pos)", background: "var(--pos-soft)" }}>
            <span className="small">
              <b>{done} rule{done === 1 ? "" : "s"} imported.</b>{" "}
              They are in the list below, and one undo takes all of them back out again.
            </span>
          </div>
        ) : null}

        {parsed ? (
          <>
            <div className="row wrap" style={{ gap: 14 }}>
              <span className="small pos row" style={{ gap: 6 }}>
                <Check size={14} /> {ready.length} ready to import
              </span>
              {unmapped.length ? (
                <span className="small neg row" style={{ gap: 6 }}>
                  <AlertTriangle size={14} /> {unmapped.length} with no matching category
                </span>
              ) : null}
              {parsed.problems.length ? (
                <span className="small neg row" style={{ gap: 6 }}>
                  <AlertTriangle size={14} /> {parsed.problems.length} not understood
                </span>
              ) : null}
              {skipped.length ? (
                <span className="small muted row" style={{ gap: 6 }}>
                  <Info size={14} /> {skipped.length} already here
                </span>
              ) : null}
            </div>

            {newTags.length ? (
              <div className="setting-row">
                <span className="small">
                  <b>{newTags.length} new tag{newTags.length === 1 ? "" : "s"} will be created:</b>{" "}
                  {newTags.join(", ")}. Tags are just labels, so these are made as part of the import —
                  unlike a category, which carries a budget and has to be set up deliberately.
                </span>
              </div>
            ) : null}

            {parsed.unknownCategories.length ? (
              <div className="setting-row" style={{ borderColor: "var(--neg)", background: "var(--neg-soft)" }}>
                <span className="small">
                  <b>No category here is called:</b> {parsed.unknownCategories.join(", ")}.{" "}
                  Create them under Categories first and paste again, or those rules will be left out — a
                  rule pointing at no category would match transactions and then do nothing to them.
                </span>
              </div>
            ) : null}

            {parsed.problems.length ? (
              <div className="col" style={{ gap: 6 }}>
                <div className="tiny faint">Lines that could not be read</div>
                {parsed.problems.slice(0, 40).map((p) => (
                  <div key={p.line} className="small" style={{ display: "flex", gap: 8 }}>
                    <span className="faint num" style={{ flex: "none", width: 34, textAlign: "right" }}>{p.line}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="neg">{p.why}</span>{" "}
                      <span className="faint truncate" style={{ display: "block" }}>{p.raw}</span>
                    </span>
                  </div>
                ))}
                {parsed.problems.length > 40 ? (
                  <div className="tiny faint">…and {parsed.problems.length - 40} more.</div>
                ) : null}
              </div>
            ) : null}

            {parsed.rules.length ? (
              <div className="col" style={{ gap: 0 }}>
                <div className="tiny faint" style={{ marginBottom: 6 }}>What will be created</div>
                <div className="card flush" style={{ maxHeight: 320, overflowY: "auto" }}>
                  {parsed.rules.map((r) => {
                    const cat = db.categories.find((c) => c.id === r.categoryId);
                    const dup = dupes.has(r.line);
                    return (
                      <div key={r.line} className="list-row" style={{ opacity: cat && !dup ? 1 : 0.55 }}>
                        <span className="tiny faint num" style={{ width: 34, flex: "none", textAlign: "right" }}>{r.line}</span>
                        <span className="grow truncate small" style={{ minWidth: 0 }}>
                          {r.merchant ? (
                            <>Merchant <span className="faint">{VERB[r.match]}</span> <b>{r.merchant}</b></>
                          ) : null}
                          {criteriaTail(r) ? (
                            <span className="faint">{r.merchant ? " · " : ""}{criteriaTail(r)}</span>
                          ) : null}
                        </span>
                        {r.tags.map((t) => (
                          <span key={t} className="tag" style={{ flex: "none" }}>{t}</span>
                        ))}
                        {cat ? (
                          <span
                            className="chip" style={{
                              background: `color-mix(in srgb, var(${cat.color}) 15%, transparent)`,
                              borderColor: "transparent", color: `var(${cat.color})`, fontWeight: 500,
                            }}
                          >
                            {cat.icon} {cat.name}
                          </span>
                        ) : (
                          <span className="chip neg">{r.categoryName} — not found</span>
                        )}
                        {dup ? <span className="tiny faint" style={{ flex: "none" }}>already here</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="setting-row">
              <Toggle
                on={backfill}
                onChange={setBackfill}
                label={<span className="small">Also apply these to transactions already here</span>}
              />
            </div>
            <div className="tiny faint" style={{ maxWidth: 640, marginTop: -6 }}>
              {backfill
                ? `Off by default because it is the bigger action: every one of your ${db.transactions.length.toLocaleString()} transactions will be re-categorised where a rule matches, and marked reviewed. One undo takes it all back.`
                : "Left off, these apply only to transactions that arrive from here on — which is what Monarch's rules were doing."}
            </div>

            <div className="row wrap" style={{ gap: 8 }}>
              <Btn variant="primary" onClick={run} disabled={!ready.length}>
                <FileInput size={14} /> Import {ready.length} rule{ready.length === 1 ? "" : "s"}
              </Btn>
              <Btn onClick={() => { setText(""); setDone(null); }}>Clear</Btn>
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

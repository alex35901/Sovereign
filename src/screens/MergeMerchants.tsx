import { useMemo, useState } from "react";
import { Merge } from "lucide-react";
import { useStore } from "../store";
import { MIN_MATCH, checkMerge, suggestName } from "../lib/merchant-merge";
import type { MergeRow } from "../lib/merchant-merge";
import { Btn, Field, Modal, TextInput, cx } from "../components/ui";

/**
 * Folding several spellings of one shop into a single merchant.
 *
 * Done as a rule rather than as a hidden alias table, because a rule already
 * does all of it: renames on the way in, runs back over what is already held,
 * and stays visible under Rules afterwards to be edited or undone. The thing
 * worth building here is not the renaming, it is being able to see what a rule
 * pointed at every transaction in the document would actually do first.
 */
export function MergeMerchants({ rows, all, match, onClose }: {
  /** The merchants the search turned up, which is what will be merged. */
  rows: MergeRow[];
  /** Every merchant, for working out what else the rule would catch. */
  all: MergeRow[];
  /** What was searched for, which is the obvious first guess at the match. */
  match: string;
  onClose: () => void;
}) {
  const { actions, notify } = useStore();
  const [picked, setPicked] = useState<string[]>(() => rows.map((r) => r.name));
  const [keep, setKeep] = useState(() => suggestName(rows));
  const [text, setText] = useState(match.trim());
  const [busy, setBusy] = useState(false);

  const chosen = useMemo(() => rows.filter((r) => picked.includes(r.name)), [rows, picked]);
  const check = useMemo(() => checkMerge(all, chosen, text, keep), [all, chosen, text, keep]);
  const enough = chosen.length >= 2 && keep.trim().length > 0 && text.trim().length >= MIN_MATCH;

  const toggle = (name: string) =>
    setPicked((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const run = () => {
    setBusy(true);
    // Saved and back-filled in one step, so one undo puts back both the rule
    // and every transaction it rewrote.
    actions.addRule({
      name: `Combine into ${keep.trim()}`,
      enabled: true,
      criteria: { merchantContains: text.trim(), merchantMatch: "contains" },
      actions: { renameMerchant: keep.trim() },
    }, true);
    notify(`${chosen.length} merchants combined into ${keep.trim()}. The rule is under Rules if you want to change it.`);
    onClose();
  };

  return (
    <Modal
      title="Combine into one merchant"
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={run} disabled={!enough || busy}>
            <Merge size={14} /> Combine {chosen.length}
          </Btn>
        </>
      }
    >
      <div className="small muted">
        These become one merchant, in what is already here and in whatever arrives later. A bill that
        turns up under any of these names is then the same recurring bill, so it is ticked off
        whichever spelling the bank happens to send.
      </div>

      <div className="col" style={{ gap: 6, marginTop: 12 }}>
        {rows.map((r) => (
          <label key={r.name} className="spread click" style={{ gap: 10, cursor: "pointer" }}>
            <span className="row" style={{ gap: 9, minWidth: 0 }}>
              <input
                type="checkbox" className="cb"
                checked={picked.includes(r.name)}
                onChange={() => toggle(r.name)}
              />
              <span className="truncate">{r.name}</span>
            </span>
            <span className="row" style={{ gap: 10 }}>
              <span className="tiny faint nowrap">
                {r.count.toLocaleString()} txn{r.count === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className={cx("btn btn-sm", keep === r.name && "btn-primary")}
                onClick={(e) => { e.preventDefault(); setKeep(r.name); }}
                title="Keep this name"
              >
                {keep === r.name ? "Keeping" : "Keep"}
              </button>
            </span>
          </label>
        ))}
      </div>

      <div className="divider" />

      <Field label="Name to keep">
        <TextInput value={keep} onChange={setKeep} placeholder="Cooper's Hawk" />
      </Field>
      <Field label="Match transactions containing">
        <TextInput value={text} onChange={setText} placeholder="cooper" />
      </Field>

      {/* What a rule pointed at every transaction in the document would
          actually do, before it does it. */}
      <div className={cx("small", check.clean ? "muted" : "warn")} style={{ marginTop: 10 }}>
        {check.warning
          ?? `Renames ${check.moving.toLocaleString()} transaction${check.moving === 1 ? "" : "s"} now, `
            + `and anything containing "${text.trim()}" from now on.`}
      </div>
    </Modal>
  );
}

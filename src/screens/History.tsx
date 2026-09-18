import { useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Undo2 } from "lucide-react";
import type { DB, ID } from "../types";
import { useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { Btn, Card, CardHead, ConfirmButton, Empty } from "../components/ui";
import type { LoggedAction, RowChange, TableName } from "../lib/changelog";
import { actionSize, actionSummary, fieldName } from "../lib/changelog";
import { eventWhen } from "../lib/activity";
import { fmt } from "../lib/money";
import { dateLabel } from "../lib/date";

/** How many changed rows to list before saying how many more there are. */
const SHOWN = 12;

/** One stored value, said out loud in whatever terms that field is kept in. */
function value(db: DB, key: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (key === "categoryId") return db.categories.find((c) => c.id === v)?.name ?? "a deleted category";
  if (key === "accountId") return db.accounts.find((a) => a.id === v)?.name ?? "a deleted account";
  if (key === "groupId") return db.groups.find((g) => g.id === v)?.name ?? "a deleted group";
  if (key === "amount" || key === "balance" || key === "targetAmount") return fmt(Number(v));
  if (key === "date" || key === "nextDate") return dateLabel(String(v), { year: true });
  if (key === "tags") {
    const names = (v as ID[]).map((id) => db.tags.find((t) => t.id === id)?.name).filter(Boolean);
    return names.length ? names.join(", ") : "none";
  }
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return "changed";
  return String(v);
}

/** What a changed row is called, so a line reads as the thing it happened to. */
function rowName(db: DB, table: TableName, id: ID): string {
  const rows = (db[table] ?? []) as unknown as { id: ID; name?: string; merchant?: string; ticker?: string }[];
  const row = rows.find((r) => r.id === id);
  if (!row) return "a deleted row";
  return row.merchant ?? row.name ?? row.ticker ?? id;
}

function ChangeLine({ db, table, change }: { db: DB; table: TableName; change: RowChange }) {
  const fields = Object.keys(change.after);
  return (
    <div className="hist-line">
      <span className="hist-line-name">{rowName(db, table, change.id)}</span>
      <span className="tiny faint">
        {fields.map((f) => `${fieldName(f)}: ${value(db, f, change.before[f])} → ${value(db, f, change.after[f])}`).join(" · ")}
      </span>
    </div>
  );
}

function Detail({ db, action }: { db: DB; action: LoggedAction }) {
  if (action.tooBig) {
    return (
      <div className="hist-detail">
        <span className="tiny faint">
          This one replaced the whole document, so there was too much of it to keep a way back.
        </span>
      </div>
    );
  }
  return (
    <div className="hist-detail">
      {action.tables.map((t) => {
        const extra = t.changed.length - SHOWN;
        return (
          <div key={t.table} className="col" style={{ gap: 4 }}>
            {t.added.length ? <span className="tiny faint">{t.added.length} added</span> : null}
            {t.removed.length ? <span className="tiny faint">{t.removed.length} deleted</span> : null}
            {t.changed.slice(0, SHOWN).map((c) => (
              <ChangeLine key={c.id} db={db} table={t.table} change={c} />
            ))}
            {extra > 0 ? <span className="tiny faint">and {extra.toLocaleString()} more</span> : null}
          </div>
        );
      })}
      {action.budgets.length ? (
        <span className="tiny faint">
          {action.budgets.length} budget amount{action.budgets.length === 1 ? "" : "s"} changed
        </span>
      ) : null}
    </div>
  );
}

function Row({ db, action, onRevert }: { db: DB; action: LoggedAction; onRevert: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="hist-row">
      <button className="hist-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={15} className="faint" /> : <ChevronRight size={15} className="faint" />}
        <div className="col" style={{ gap: 1, minWidth: 0 }}>
          <span className="hist-label">{action.label}</span>
          <span className="tiny faint">
            {eventWhen(action.at)}
            {/* A label worked out from the change already counts what it
                touched, so saying it twice would be noise. */}
            {action.auto ? "" : ` · ${actionSummary(action)}`}
          </span>
        </div>
      </button>
      {action.revertedAt || action.tooBig ? (
        <span className="tiny faint hist-done">
          {action.revertedAt ? "Put back" : "Too big to undo"}
        </span>
      ) : (
        <Btn size="sm" onClick={onRevert} title={`Put back ${actionSize(action).toLocaleString()} changes`}>
          <Undo2 size={14} /> <span className="btn-label">Put it back</span>
        </Btn>
      )}
      {open ? <Detail db={db} action={action} /> : null}
    </div>
  );
}

/**
 * Every change made in this browser, and a way to take one of them back.
 *
 * The undo toast only lasts a few seconds, and a whole-document undo stack can
 * only unwind in order — so a rule run over every transaction, noticed an hour
 * later, had no way back that did not also throw away the hour. Here an undo
 * is a patch: it puts back only the fields that action moved, and only where
 * they still hold the value it left, so anything edited since survives it and
 * is counted out loud instead.
 *
 * Kept on this device, like the undo stack itself. It is a list of edits made
 * in this browser, not part of the document, so it does not sync and a fresh
 * browser starts with an empty one.
 */
export default function History() {
  const { db, log, revertAction, forgetHistory } = useStore();

  return (
    <>
      <TopBar
        title="History"
        primary={log.length ? <ConfirmButton label="Clear" confirmLabel="Clear history" variant="default" onConfirm={forgetHistory} /> : undefined}
      />
      <div className="page stack">
        <Card>
          <CardHead
            title="Recent changes"
            sub="Newest first. Putting one back changes only what it touched, so anything edited since stays as it is."
          />
          {log.length ? (
            <div className="hist-list">
              {log.map((a) => (
                <Row key={a.id} db={db} action={a} onRevert={() => revertAction(a.id)} />
              ))}
            </div>
          ) : (
            <Empty
              title="Nothing yet"
              body="Every change made in this browser lands here, so you can take one back long after the undo message has gone."
            />
          )}
        </Card>
        <p className="tiny faint" style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <RotateCcw size={13} style={{ flex: "none", marginTop: 2 }} />
          <span>
            This list is kept in this browser and is not part of your synced document. Changes made on another device do not
            appear here, and clearing your browser data clears it.
          </span>
        </p>
      </div>
    </>
  );
}

import { useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { useDB, useStore } from "../store";
import type { ColumnRole } from "../lib/csv";
import { buildPlan, guessColumns, parseCSV, rowsToTransactions } from "../lib/csv";
import { Btn, Card, Field, Modal, Money, SelectInput, Toggle } from "../components/ui";
import { dateLabel } from "../lib/date";

const ROLES: { value: ColumnRole; label: string }[] = [
  { value: "ignore", label: "— ignore —" },
  { value: "date", label: "Date" },
  { value: "merchant", label: "Merchant / description" },
  { value: "amount", label: "Amount (signed)" },
  { value: "debit", label: "Debit / outflow" },
  { value: "credit", label: "Credit / inflow" },
  { value: "category", label: "Category" },
  { value: "notes", label: "Notes / memo" },
  { value: "account", label: "Account name" },
];

/** Three-step CSV import: pick a file, confirm the column mapping, review the plan. */
export function ImportModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const { actions, notify } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<string[][] | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [roles, setRoles] = useState<ColumnRole[]>([]);
  const [accountId, setAccountId] = useState(db.accounts[0]?.id ?? "");
  const [flipSign, setFlipSign] = useState(false);
  const [fileName, setFileName] = useState("");

  const read = async (file: File) => {
    const text = await file.text();
    const parsed = parseCSV(text);
    if (!parsed.length) return;
    setFileName(file.name);
    setRows(parsed);
    setRoles(guessColumns(parsed[0]));
  };

  const body = useMemo(() => (rows ? (hasHeader ? rows.slice(1) : rows) : []), [rows, hasHeader]);
  const plan = useMemo(() => {
    if (!rows || !accountId) return null;
    return buildPlan(body, roles, { flipSign, accountId, existing: db.transactions });
  }, [rows, body, roles, flipSign, accountId, db.transactions]);

  const commit = () => {
    if (!plan || !accountId) return;
    const txns = rowsToTransactions(db, plan, accountId);
    actions.addTransactions(txns);
    notify(`Imported ${txns.length} transaction${txns.length === 1 ? "" : "s"}${plan.duplicates ? `, skipped ${plan.duplicates} duplicate${plan.duplicates === 1 ? "" : "s"}` : ""}.`);
    onClose();
  };

  return (
    <Modal
      wide
      title="Import transactions"
      onClose={onClose}
      footer={
        <>
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!plan?.rows.length} onClick={commit}>
            Import {plan?.rows.length ?? 0} transaction{plan?.rows.length === 1 ? "" : "s"}
          </Btn>
        </>
      }
    >
      {!rows ? (
        <div
          className="col center"
          style={{ border: "1.5px dashed var(--line)", borderRadius: 12, padding: 34, alignItems: "center", gap: 10 }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void read(f); }}
        >
          <FileUp size={26} className="muted" />
          <div className="center">
            <div className="bold">Drop a CSV here</div>
            <div className="small muted">Exports from Monarch, Mint, YNAB or any bank work.</div>
          </div>
          <Btn variant="primary" onClick={() => fileRef.current?.click()}>Choose file</Btn>
          <input
            ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }}
          />
        </div>
      ) : (
        <>
          <div className="row wrap" style={{ gap: 12 }}>
            <Field label="Import into account">
              <SelectInput
                value={accountId} onChange={setAccountId}
                options={db.accounts.map((a) => ({ value: a.id, label: `${a.name} · ${a.institution}` }))}
              />
            </Field>
            <div className="col" style={{ gap: 9, paddingTop: 18 }}>
              <Toggle on={hasHeader} onChange={setHasHeader} label={<span className="small">First row is a header</span>} />
              <Toggle on={flipSign} onChange={setFlipSign} label={<span className="small">Flip signs (spending is positive in this file)</span>} />
            </div>
          </div>

          <div className="col" style={{ gap: 6 }}>
            <span className="small muted">{fileName} · map the columns</span>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    {(rows[0] ?? []).map((h, i) => (
                      <th key={i} style={{ minWidth: 140 }}>
                        <SelectInput
                          value={roles[i] ?? "ignore"}
                          onChange={(v) => setRoles((prev) => prev.map((r, j) => (j === i ? (v as ColumnRole) : r)))}
                          options={ROLES}
                        />
                        <div className="tiny faint truncate" style={{ marginTop: 4 }}>{hasHeader ? h : `Column ${i + 1}`}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.slice(0, 3).map((r, i) => (
                    <tr key={i}>{r.map((c, j) => <td key={j} className="tiny truncate" style={{ maxWidth: 170 }}>{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {plan ? (
            <Card>
              <div className="row wrap" style={{ gap: 20 }}>
                <div className="col"><span className="tile-label">Ready</span><span className="bold num">{plan.rows.length}</span></div>
                <div className="col"><span className="tile-label">Duplicates skipped</span><span className="bold num">{plan.duplicates}</span></div>
                <div className="col"><span className="tile-label">Unparseable rows</span><span className="bold num">{plan.skipped}</span></div>
                <div className="col grow">
                  <span className="tile-label">Net</span>
                  <Money value={plan.rows.reduce((s, r) => s + r.amount, 0)} colored className="bold" />
                </div>
              </div>
              {plan.rows.length ? (
                <>
                  <div className="divider" />
                  <div className="col" style={{ gap: 5 }}>
                    {plan.rows.slice(0, 5).map((r, i) => (
                      <div key={i} className="spread small">
                        <span className="faint" style={{ width: 70 }}>{dateLabel(r.date)}</span>
                        <span className="grow truncate">{r.merchant}</span>
                        <Money value={r.amount} colored />
                      </div>
                    ))}
                    {plan.rows.length > 5 ? <span className="tiny faint">+ {plan.rows.length - 5} more</span> : null}
                  </div>
                </>
              ) : (
                <div className="small neg" style={{ marginTop: 8 }}>
                  Nothing to import — check that a Date column and an Amount (or Debit/Credit) column are mapped.
                </div>
              )}
            </Card>
          ) : null}
        </>
      )}
    </Modal>
  );
}

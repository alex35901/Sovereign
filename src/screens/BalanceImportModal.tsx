import { useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import type { Account } from "../types";
import { useStore } from "../store";
import type { BalanceRole } from "../lib/balance-csv";
import { buildBalancePlan, defaultNegate, guessBalanceColumns, readBalanceCSV } from "../lib/balance-csv";
import { dateLabel, monthLabel, monthOf } from "../lib/date";
import { AreaChart } from "../components/charts";
import { Btn, Card, Field, Modal, Money, SelectInput, Toggle } from "../components/ui";

const ROLES: { value: BalanceRole; label: string }[] = [
  { value: "ignore", label: "— ignore —" },
  { value: "date", label: "Date" },
  { value: "balance", label: "Balance" },
  { value: "account", label: "Account / property" },
];

/** Loads a dated balance series onto one account's history. */
export function BalanceImportModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const { actions, notify } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<string[][] | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [roles, setRoles] = useState<BalanceRole[]>([]);
  const [fileName, setFileName] = useState("");
  const [negate, setNegate] = useState(defaultNegate(account.type));
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [label, setLabel] = useState("");

  const read = async (file: File) => {
    const parsed = readBalanceCSV(await file.text());
    if (!parsed.rows.length) return;
    setFileName(file.name);
    setHeader(parsed.header);
    setRows(parsed.rows);
    setRoles(guessBalanceColumns(parsed.header));
    setLabel("");
  };

  const plan = useMemo(
    () => (rows ? buildBalancePlan(rows, roles, { negate, accountLabel: label || undefined }) : null),
    [rows, roles, negate, label],
  );

  // Merging keeps whatever is already on the account, so an existing snapshot
  // dated after the file still decides the current balance. Say so rather than
  // letting it look like the import was ignored.
  const newestExisting = account.history[account.history.length - 1];
  const staleImport =
    mode === "merge" && plan?.last && newestExisting && newestExisting.date > plan.last.date
      ? newestExisting
      : null;

  const commit = () => {
    if (!plan?.points.length) return;
    actions.importBalanceHistory(account.id, plan.points, mode);
    notify(`Imported ${plan.points.length} balance points into ${account.name}.`);
    onClose();
  };

  return (
    <Modal
      wide
      title={`Import balance history — ${account.name}`}
      onClose={onClose}
      footer={
        <>
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={!plan?.points.length} onClick={commit}>
            Import {plan?.points.length ?? 0} point{plan?.points.length === 1 ? "" : "s"}
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
            <div className="bold">Drop a balance history CSV</div>
            <div className="small muted">
              A Date column and a Balance column is all it needs — daily, monthly, or occasional rows.
            </div>
          </div>
          <Btn variant="primary" onClick={() => fileRef.current?.click()}>Choose file</Btn>
          <input
            ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }}
          />
        </div>
      ) : (
        <>
          <div className="col" style={{ gap: 6 }}>
            <span className="small muted">{fileName} · map the columns</span>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    {header.map((h, i) => (
                      <th key={i} style={{ minWidth: 150 }}>
                        <SelectInput
                          value={roles[i] ?? "ignore"}
                          onChange={(v) => setRoles((prev) => prev.map((r, j) => (j === i ? (v as BalanceRole) : r)))}
                          options={ROLES}
                        />
                        <div className="tiny faint truncate" style={{ marginTop: 4 }}>{h}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 2).map((r, i) => (
                    <tr key={i}>{r.map((c, j) => <td key={j} className="tiny truncate" style={{ maxWidth: 190 }}>{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="row wrap" style={{ gap: 18 }}>
            <Field label="If the file already covers a date">
              <SelectInput
                value={mode} onChange={(v) => setMode(v as "merge" | "replace")}
                options={[
                  { value: "merge", label: "Keep existing points, add these" },
                  { value: "replace", label: "Replace this account's history" },
                ]}
              />
            </Field>
            {plan && plan.accountLabels.length > 1 ? (
              <Field label="Which account in the file?">
                <SelectInput
                  value={label} onChange={setLabel} placeholder="All rows"
                  options={plan.accountLabels.map((l) => ({ value: l, label: l }))}
                />
              </Field>
            ) : null}
            <div style={{ paddingTop: 20 }}>
              <Toggle
                on={negate} onChange={setNegate}
                label={<span className="small">Values are amounts owed (store as debt)</span>}
              />
            </div>
          </div>

          {plan ? (
            <Card>
              <div className="row wrap" style={{ gap: 22 }}>
                <div className="col"><span className="tile-label">Rows read</span><span className="bold num">{plan.rowsRead.toLocaleString()}</span></div>
                <div className="col">
                  <span className="tile-label">Points kept</span>
                  <span className="bold num">{plan.points.length.toLocaleString()}</span>
                </div>
                {plan.first && plan.last ? (
                  <>
                    <div className="col">
                      <span className="tile-label">Range</span>
                      <span className="small">{dateLabel(plan.first.date, { year: true })} → {dateLabel(plan.last.date, { year: true })}</span>
                    </div>
                    <div className="col">
                      <span className="tile-label">Start → end</span>
                      <span className="small num">
                        <Money value={plan.first.balance} cents={false} /> → <Money value={plan.last.balance} cents={false} />
                      </span>
                    </div>
                  </>
                ) : null}
                {plan.skipped ? (
                  <div className="col"><span className="tile-label">Unreadable rows</span><span className="bold num">{plan.skipped}</span></div>
                ) : null}
              </div>

              {plan.points.length > 1 ? (
                <>
                  <div className="divider" />
                  <span className="tiny faint">
                    Repeated days are dropped — balances carry forward on the chart, so only the changes are stored.
                  </span>
                  <AreaChart
                    height={150}
                    tone="--c2"
                    points={plan.points.map((p) => ({
                      label: monthLabel(monthOf(p.date), true),
                      value: p.balance,
                      sub: dateLabel(p.date, { year: true }),
                    }))}
                  />
                </>
              ) : null}

              {staleImport ? (
                <div className="small muted" style={{ marginTop: 10 }}>
                  This account already has a point from {dateLabel(staleImport.date, { year: true })} of{" "}
                  <Money value={staleImport.balance} cents={false} />, which is newer than the last row in this file.
                  The history will fill in behind it, but the current balance stays where it is — choose{" "}
                  <b>Replace this account's history</b> if the file should win.
                </div>
              ) : null}

              {!plan.points.length ? (
                <div className="small neg" style={{ marginTop: 8 }}>
                  Nothing to import — check that a Date column and a Balance column are mapped.
                </div>
              ) : null}
            </Card>
          ) : null}
        </>
      )}
    </Modal>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, RefreshCw } from "lucide-react";
import type { Settings } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { PERIOD_LABEL, healthOf, integrations } from "../lib/integrations";
import type { Health, Integration } from "../lib/integrations";
import { hopperMeter } from "../lib/hopper/loop";
import type { HopperMeter } from "../lib/hopper/loop";
import { refreshPrices } from "../lib/prices";
import { syncPlaid, syncSimplefin } from "../lib/sync";
import { estimateHomeValue, canValue } from "../lib/property";
import { reason, recordRun } from "../lib/usage";
import { Btn, Card, CardHead, TextInput, Toggle } from "../components/ui";

/**
 * One table for every provider this app talks to.
 *
 * It exists because the interesting question about an integration is never
 * "is it configured" — it is "how much of the free tier is left, and did the
 * last run work". Those were previously spread across five cards, each
 * explaining its own signup, and the answer to the only question worth asking
 * was in none of them.
 *
 * Every allowance here is measured in a different thing over a different
 * period — institutions that never reset, lookups that reset monthly,
 * questions that reset at midnight — so the row carries its own unit and the
 * table prints what the row says rather than assuming they are all calls.
 */

const TONE: Record<Health, string> = {
  ok: "var(--pos)",
  warn: "var(--accent)",
  down: "var(--neg)",
  off: "var(--faint)",
};

const when = (iso: string | undefined): string => {
  if (!iso) return "never";
  const day = iso.slice(0, 10);
  return day === new Date().toISOString().slice(0, 10) ? "today" : dateLabel(day, { year: true });
};

export function IntegrationsCard() {
  const db = useDB();
  const { actions, apply, notify } = useStore();
  const [meter, setMeter] = useState<HopperMeter | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read once on open. It costs no tokens, and nothing here changes often
  // enough to be worth polling.
  useEffect(() => { void hopperMeter().then(setMeter); }, []);

  const rows = useMemo(() => integrations(db, meter && meter.configured
    ? { messages: meter.spend?.messages ?? 0, limit: meter.limit }
    : null), [db, meter]);

  const run = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      if (id === "simplefin") notify((await syncSimplefin(db, apply)).summary);
      if (id === "plaid") {
        const out = await syncPlaid(db, apply);
        notify(out.summary);
        if (out.errors.length) setError(out.errors.join(" · "));
      }
      if (id === "tiingo") { await refreshPrices(db, apply, "refresh prices"); notify("Prices refreshed."); }
      if (id === "rentcast") await valueProperties();
    } catch (err) {
      setError(reason(err, "That refresh failed."));
    } finally {
      setBusy(null);
    }
  };

  /** Every property with an address, one lookup each. */
  const valueProperties = async () => {
    const key = db.settings.rentcastApiKey ?? "";
    const properties = db.accounts.filter((a) => canValue(a.type) && !a.hidden && !a.closedAt && a.address?.trim());
    let done = 0;
    const failures: string[] = [];
    for (const account of properties) {
      try {
        const estimate = await estimateHomeValue(key, account.address ?? "");
        actions.updateAccount(account.id, {
          valuation: { source: "rentcast", low: estimate.low, high: estimate.high, at: estimate.asOf },
        });
        actions.setAccountBalance(account.id, estimate.value);
        recordRun(apply, "rentcast", "month", {});
        done += 1;
      } catch (err) {
        recordRun(apply, "rentcast", "month", { error: reason(err, "the valuation failed") });
        failures.push(`${account.name}: ${reason(err, "failed")}`);
      }
    }
    if (failures.length) setError(failures.join(" · "));
    notify(`Valued ${done} of ${properties.length} propert${properties.length === 1 ? "y" : "ies"}.`);
  };

  return (
    <Card>
      <CardHead
        title="Integrations"
        sub="Every provider this app talks to, what it has spent of its free tier, and whether it is working"
      />

      <div className="int-cards">
        {rows.map((row) => <Stacked key={row.id} row={row} busy={busy === row.id} onRun={() => void run(row.id)} />)}
      </div>

      <div className="int-table" style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Process</th>
              <th>Provider</th>
              <th>Key</th>
              <th className="right">Used</th>
              <th className="right">Ceiling</th>
              <th>Last run</th>
              <th>Health</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <Row key={row.id} row={row} busy={busy === row.id} onRun={() => void run(row.id)} />)}
          </tbody>
        </table>
      </div>

      <div className="divider" />
      <div className="row wrap" style={{ gap: 20 }}>
        <Toggle
          on={db.settings.priceAutoRefresh !== false}
          onChange={(v) => actions.patchSettings({ priceAutoRefresh: v })}
          label={<span className="small">Refresh prices with the accounts</span>}
        />
        <Toggle
          on={db.settings.propertyAutoRefresh !== false}
          onChange={(v) => actions.patchSettings({ propertyAutoRefresh: v })}
          label={<span className="small">Keep property values current</span>}
        />
      </div>

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}
    </Card>
  );
}

/** Which rows have something to press, and what it says. */
const ACTION: Record<string, string> = {
  simplefin: "Sync now",
  plaid: "Sync now",
  tiingo: "Refresh prices",
  rentcast: "Value properties",
};

/** How full the allowance is, in the row's own health colour. */
function Bar({ row, state }: { row: Integration; state: Health }) {
  if (!row.set || row.ceiling <= 0) return null;
  return (
    <div className="int-bar">
      <span style={{ width: `${Math.min(1, row.used / row.ceiling) * 100}%`, background: TONE[state] }} />
    </div>
  );
}

function Dot({ state }: { state: Health }) {
  return <span className="int-dot" style={{ background: TONE[state] }} />;
}

function Row({ row, busy, onRun }: { row: Integration; busy: boolean; onRun: () => void }) {
  const health = healthOf(row);
  const action = ACTION[row.id];

  return (
    <tr>
      <td className="bold" style={{ whiteSpace: "nowrap" }}>{row.process}</td>
      <td className="muted" style={{ whiteSpace: "nowrap" }}>{row.provider}</td>
      <td style={{ minWidth: 190 }}><KeyCell row={row} /></td>
      <td className="right num">
        <div className="bold">{row.set ? row.used.toLocaleString() : "—"}</div>
        <Bar row={row} state={health.state} />
      </td>
      <td className="right num">
        <div>{row.ceiling > 0 ? row.ceiling.toLocaleString() : "—"}</div>
        <div className="tiny faint" style={{ whiteSpace: "nowrap" }}>{row.unit} {PERIOD_LABEL[row.period]}</div>
        {row.caveat ? <div className="tiny faint" style={{ whiteSpace: "nowrap" }}>{row.caveat}</div> : null}
      </td>
      <td className="muted" style={{ whiteSpace: "nowrap" }}>{when(row.lastAt)}</td>
      <td>
        <span className="row" style={{ gap: 6, alignItems: "baseline" }}>
          <Dot state={health.state} />
          <span className="small" style={{ maxWidth: 220 }}>{health.text}</span>
        </span>
      </td>
      <td className="right">
        {action && row.set ? (
          <Btn size="sm" variant="ghost" onClick={onRun} disabled={busy} title={action}>
            <RefreshCw size={13} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
          </Btn>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * The credential, in whichever form this provider actually uses.
 *
 * A key that is set is shown as its last four characters rather than in full:
 * this table is the one place all five sit together, and a screen share is
 * exactly when it would be open.
 */
function KeyCell({ row }: { row: Integration }) {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState(false);

  if (row.credential.kind === "server") {
    return (
      <div className="col" style={{ gap: 1 }}>
        <span className="small">On the server</span>
        <code className="tiny faint">{row.credential.vars}</code>
      </div>
    );
  }

  if (row.credential.kind === "platform") {
    return (
      <div className="col" style={{ gap: 1 }}>
        <span className="small">No key of its own</span>
        <span className="tiny faint">{row.credential.what}</span>
      </div>
    );
  }

  if (row.credential.kind === "claimed") {
    return (
      <div className="col" style={{ gap: 1 }}>
        <span className="small">{row.set ? row.credential.held : "Not connected"}</span>
        <span className="tiny faint">claimed once in {row.credential.where}</span>
      </div>
    );
  }

  const field = row.credential.field;
  const value = (db.settings[field] as string | undefined) ?? "";

  if (value && !editing) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <code className="small">••••{value.slice(-4)}</code>
        <Btn size="sm" variant="ghost" onClick={() => setEditing(true)} title="Replace this key"><Pencil size={12} /></Btn>
      </span>
    );
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      <TextInput
        value={value}
        onChange={(v) => actions.patchSettings({ [field]: v.trim() || undefined } as Partial<Settings>)}
        placeholder={row.credential.placeholder}
        autoFocus={editing}
      />
      {editing ? <Btn size="sm" variant="ghost" onClick={() => setEditing(false)} title="Done"><Check size={12} /></Btn> : null}
    </span>
  );
}

/**
 * The same row on a phone.
 *
 * Health and the allowance come first here, because those are the two things
 * worth opening this screen for; the key drops to the bottom, where it is
 * reached about once a year.
 */
function Stacked({ row, busy, onRun }: { row: Integration; busy: boolean; onRun: () => void }) {
  const health = healthOf(row);
  const action = ACTION[row.id];

  return (
    <div className="int-row">
      <div className="spread" style={{ gap: 10 }}>
        <span className="col" style={{ gap: 0, minWidth: 0 }}>
          <span className="bold">{row.process}</span>
          <span className="tiny muted">{row.provider}</span>
        </span>
        <span className="row" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 6, alignItems: "baseline" }}>
            <Dot state={health.state} />
            <span className="tiny">{health.text}</span>
          </span>
          {action && row.set ? (
            <Btn size="sm" variant="ghost" onClick={onRun} disabled={busy} title={action}>
              <RefreshCw size={13} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
            </Btn>
          ) : null}
        </span>
      </div>

      <div className="int-facts">
        <span className="col" style={{ gap: 0 }}>
          <span className="small">
            {row.set ? <><b>{row.used.toLocaleString()}</b> of {row.ceiling.toLocaleString()}</> : "—"}
          </span>
          <span className="tiny faint">{row.unit} {PERIOD_LABEL[row.period]}{row.caveat ? ` · ${row.caveat}` : ""}</span>
          <Bar row={row} state={health.state} />
        </span>
        <span className="col" style={{ gap: 0 }}>
          <span className="small">{when(row.lastAt)}</span>
          <span className="tiny faint">last run</span>
        </span>
      </div>

      <KeyCell row={row} />
    </div>
  );
}

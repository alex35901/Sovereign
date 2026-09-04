import { useState } from "react";
import { Home, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import type { Account } from "../types";
import { useDB, useStore } from "../store";
import { dateLabel } from "../lib/date";
import { estimateHomeValue } from "../lib/property";
import { reason, recordRun } from "../lib/usage";
import { Btn, Card, CardHead, Field, Money, TextInput } from "../components/ui";

/** Address + automated valuation for a property account. */
export function PropertyValueCard({ account }: { account: Account }) {
  const db = useDB();
  const { actions, apply, notify } = useStore();
  const [address, setAddress] = useState(account.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiKey = db.settings.rentcastApiKey ?? "";
  const v = account.valuation;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const estimate = await estimateHomeValue(apiKey, address);
      actions.updateAccount(account.id, {
        address: estimate.address,
        valuation: { source: "rentcast", low: estimate.low, high: estimate.high, at: estimate.asOf },
      });
      actions.setAccountBalance(account.id, estimate.value);
      recordRun(apply, "rentcast", "month", {});
      notify(`${account.name} valued at ${(estimate.value / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}.`);
    } catch (err) {
      recordRun(apply, "rentcast", "month", { error: reason(err, "The valuation failed.") });
      setError(err instanceof Error ? err.message : "Valuation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHead
        title={<span className="row" style={{ gap: 8 }}><Home size={16} /> Property value</span>}
        sub="Estimated from public records and nearby sales by RentCast"
        right={
          <Btn variant="primary" onClick={() => void refresh()} disabled={busy || !apiKey || !address.trim()}>
            <RefreshCw size={14} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
            {busy ? "Checking…" : "Refresh estimate"}
          </Btn>
        }
      />

      <Field label="Address" hint="Street, city, state, ZIP — the fuller the better">
        <TextInput
          value={address}
          onChange={(next) => { setAddress(next); actions.updateAccount(account.id, { address: next }); }}
          placeholder="742 Evergreen Terrace, Springfield, OR 97477"
        />
      </Field>

      {v ? (
        <>
          <div className="divider" />
          <div className="row wrap" style={{ gap: 26 }}>
            <div className="col">
              <span className="tile-label">Latest estimate</span>
              <span className="num bold" style={{ fontSize: 19 }}><Money value={account.balance} cents={false} /></span>
            </div>
            {v.low !== undefined && v.high !== undefined ? (
              <div className="col">
                <span className="tile-label">Range</span>
                <span className="num muted">
                  <Money value={v.low} cents={false} /> – <Money value={v.high} cents={false} />
                </span>
              </div>
            ) : null}
            <div className="col">
              <span className="tile-label">Checked</span>
              <span className="muted">{dateLabel(v.at.slice(0, 10), { year: true })}</span>
            </div>
          </div>
        </>
      ) : null}

      {!apiKey ? (
        <div className="small muted" style={{ marginTop: 10 }}>
          Add a free RentCast API key in <Link to="/settings" className="link">Settings</Link> to pull valuations.
          The free tier covers 50 lookups a month.
        </div>
      ) : null}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}

      <div className="tiny faint" style={{ marginTop: 10 }}>
        Each refresh writes a balance snapshot, so net worth reflects the new value and the history chart keeps the old one.
      </div>
    </Card>
  );
}

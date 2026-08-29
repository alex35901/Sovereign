import { useState } from "react";
import { Car } from "lucide-react";
import type { Account, VehicleProfile } from "../types";
import { useStore } from "../store";
import { dateLabel, today } from "../lib/date";
import { estimateVehicleValue, projection, VEHICLE_CLASSES } from "../lib/vehicle";
import { sampleLabel } from "../lib/range";
import { AreaChart } from "../components/charts";
import { Btn, Card, CardHead, Field, Money, MoneyInput, SelectInput, TextInput, Toggle } from "../components/ui";

const BLANK: VehicleProfile = {
  purchasePrice: 0,
  purchaseDate: today(),
  class: "car",
  annualMiles: 12000,
  autoUpdate: true,
};

/** Modelled depreciation for a vehicle account. */
export function VehicleValueCard({ account }: { account: Account }) {
  const { actions, notify } = useStore();
  const [profile, setProfile] = useState<VehicleProfile>(account.vehicle ?? BLANK);

  const patch = (next: Partial<VehicleProfile>) => {
    const merged = { ...profile, ...next };
    setProfile(merged);
    actions.updateAccount(account.id, { vehicle: merged });
  };

  const ready = profile.purchasePrice > 0 && Boolean(profile.purchaseDate);
  const value = ready ? estimateVehicleValue(profile) : 0;
  const curve = ready ? projection(profile, 24) : [];
  const lost = profile.purchasePrice - value;

  return (
    <Card>
      <CardHead
        title={<span className="row" style={{ gap: 8 }}><Car size={16} /> Estimated value</span>}
        sub="Modelled from what it cost and how long you've had it — not a market quote"
        right={
          <Btn
            variant="primary" disabled={!ready}
            onClick={() => {
              actions.setBalanceAt(account.id, today(), value);
              notify(`Recorded ${account.name} at ${(value / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}.`);
            }}
          >
            Record today's value
          </Btn>
        }
      />

      <div className="row wrap" style={{ gap: 12 }}>
        <Field label="Paid"><MoneyInput value={profile.purchasePrice} onChange={(v) => patch({ purchasePrice: v })} /></Field>
        <Field label="Bought">
          <TextInput type="date" value={profile.purchaseDate} onChange={(v) => patch({ purchaseDate: v })} />
        </Field>
        <Field label="Type">
          <SelectInput
            value={profile.class}
            onChange={(v) => patch({ class: v as VehicleProfile["class"] })}
            options={VEHICLE_CLASSES}
          />
        </Field>
        <Field label="Miles / year" hint="12,000 is the baseline">
          <TextInput
            value={String(profile.annualMiles ?? 12000)}
            onChange={(v) => patch({ annualMiles: Math.max(0, Number.parseInt(v.replace(/\D/g, ""), 10) || 0) })}
          />
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <Toggle
          on={profile.autoUpdate}
          onChange={(v) => patch({ autoUpdate: v })}
          label={<span className="small">Re-record the modelled value monthly, on its own</span>}
        />
      </div>

      {ready ? (
        <>
          <div className="divider" />
          <div className="row wrap" style={{ gap: 26 }}>
            <div className="col">
              <span className="tile-label">Worth today</span>
              <span className="num bold" style={{ fontSize: 20 }}><Money value={value} cents={false} /></span>
            </div>
            <div className="col">
              <span className="tile-label">Lost so far</span>
              <span className="num bold neg"><Money value={-lost} cents={false} /></span>
            </div>
            <div className="col">
              <span className="tile-label">Retained</span>
              <span className="num bold">{Math.round((value / profile.purchasePrice) * 100)}%</span>
            </div>
            <div className="col">
              <span className="tile-label">Bought</span>
              <span className="muted">{dateLabel(profile.purchaseDate, { year: true })}</span>
            </div>
          </div>

          <div className="divider" />
          <span className="section-title">Next two years, if nothing changes</span>
          <AreaChart
            height={140}
            tone="--c9"
            points={curve.map((p) => ({
              label: sampleLabel(p.date, 730),
              value: p.value,
              sub: dateLabel(p.date, { year: true }),
            }))}
          />
        </>
      ) : (
        <div className="small faint" style={{ marginTop: 12 }}>
          Enter what you paid and when to see the curve.
        </div>
      )}

      <div className="tiny faint" style={{ marginTop: 12 }}>
        Curves are fitted to 2026 industry averages for five-year depreciation — 41.8% for the average
        vehicle, 34.2% for trucks, 57.2% for EVs — with the first year steepest. Mileage above or below
        12,000 a year moves you along the curve faster or slower. If you have a real quote from a dealer
        or KBB, enter it as a balance point below and it takes precedence.
      </div>
    </Card>
  );
}

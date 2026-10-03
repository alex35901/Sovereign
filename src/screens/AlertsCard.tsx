import { Bell } from "lucide-react";
import { useDB, useStore } from "../store";
import { fmt0 } from "../lib/money";
import { Card, CardHead, Field, MoneyInput, SelectInput } from "../components/ui";

/**
 * The two notices the household sets for itself.
 *
 * Everything else in the bell is worked out on a rung this app chose: a
 * category past its plan, a quarter past, half past. Those are facts about
 * money and the app can pick where they sit. These two are not facts, they are
 * preferences — where "getting close" starts, and how low an account is
 * allowed to go — and the app has no business choosing them for anybody.
 *
 * Both are off until somebody asks. An alert nobody wanted is one more thing
 * to dismiss, and a bell that cries wolf is a bell people stop opening.
 */

/** Marks worth offering, which is not every number between 50 and 99. */
const SHARES = [50, 60, 70, 75, 80, 85, 90, 95];

export function AlertsCard() {
  const db = useDB();
  const { actions } = useStore();
  const alerts = db.settings.alerts ?? {};

  const set = (patch: Partial<NonNullable<typeof db.settings.alerts>>) => {
    const next = { ...alerts, ...patch };
    // Nothing is stored for a threshold that is off. The document goes up on
    // every save and a key holding nought is a key.
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (!next[k]) delete next[k];
    actions.patchSettings({ alerts: Object.keys(next).length ? next : undefined });
  };

  return (
    <Card>
      <CardHead
        title="Tell me when"
        sub="Two marks of your own, alongside the ones the app already watches"
      />
      <div className="col" style={{ gap: 14 }}>
        <Field
          label="A category reaches this much of its plan"
          hint={alerts.budgetAt
            ? "Before it is over, so there is still a month left to do something about it. A category already past its plan says so on its own and is left out of this."
            : "Off. The app still says something once a category is past its plan."}
        >
          <SelectInput
            value={String(alerts.budgetAt ?? 0)}
            onChange={(v) => set({ budgetAt: Number(v) || undefined })}
            options={[
              { value: "0", label: "Don't tell me" },
              ...SHARES.map((n) => ({ value: String(n), label: `${n}% of the plan` })),
            ]}
          />
        </Field>

        <Field
          label="A current account falls below"
          hint={alerts.balanceFloor
            ? `Dated to the day it went under ${fmt0(alerts.balanceFloor)}, not to the day you happened to look.`
            : "Off. Current accounts only: a savings account under the figure is a savings account, not a problem."}
        >
          <MoneyInput
            value={alerts.balanceFloor ?? 0}
            onChange={(cents) => set({ balanceFloor: cents > 0 ? cents : undefined })}
            placeholder="0.00"
          />
        </Field>

        <div className="row" style={{ gap: 8 }}>
          <Bell size={13} className="faint" />
          <span className="tiny faint">
            Both appear in the bell with everything else, newest first. Changing a mark raises a fresh
            notice rather than reviving one you have already read.
          </span>
        </div>
      </div>
    </Card>
  );
}

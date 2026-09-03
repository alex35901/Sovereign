import { useState } from "react";
import { Plus, Zap } from "lucide-react";
import { useDB, useStore } from "../store";
import { IconAction, TopBar } from "../shell/TopBar";
import { Btn } from "../components/ui";
import { RulesPanel } from "./SettingsPanels";
import { ImportRules } from "./ImportRules";

export default function Rules() {
  const db = useDB();
  const { actions, notify } = useStore();
  const [adding, setAdding] = useState(false);
  const [armed, setArmed] = useState(false);

  const enabled = db.rules.filter((r) => r.enabled).length;

  /**
   * Running every rule over the whole history.
   *
   * Sweeping enough to be worth asking twice — it can recategorise and mark
   * reviewed across thousands of transactions in one press — but an icon has
   * nowhere to put "click again", so the confirmation is said out loud in the
   * toast instead and the second press within it commits.
   */
  const runAll = () => {
    if (!armed) {
      setArmed(true);
      notify(`Press again to run ${enabled} rule${enabled === 1 ? "" : "s"} over all ${db.transactions.length.toLocaleString()} transactions. One undo takes it back.`);
      window.setTimeout(() => setArmed(false), 6000);
      return;
    }
    setArmed(false);
    actions.applyAllRules();
  };

  return (
    <>
      <TopBar
        title="Rules"
        actions={
          <IconAction
            title={armed ? `Press again to run ${enabled} rules` : `Run all ${enabled} rules over every transaction`}
            onClick={runAll}
            disabled={!enabled}
          >
            <Zap size={16} className={armed ? "neg" : undefined} />
          </IconAction>
        }
        primary={
          <Btn variant="primary" onClick={() => setAdding(true)}>
            <Plus size={15} /> <span className="btn-label">Rule</span>
          </Btn>
        }
      />
      <div className="page stack">
        <RulesPanel adding={adding} onAddingDone={() => setAdding(false)} />
        <ImportRules />
      </div>
    </>
  );
}

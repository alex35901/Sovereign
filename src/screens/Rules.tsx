import { TopBar } from "../shell/TopBar";
import { RulesPanel } from "./SettingsPanels";
import { ImportRules } from "./ImportRules";

export default function Rules() {
  return (
    <>
      <TopBar title="Rules" />
      <div className="page stack">
        <RulesPanel />
        <ImportRules />
      </div>
    </>
  );
}

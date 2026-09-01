import { TopBar } from "../shell/TopBar";
import { RulesPanel } from "./SettingsPanels";

export default function Rules() {
  return (
    <>
      <TopBar title="Rules" />
      <div className="page stack">
        <RulesPanel />
      </div>
    </>
  );
}

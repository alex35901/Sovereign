import { TopBar } from "../shell/TopBar";
import { TagsPanel } from "./SettingsPanels";

export default function Tags() {
  return (
    <>
      <TopBar title="Tags" />
      <div className="page stack">
        <TagsPanel />
      </div>
    </>
  );
}

import { TopBar } from "../shell/TopBar";
import { NewTagButton, TagsPanel } from "./SettingsPanels";

export default function Tags() {
  return (
    <>
      <TopBar title="Tags" primary={<NewTagButton />} />
      <div className="page stack">
        <TagsPanel />
      </div>
    </>
  );
}

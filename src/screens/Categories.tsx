import { TopBar } from "../shell/TopBar";
import { CategoriesPanel, NewGroupButton } from "./SettingsPanels";

export default function Categories() {
  return (
    <>
      <TopBar title="Categories" primary={<NewGroupButton />} />
      <div className="page stack">
        <CategoriesPanel />
      </div>
    </>
  );
}

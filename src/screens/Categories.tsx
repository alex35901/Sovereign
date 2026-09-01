import { TopBar } from "../shell/TopBar";
import { CategoriesPanel } from "./SettingsPanels";

export default function Categories() {
  return (
    <>
      <TopBar title="Categories" />
      <div className="page stack">
        <CategoriesPanel />
      </div>
    </>
  );
}

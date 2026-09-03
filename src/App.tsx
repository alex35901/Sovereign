import { Navigate, Route, Routes } from "react-router-dom";
import { MobileTabs, Sidebar } from "./shell/Sidebar";
import { AutoSync } from "./components/AutoSync";
import { PropertyRefresh } from "./components/PropertyRefresh";
import { CloudSync } from "./components/CloudSync";
import { RulePrompt } from "./components/RulePrompt";
import { useStore } from "./store";
import Dashboard from "./screens/Dashboard";
import Accounts from "./screens/Accounts";
import AccountDetail from "./screens/AccountDetail";
import Transactions from "./screens/Transactions";
import CashFlow from "./screens/CashFlow";
import Reports from "./screens/Reports";
import Budget from "./screens/Budget";
import Recurring from "./screens/Recurring";
import Goals from "./screens/Goals";
import Investments from "./screens/Investments";
import Settings from "./screens/Settings";
import Rules from "./screens/Rules";
import Categories from "./screens/Categories";
import CategoryDetail from "./screens/CategoryDetail";
import Tags from "./screens/Tags";

export default function App() {
  const { toast, undoLabel, undo } = useStore();
  return (
    <div className="app">
      <AutoSync />
      <PropertyRefresh />
      <CloudSync />
      <Sidebar />
      <div className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:id" element={<AccountDetail />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/cash-flow" element={<CashFlow />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/investments" element={<Investments />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/categories/:id" element={<CategoryDetail />} />
          <Route path="/tags" element={<Tags />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
      <MobileTabs />
      <RulePrompt />
      {undoLabel ? (
        <div className="toast">
          <span className="muted">{toast ?? undoLabel}</span>
          <button className="link bold" onClick={undo}>Undo</button>
        </div>
      ) : toast ? (
        <div className="toast">{toast}</div>
      ) : null}
    </div>
  );
}

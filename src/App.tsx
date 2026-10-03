import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { MobileTabs, Sidebar } from "./shell/Sidebar";
import { ScrollMemory } from "./shell/ScrollMemory";
import { AutoSync } from "./components/AutoSync";
import { PropertyRefresh } from "./components/PropertyRefresh";
import { CloudSync } from "./components/CloudSync";
import { RulePrompt } from "./components/RulePrompt";
import { useStore } from "./store";

/**
 * The screens that load with the app, and the screens that wait.
 *
 * Every screen used to be imported here, which meant opening the dashboard
 * also downloaded the estate planner, the tax screen, the card comparison and
 * the whole of Settings before anything could paint. On a phone on a bad
 * connection that is the difference between a budget appearing and a white
 * page.
 *
 * Eager below the line: the four screens the tab bar points at, plus the
 * account page, because those are where a visit starts and the one place a
 * second request would be felt. Everything else is fetched when it is first
 * asked for and then cached by the browser for the rest of the session, which
 * for most of these is never.
 */
import Dashboard from "./screens/Dashboard";
import Accounts from "./screens/Accounts";
import AccountDetail from "./screens/AccountDetail";
import Transactions from "./screens/Transactions";
import Budget from "./screens/Budget";

const Reports = lazy(() => import("./screens/Reports"));
const Recurring = lazy(() => import("./screens/Recurring"));
const Hopper = lazy(() => import("./screens/Hopper"));
const Goals = lazy(() => import("./screens/Goals"));
const GoalDetail = lazy(() => import("./screens/GoalDetail"));
const Investments = lazy(() => import("./screens/Investments"));
const Forecast = lazy(() => import("./screens/Forecast"));
const Estate = lazy(() => import("./screens/Estate"));
const Payoff = lazy(() => import("./screens/Payoff"));
const Tax = lazy(() => import("./screens/Tax"));
const Cards = lazy(() => import("./screens/Cards"));
const History = lazy(() => import("./screens/History"));
const Settings = lazy(() => import("./screens/Settings"));
const Rules = lazy(() => import("./screens/Rules"));
const Categories = lazy(() => import("./screens/Categories"));
const CategoryDetail = lazy(() => import("./screens/CategoryDetail"));
const MerchantDetail = lazy(() => import("./screens/MerchantDetail"));
const Merchants = lazy(() => import("./screens/Merchants"));
const Tags = lazy(() => import("./screens/Tags"));

export default function App() {
  const { toast, undoLabel, undo } = useStore();
  return (
    <div className="app">
      <AutoSync />
      <PropertyRefresh />
      <CloudSync />
      <ScrollMemory />
      <Sidebar />
      <div className="main">
        {/* One boundary around the lot rather than one per route: what is
            behind it is a local file the browser has usually already got, so
            this is a frame at worst and nothing at all on the second visit.
            The placeholder keeps the page's own padding so the chrome does
            not jump when the screen arrives. */}
        <Suspense fallback={<div className="page" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:id" element={<AccountDetail />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/recurring" element={<Recurring />} />
          <Route path="/hopper" element={<Hopper />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/goals/:id" element={<GoalDetail />} />
          <Route path="/investments" element={<Investments />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/estate" element={<Estate />} />
          <Route path="/payoff" element={<Payoff />} />
          <Route path="/cards" element={<Cards />} />
          <Route path="/tax" element={<Tax />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/categories/:id" element={<CategoryDetail />} />
          <Route path="/merchants" element={<Merchants />} />
          <Route path="/merchants/:name" element={<MerchantDetail />} />
          <Route path="/tags" element={<Tags />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
        </Suspense>
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

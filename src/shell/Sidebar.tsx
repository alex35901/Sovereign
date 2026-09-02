import { NavLink, useLocation } from "react-router-dom";
import {
  ArrowLeftRight, ChartPie, Filter, Landmark, LayoutDashboard, LineChart, Repeat,
  Settings as SettingsIcon, Shapes, Tag, Target, TrendingUp, Wallet,
} from "lucide-react";
import { useDB } from "../store";
import { needsReviewCount, netWorthNow } from "../lib/select";
import { Money, cx } from "../components/ui";

export const NAV = [
  { to: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { to: "/accounts", label: "Accounts", Icon: Landmark },
  { to: "/transactions", label: "Transactions", Icon: ArrowLeftRight },
  { to: "/cash-flow", label: "Cash Flow", Icon: TrendingUp },
  { to: "/reports", label: "Reports", Icon: ChartPie },
];
export const NAV_PLAN = [
  { to: "/budget", label: "Budget", Icon: Wallet },
  { to: "/recurring", label: "Recurring", Icon: Repeat },
  { to: "/goals", label: "Goals", Icon: Target },
  { to: "/investments", label: "Investments", Icon: LineChart },
];

export const NAV_CONFIG = [
  { to: "/rules", label: "Rules", Icon: Filter },
  { to: "/categories", label: "Categories", Icon: Shapes },
  { to: "/tags", label: "Tags", Icon: Tag },
];

export function Sidebar() {
  const db = useDB();
  const unreviewed = needsReviewCount(db);
  const { net } = netWorthNow(db);

  const item = ({ to, label, Icon }: { to: string; label: string; Icon: typeof Landmark }) => (
    <NavLink key={to} to={to} className={({ isActive }) => cx("nav-item", isActive && "active")}>
      <Icon size={16} />
      <span className="grow">{label}</span>
      {to === "/transactions" && unreviewed > 0 ? (
        <span className="tag" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{unreviewed}</span>
      ) : null}
    </NavLink>
  );

  return (
    <aside className="sidebar">
      <NavLink to="/dashboard" className="brand">
        <span className="brand-mark">◈</span>
        <span>Sovereign</span>
      </NavLink>
      <nav className="nav">
        {NAV.map(item)}
        <div className="nav-label">Plan</div>
        {NAV_PLAN.map(item)}
        <div className="nav-label">Configuration</div>
        {NAV_CONFIG.map(item)}
        {/* Below every nav item, so collapsing it when the rail is closed
            cannot shift an icon out from under the pointer. */}
        <div className="nav-networth">
          <div className="nav-label">Net worth</div>
          <div className="nav-net" style={{ padding: "2px 10px 10px" }}>
            <Money value={net} cents={false} className="bold" style={{ fontSize: 18 }} />
          </div>
        </div>
      </nav>
      <div className="nav-foot">{item({ to: "/settings", label: "Settings", Icon: SettingsIcon })}</div>
    </aside>
  );
}

/** Compact bar for narrow screens, where the sidebar is hidden. */
export function MobileTabs() {
  const { pathname } = useLocation();
  const items = [NAV[0], NAV[1], NAV[2], NAV_PLAN[0], { to: "/settings", label: "More", Icon: SettingsIcon }];
  return (
    <nav
      style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, display: "none",
        background: "var(--surface)", borderTop: "1px solid var(--line)", padding: "6px 4px 8px",
      }}
      className="mobile-tabs"
    >
      {items.map(({ to, label, Icon }) => (
        <NavLink
          key={to} to={to}
          style={{
            flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            color: pathname.startsWith(to) ? "var(--accent)" : "var(--muted)", fontSize: 10.5, fontWeight: 600,
          }}
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

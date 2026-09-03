import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import {
  ArrowLeftRight, ChartPie, Filter, Landmark, LayoutDashboard, LineChart, MoreHorizontal,
  Repeat, Settings as SettingsIcon, Shapes, Tag, Target, TrendingUp, Wallet,
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

const SETTINGS = { to: "/settings", label: "Settings", Icon: SettingsIcon };

/** The four that fit along the bottom of a phone. */
const TABS = [NAV[0]!, NAV[1]!, NAV[2]!, NAV_PLAN[0]!];

/**
 * Everything the bar has no room for, in the order the sidebar shows it.
 *
 * Worked out from the same arrays rather than listed again, so a screen added
 * to the sidebar cannot end up unreachable on a phone — which is exactly what
 * happened to Goals, Reports, Cash Flow, Investments and the rest: the fifth
 * tab said "More" and went straight to Settings, and nothing else had a way in
 * at all.
 */
const MORE: { label: string | null; items: typeof NAV }[] =
  [
    { label: null, items: NAV },
    { label: "Plan", items: NAV_PLAN },
    { label: "Configuration", items: NAV_CONFIG },
    { label: null, items: [SETTINGS] },
  ]
    .map((s) => ({ ...s, items: s.items.filter((i) => !TABS.some((t) => t.to === i.to)) }))
    .filter((s) => s.items.length > 0);

const tabStyle = (on: boolean) => ({
  flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 2,
  color: on ? "var(--accent)" : "var(--muted)", fontSize: 10.5, fontWeight: 600,
  background: "none", border: 0, padding: 0, cursor: "pointer", fontFamily: "inherit",
});

/** Compact bar for narrow screens, where the sidebar is hidden. */
export function MobileTabs() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const here = (to: string) => pathname.startsWith(to);
  // Lit while you are on one of the screens behind it, or the bar shows
  // nothing selected for half the app.
  const inMore = !TABS.some((t) => here(t.to));

  // Escape closes it, and so does going somewhere — including the back
  // gesture, which changes the route without touching anything in here.
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", esc); document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      {open ? createPortal(
        <div className="scrim more-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="more-sheet" role="dialog" aria-label="More screens">
            <div className="more-grip" />
            <div className="more-grid">
              {MORE.map((section) => (
                <Fragment key={section.label ?? section.items[0]!.to}>
                  {section.label ? <div className="more-label">{section.label}</div> : null}
                  {section.items.map(({ to, label, Icon }) => (
                    <NavLink key={to} to={to} className={cx("more-item", here(to) && "active")}>
                      <Icon size={19} />
                      <span>{label}</span>
                    </NavLink>
                  ))}
                </Fragment>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      <nav
        style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50, display: "none",
          background: "var(--surface)", borderTop: "1px solid var(--line)",
          // Clear of the home indicator when the app is running from a home
          // screen, and unchanged on a phone that does not have one.
          padding: "6px 4px calc(8px + env(safe-area-inset-bottom))",
        }}
        className="mobile-tabs"
      >
        {TABS.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} style={tabStyle(here(to))}>
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="More screens"
          style={tabStyle(open || inMore)}
        >
          <MoreHorizontal size={18} />
          More
        </button>
      </nav>
    </>
  );
}

import { ArrowLeft, Eye, EyeOff, Moon, RefreshCw, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStore } from "../store";
import { Btn } from "../components/ui";

/**
 * The bar across the top of every screen.
 *
 * Two slots and two fixtures, in that order: the page's own controls, then the
 * privacy and theme toggles, then the page's one add button. The toggles are
 * in the same place on every screen because they are on every screen; the add
 * button is on the far right because it is the thing you came to press.
 *
 * It used to add its own "+ Transaction" regardless of the page, so Goals had
 * one, and Reports, and Categories — a button that answered a question nobody
 * on those screens was asking, sitting where that screen's actual action
 * should have been.
 *
 * The way out of a drill-down lives here too, for the reason the bar itself is
 * sticky: a way back that scrolls off the top of a long transaction list is
 * only a way back for the first screenful of it.
 */
export function TopBar({ title, back, actions, primary }: {
  title: string;
  /** Where a drill-down sits under, named so the arrow is not a guess. */
  back?: { to: string; label: string };
  /** Filters and icon buttons, to the left of the toggles. */
  actions?: ReactNode;
  /** This screen's one add button, to the right of them. */
  primary?: ReactNode;
}) {
  const { db, actions: act } = useStore();
  const privacy = db.settings.privacyMode;

  return (
    <header className="topbar">
      {/* A fixed destination rather than history: you can reach a category
          from four different screens, and an arrow that lands somewhere
          different each time is not somewhere you can aim. */}
      {back ? (
        <Link
          to={back.to} className="btn btn-ghost btn-icon topbar-back"
          title={back.label} aria-label={back.label}
        >
          <ArrowLeft size={17} />
        </Link>
      ) : null}
      <h1 className="grow truncate" style={{ fontSize: 19 }}>{title}</h1>
      <div className="row topbar-actions" style={{ gap: 6 }}>
        {actions}
        <button
          className="btn btn-ghost btn-icon" title={privacy ? "Show amounts" : "Hide amounts"}
          onClick={() => act.patchSettings({ privacyMode: !privacy })}
        >
          {privacy ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button className="btn btn-ghost btn-icon" title="Toggle theme" onClick={act.toggleTheme}>
          {db.settings.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {primary}
      </div>
    </header>
  );
}

/**
 * An action that is only an icon, in the toggles' own style.
 *
 * Same size and weight as the eye and the sun beside it, so a row of them
 * reads as one set of controls rather than a row of buttons that happen to be
 * adjacent. The title is not decoration: it is the only label there is.
 */
export function IconAction({ title, onClick, children, disabled }: {
  title: string; onClick: () => void; children: ReactNode; disabled?: boolean;
}) {
  return (
    <button
      className="btn btn-ghost btn-icon" title={title} aria-label={title}
      onClick={onClick} disabled={disabled}
    >
      {children}
    </button>
  );
}

export function SyncButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <Btn onClick={onClick} disabled={busy}>
      <RefreshCw size={15} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
      {busy ? "Syncing…" : "Sync"}
    </Btn>
  );
}

import { ArrowLeft, Bell, Moon, RefreshCw, Sun } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useStore } from "../store";
import { Btn, Popover, cx } from "../components/ui";
import { isSeen, markRead, notices, unread } from "../lib/notifications";

/**
 * The bar across the top of every screen.
 *
 * Two slots and two fixtures, in that order: the page's own controls, then the
 * bell and the theme toggle, then the page's one add button. The fixtures are
 * in the same place on every screen because they belong to every screen; the
 * add button is on the far right because it is the thing you came to press.
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
        <Notifications />
        <button className="btn btn-ghost btn-icon" title="Toggle theme" onClick={act.toggleTheme}>
          {db.settings.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {primary}
      </div>
    </header>
  );
}

/**
 * The bell, and what is behind it.
 *
 * Unread ones first and then the rest, rather than the unread ones alone: a
 * list that empties itself the moment you look at it gives you no way back to
 * something you half-read on a phone.
 *
 * Opening the list does not mark anything read. Reading is a thing you do to
 * one notice, by going to what it is about — which is also the only moment the
 * app can be sure you saw it.
 */
function Notifications() {
  const { db, apply } = useStore();
  const navigate = useNavigate();
  // Only worked out while the list is open; the count below is what the bell
  // needs the rest of the time.
  const [open, setOpen] = useState(false);
  const all = useMemo(() => (open ? notices(db) : []), [db, open]);
  const unreadCount = useMemo(() => unread(db).length, [db]);

  return (
    <Popover
      align="right" width={340} className="notif-menu" onOpenChange={setOpen}
      trigger={(show) => (
        <button
          className="btn btn-ghost btn-icon notif-bell" onClick={show}
          title={unreadCount ? `${unreadCount} unread` : "Notifications"}
          aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        >
          <Bell size={16} />
          {unreadCount ? <span className="notif-dot">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
        </button>
      )}
    >
      {(close) => (
        <div className="notif-panel">
          <div className="spread notif-head">
            <span className="bold small">Notifications</span>
            {unreadCount ? (
              <button
                className="btn btn-ghost notif-all"
                onClick={() => apply((cur) => markRead(cur, all.map((n) => n.id)))}
              >
                Mark all read
              </button>
            ) : null}
          </div>
          {all.length ? all.map((n) => (
            <button
              key={n.id} className={cx("notif-row", !isSeen(db, n.id) && "unread")}
              onClick={() => {
                apply((cur) => markRead(cur, [n.id]));
                close();
                if (n.to) navigate(n.to);
              }}
            >
              <span className={cx("notif-tone", n.tone)} />
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="small bold">{n.title}</span>
                <span className="tiny muted notif-body">{n.body}</span>
                <span className="tiny faint">{n.when}</span>
              </span>
            </button>
          )) : (
            <div className="notif-empty small muted">
              Nothing to report. Overspending, new subscriptions and connections
              that have stopped answering show up here.
            </div>
          )}
        </div>
      )}
    </Popover>
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

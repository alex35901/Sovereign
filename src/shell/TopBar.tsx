import { ArrowLeft, Bell, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useStore } from "../store";
import { Btn, Popover, cx } from "../components/ui";
import { SaveState } from "../components/SaveState";
import { isSeen, markRead, notices, unread } from "../lib/notifications";

/**
 * The bar across the top of every screen.
 *
 * Three slots, and which side a thing is on is the whole rule: what belongs to
 * this screen is on the left, what belongs to every screen is on the right,
 * and the screen's name sits between them.
 *
 * The right is always the same three, in the same order — whether the work is
 * saved, what has happened, and the one thing this screen is for adding. They
 * are in the same place on every screen because they belong to every screen,
 * and a reader who has learned where the add button is should not have to find
 * it again on the next one. The theme toggle used to sit among them and no
 * longer does: it is a preference, set once, and it lives in Settings with the
 * rest of them rather than beside the buttons pressed every day.
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
  /**
   * The screen's name, or what stands in for it.
   *
   * A node rather than a string for the one case that earns it: on a phone
   * the budget's bar carries the month here instead, because the month is
   * what everything under it is about and the word "Budget" is already on
   * the rail. Anything passing a string gets the heading it has always had.
   */
  title: ReactNode;
  /** Where a drill-down sits under, named so the arrow is not a guess. */
  back?: { to: string; label: string };
  /** This screen's own controls, on the far left with the way back. */
  actions?: ReactNode;
  /** This screen's one add button, last of the three on the right. */
  primary?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="row topbar-own" style={{ gap: 6 }}>
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
        {actions}
      </div>
      {typeof title === "string"
        ? <h1 className="truncate topbar-title">{title}</h1>
        : <div className="topbar-title">{title}</div>}
      <div className="row topbar-actions" style={{ gap: 6 }}>
        <SaveState />
        <Notifications />
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

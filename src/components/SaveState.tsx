import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CloudOff, Download } from "lucide-react";
import { useDB } from "../store";
import { CLOUD_EVENT, cloudState, needsAttention, setCloudState } from "../lib/cloud";
import { download, exportJSON } from "../lib/storage";
import { Btn, Popover, cx } from "./ui";

/**
 * Whether this browser's work has reached the cloud, said where it cannot be
 * missed.
 *
 * A save that fails already said so, once, in a toast that went away after
 * three seconds. That was enough to be honest and nowhere near enough to be
 * useful: a household went three weeks with every save failing, never saw one
 * of those toasts, cleared the browser's data for an unrelated reason, and
 * lost everything since the last save that worked. The toast was right and the
 * design was wrong.
 *
 * So this sits in the bar on every screen, it does not go away by itself, and
 * the one thing that actually rescues the situation - a copy on disk - is one
 * press from it rather than four screens away.
 *
 * Silent when everything is saved. A permanent green tick would be a thing to
 * stop reading, and then it would be a thing that could turn red unnoticed.
 */

/** How often to re-read, for the clock in "last saved four hours ago". */
const TICK_MS = 30_000;

const ago = (at: number | undefined, now: number): string => {
  if (!at) return "never";
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

export function SaveState() {
  const db = useDB();
  const [state, setState] = useState(cloudState);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const read = () => { setState(cloudState()); setNow(Date.now()); };
    window.addEventListener(CLOUD_EVENT, read);
    // Another tab saving is this tab's news too.
    window.addEventListener("storage", read);
    const id = window.setInterval(read, TICK_MS);
    return () => {
      window.removeEventListener(CLOUD_EVENT, read);
      window.removeEventListener("storage", read);
      window.clearInterval(id);
    };
  }, []);

  if (!needsAttention(state)) return null;

  const stuck = !!state.blocked;
  return (
    <Popover
      width={310}
      align="right"
      trigger={(open) => (
        <button
          className={cx("save-pill", stuck ? "stuck" : "waiting")}
          onClick={open}
          title="This browser has work the cloud has not taken"
          // Named here as well as in the text beside the icon, which a phone
          // hides: a display:none label is gone from the accessibility tree
          // too, and the button would be a mark with no name at all.
          aria-label="Not saved"
        >
          <CloudOff size={14} />
          <span className="save-pill-text">Not saved</span>
        </button>
      )}
    >
      {() => (
        <div className="col" style={{ gap: 10, padding: 12 }}>
          <span className="bold">Your changes are only on this device</span>
          <span className="small muted">
            {state.blocked ?? state.lastError?.message ?? "The cloud copy has not taken this browser's latest work yet."}
          </span>
          <span className="tiny faint">
            Last saved to the cloud {ago(state.okAt, now)}.
            {state.nextTryAt && state.nextTryAt > now
              ? ` Trying again in ${Math.max(1, Math.round((state.nextTryAt - now) / 60_000))} minutes.`
              : " Trying again shortly."}
          </span>
          {/* The one thing that rescues this. Clearing the browser's data with
              a failing save behind you is how the work disappears, and a file
              on disk is the only copy that does not care. */}
          <Btn
            variant="primary"
            onClick={() => download(
              `sovereign-backup-${new Date().toISOString().slice(0, 10)}.json`,
              exportJSON(db),
            )}
          >
            <Download size={14} /> Back up to a file now
          </Btn>
          <div className="row" style={{ gap: 8 }}>
            <Btn
              size="sm"
              onClick={() => setCloudState({ ...cloudState(), nextTryAt: undefined, failures: 0 })}
            >
              Try again now
            </Btn>
            <Link to="/settings" className="btn btn-sm">Settings</Link>
          </div>
        </div>
      )}
    </Popover>
  );
}

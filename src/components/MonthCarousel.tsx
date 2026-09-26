import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MonthKey } from "../types";
import { addMonths } from "../lib/date";
import { useSwipe } from "../lib/swipe";

/**
 * A month at a time, out of a row of them.
 *
 * Three are rendered: the one in frame and the one either side, in a strip
 * that is dragged sideways. That is the whole of why it feels like a row of
 * boxes rather than an animation — pull it a little and a little of next
 * month is there, because next month is genuinely sitting there.
 *
 * Only ever three. A row that really held every month would hold five hundred
 * budget sheets; this one shuffles, so after a turn the strip is silently put
 * back to the middle with the months renumbered around the new one. Nothing
 * on screen moves at that moment, which is what makes it invisible.
 *
 * And only three while a finger is down. At rest the two either side are empty
 * boxes holding the strip's shape: a page that always carried three months
 * would be three of everything to anything reading it — three budget sheets
 * for a screen reader, three of every row for anything looking for one — for
 * two of them nobody can see. They are filled on touch, which is a hundred
 * milliseconds before the first frame that needs them.
 */

/** How long the strip takes to settle once the finger lets go. */
export const TURN_MS = 260;

/** One step of the dial in the bar, in pixels. Matches --dial-cell. */
const DIAL_CELL = 180;

/**
 * Where the strip is, as CSS rather than as state.
 *
 * On the document, because the two things that follow the finger are in two
 * different corners of the tree: the strip of sheets, and the month dial in
 * the bar at the top. Threading a pixel count through both on every frame
 * means re-rendering both on every frame, which is how a gesture ends up
 * trailing the finger doing it.
 */
const put = (dx: number, width: number) => {
  const root = document.documentElement.style;
  root.setProperty("--month-dx", `${dx}px`);
  // The dial turns by one cell for one screen, so the two read as the same
  // movement rather than two things that happen to be moving.
  root.setProperty("--month-dial-dx", `${width > 0 ? (dx / width) * DIAL_CELL : 0}px`);
};

const settling = (on: boolean) => {
  if (on) document.documentElement.dataset.monthTurn = "1";
  else delete document.documentElement.dataset.monthTurn;
};

export function MonthCarousel({ month, onChange, enabled, children }: {
  month: MonthKey;
  onChange: (m: MonthKey) => void;
  /** Off on anything that is not a phone: there is no finger to follow. */
  enabled: boolean;
  children: (m: MonthKey) => ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  /** A turn that has landed on screen but not yet been told to the caller. */
  const pending = useRef(0);
  /**
   * Where the strip already was when a finger landed on it.
   *
   * Nought except when a finger catches one still in flight. The strip keeps
   * every pixel it had; what changes underneath it is which month is in which
   * panel, and this is the offset that makes those two agree.
   */
  const held = useRef(0);
  // The month as of the last render, for the timer, which was written with
  // whatever the month was when the finger lifted.
  const latest = useRef(month);
  latest.current = month;
  const width = () => track.current?.clientWidth ?? 0;

  /** Where the strip is right now, which mid-flight is neither end of it. */
  const liveDx = () => {
    const el = track.current;
    if (!el) return 0;
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    // The strip sits one panel to the left of its own origin, so what is left
    // over that is the drag.
    return m.m41 + el.clientWidth;
  };

  /**
   * Finish a turn that is still in the air, without moving anything.
   *
   * A second drag starting while the first is still flying has to pick the
   * strip up where it is. Renumbering the months moves the content one panel;
   * moving the strip the other way by exactly the same amount leaves every
   * pixel on screen where it was, and the only thing that changed is which
   * month is in which panel.
   *
   * It used to put the strip back to the middle here, which is the right
   * bookkeeping and visible as a jump backwards of however far the turn had
   * got. On a landing that formula gives nought, so the two cases are one.
   */
  const flush = (landed = false) => {
    window.clearTimeout(timer.current);
    if (!pending.current) return;
    const by = pending.current;
    pending.current = 0;
    const w = width();
    // A flight that finished is at its destination by definition, so the
    // strip goes exactly to the middle. Working it out from the transform
    // instead leaves whatever the last frame of the easing rounded to, and a
    // strip parked a pixel off centre stays a pixel off centre for ever.
    held.current = landed ? 0 : liveDx() + (by > 0 ? w : -w);
    settling(false);
    put(held.current, w);
    onChange(addMonths(latest.current, by));
  };

  // Whatever is half way through when this screen is left behind. A variable
  // left on the document would hold the next screen sideways.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    settling(false);
    put(0, 0);
  }, []);

  /** Whether a finger is on it, which is when the neighbours are needed. */
  const [armed, setArmed] = useState(false);

  const handlers = useSwipe(
    (dx) => {
      // No easing while a finger is on it: easing towards where the finger was
      // a quarter of a second ago is the lag this exists to get rid of.
      settling(false);
      put(dx, width());
    },
    (went) => {
      const w = width();
      held.current = 0;
      settling(true);
      // Carried the rest of the way off rather than snapped back: the month
      // being left is thrown out of frame and the next one lands in it.
      put(went === "left" ? -w : went === "right" ? w : 0, w);
      if (!went) return;
      pending.current = went === "left" ? 1 : -1;
      // Once it has landed, the strip goes back to the middle with the months
      // renumbered around the new one. Both in the same breath, so the browser
      // paints the new month already in place and nothing jumps.
      timer.current = window.setTimeout(() => {
        settling(false);
        flush(true);
        setArmed(false);
      }, TURN_MS);
    },
    width,
    () => held.current,
  );

  if (!enabled) return <>{children(month)}</>;

  return (
    <div className="month-frame">
      <div
        className="month-track" ref={track}
        {...handlers}
        // Caught mid-flight, the turn in the air is finished here rather than
        // on the first move: by the time the finger travels the strip has to
        // already know which month is in which panel.
        onTouchStart={(e) => { setArmed(true); flush(); handlers.onTouchStart(e); }}
        onTouchEnd={(e) => { handlers.onTouchEnd(e); if (!pending.current) setArmed(false); }}
        onTouchCancel={() => { handlers.onTouchCancel(); setArmed(false); }}
      >
        {[-1, 0, 1].map((step) => (
          <div
            key={step}
            className="month-panel"
            data-in-frame={step === 0 ? "" : undefined}
            // The two out of frame are scenery. Left in the reading of the
            // page they would be two more budgets to wade through, and two
            // more sets of buttons to tab into.
            inert={step !== 0 ? true : undefined}
            aria-hidden={step !== 0 ? true : undefined}
          >
            {step === 0 || armed ? children(addMonths(month, step)) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

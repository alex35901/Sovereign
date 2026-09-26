import { useRef } from "react";
import type { TouchEvent } from "react";

/**
 * Turning a screen that is one of a row of them.
 *
 * Touch only, and deliberately: a mouse drag across a page is a text
 * selection, and a trackpad's two-finger swipe is the browser's own way back
 * through history. On a phone there is no such thing to compete with, and
 * paging a month at a time by dragging is how every calendar on the device
 * already works.
 *
 * Nothing is prevented and nothing is captured. The page scrolls under the
 * finger exactly as it did; this only reads what the finger did, so a gesture
 * that turns out to be a scroll costs nothing and a tap that lands on a button
 * is still a tap on that button.
 *
 * The screen follows the finger one for one, because it is a row of screens
 * rather than one screen with an animation on it: dragging half a width shows
 * half of this month and half of the next, and where it ends up is wherever
 * the finger left it.
 */

/** A flick this far is meant, however briefly it lasted. */
export const SWIPE_MIN = 60;

/**
 * And straight enough. A drag that is mostly vertical is a scroll that
 * wandered, and paging the screen out from under it is the one thing a reader
 * scrolling a long sheet will not forgive.
 */
export const SWIPE_SLOPE = 1.7;

/** Quicker than this and a short drag still counts as a flick. */
export const SWIPE_MS = 700;

/**
 * How much of the screen has to be dragged away for it to go, when it was not
 * a flick.
 *
 * The two rules are different questions. A flick is "I meant that", judged on
 * speed over a short distance. This one is "look how far it has gone", and it
 * has no clock at all: a screen dragged a third of the way off and held there
 * is a screen somebody is deciding about, and it should land where they put it
 * however long they took.
 */
export const TURN_SHARE = 0.3;

/**
 * Below this the finger has not committed to a direction at all.
 *
 * For the move handler, which has to choose an axis and hold it. The end of
 * the gesture does not need it: nothing this short is far enough to be a
 * flick either.
 */
export const DRAG_WAKE = 8;

/**
 * What a finger's travel amounts to, if anything.
 *
 * Pulled out of the handler because this is the whole judgement: everything
 * around it is bookkeeping, and the ways of saying "that was not a swipe" are
 * what stop the screen paging out from under a scroll.
 */
export function turned(
  /** How far this finger moved. */
  moved: number,
  /** And where that leaves the thing it moved, which is not always the same. */
  total: number,
  dy: number,
  ms: number,
  width: number,
): "left" | "right" | null {
  // Straightness first, because it is the one that rules a gesture out
  // entirely rather than deciding how far it got.
  if (Math.abs(moved) < Math.abs(dy) * SWIPE_SLOPE) return null;

  // A flick goes the way the finger went, wherever the thing happened to be.
  // Catching one still moving and flicking it on again is asking for the next
  // one, and judging that on where it ended up would count the flick against
  // the distance the turn had already covered and swallow it.
  if (ms <= SWIPE_MS && Math.abs(moved) >= SWIPE_MIN) return moved < 0 ? "left" : "right";

  // Otherwise it is wherever it has been left: a screen pushed a third of the
  // way off and let go of is one somebody has decided about, however long they
  // took over it.
  if (!(width > 0 && Math.abs(total) >= width * TURN_SHARE)) return null;
  return total < 0 ? "left" : "right";
}

export interface Swipe {
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
  onTouchCancel: () => void;
}

interface From { x: number; y: number; at: number; axis: "?" | "x" | "y" }

/**
 * The handlers, given somewhere to put the answer.
 *
 * `onDrag` is called with where the finger has got to while it is down, and
 * `onEnd` with which way it went, if anywhere. Neither goes through React
 * state on purpose: a drag fires on every frame, and re-rendering a screen
 * sixty times a second to move it sideways is how a gesture ends up behind
 * the finger doing it.
 */
export function useSwipe(
  onDrag: (dx: number) => void,
  onEnd: (went: "left" | "right" | null) => void,
  width: () => number,
  /**
   * Where the thing being dragged already was when the finger landed on it.
   *
   * Nought nearly always. It is not when a finger catches something still
   * moving, and then it is the whole difference between picking it up where it
   * is and having it snap somewhere else first.
   */
  bias: () => number = () => 0,
): Swipe {
  const from = useRef<From | null>(null);
  return {
    onTouchStart: (e) => {
      // One finger. Two is a pinch or a scroll, and neither is this.
      const t = e.touches.length === 1 ? e.touches[0] : null;
      from.current = t ? { x: t.clientX, y: t.clientY, at: Date.now(), axis: "?" } : null;
    },
    onTouchMove: (e) => {
      const start = from.current;
      const t = e.touches[0];
      if (!start || !t) return;
      const moved = t.clientX - start.x;
      const fell = t.clientY - start.y;
      // Which way this gesture is going is decided once, at the moment it
      // becomes clear, and then held. Deciding it afresh on every move lets a
      // scroll that wanders sideways drag the screen along with it.
      if (start.axis === "?") {
        if (Math.abs(moved) < DRAG_WAKE && Math.abs(fell) < DRAG_WAKE) return;
        start.axis = Math.abs(moved) > Math.abs(fell) * SWIPE_SLOPE ? "x" : "y";
      }
      if (start.axis !== "x") return;
      onDrag(bias() + moved);
    },
    onTouchEnd: (e) => {
      const start = from.current;
      const t = e.changedTouches[0];
      from.current = null;
      if (!start || !t || start.axis !== "x") { onEnd(null); return; }
      // Judged on where it ended up rather than on how far this finger moved
      // it: something caught half way through a turn is already most of the
      // way somewhere, and a nudge from there is a decision.
      const moved = t.clientX - start.x;
      onEnd(turned(moved, bias() + moved, t.clientY - start.y, Date.now() - start.at, width()));
    },
    onTouchCancel: () => { from.current = null; onEnd(null); },
  };
}

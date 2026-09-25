import { useRef, useState } from "react";
import type { TouchEvent } from "react";

/**
 * A flick left or right, for a screen that is one of a series.
 *
 * Touch only, and deliberately: a mouse drag across a page is a text
 * selection, and a trackpad's two-finger swipe is the browser's own way back
 * through history. On a phone there is no such thing to compete with, and
 * paging a month at a time by flicking is how every calendar on the device
 * already works.
 *
 * Nothing is prevented and nothing is captured. The page scrolls under the
 * finger exactly as it did; this only reads what the finger did, so a gesture
 * that turns out to be a scroll costs nothing and a tap that lands on a button
 * is still a tap on that button.
 *
 * It reports where the finger is as well as what it did with it. A gesture
 * that only pays out at the end is a gesture you have to learn from a manual:
 * the thing under the finger has to move while the finger is on it, or there
 * is nothing to tell you the screen is the kind that can be turned.
 */

/** Far enough that it was meant, in pixels. */
export const SWIPE_MIN = 60;

/**
 * And straight enough. A drag that is mostly vertical is a scroll that
 * wandered, and paging the screen out from under it is the one thing a reader
 * scrolling a long sheet will not forgive.
 */
export const SWIPE_SLOPE = 1.7;

/** Longer than this and it is a drag, not a flick. */
export const SWIPE_MS = 700;

/**
 * What a finger's travel amounts to, if anything.
 *
 * Pulled out of the handler because this is the whole judgement: everything
 * around it is bookkeeping, and the three ways of saying "that was not a
 * swipe" are what stop the screen paging out from under a scroll.
 */
export function direction(dx: number, dy: number, ms: number): "left" | "right" | null {
  if (ms > SWIPE_MS) return null;
  if (Math.abs(dx) < SWIPE_MIN) return null;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_SLOPE) return null;
  return dx < 0 ? "left" : "right";
}

/**
 * How far the finger has to travel before the screen follows it.
 *
 * Small, but not nothing. A thumb settling on a row moves a few pixels, and a
 * page that shivers under every tap reads as something loose rather than
 * something responsive.
 */
export const DRAG_WAKE = 8;

/** And the furthest it will go, however far the finger does. */
export const DRAG_MAX = 110;

/**
 * What the screen shows for a finger that has travelled this far.
 *
 * One for one while it is still a question, and stiffer past the point where
 * letting go would turn the month: more travel beyond that says nothing new,
 * and a screen that slides clean off its own edge has stopped being a page
 * being turned and become a thing that fell over.
 */
export function drag(dx: number): number {
  const m = Math.abs(dx);
  const moved = m <= SWIPE_MIN ? m : SWIPE_MIN + (m - SWIPE_MIN) * 0.35;
  return Math.sign(dx) * Math.min(moved, DRAG_MAX);
}

export interface Swipe {
  handlers: {
    onTouchStart: (e: TouchEvent) => void;
    onTouchMove: (e: TouchEvent) => void;
    onTouchEnd: (e: TouchEvent) => void;
    onTouchCancel: () => void;
  };
  /** Where the screen should sit right now, in pixels. Nought when idle. */
  dx: number;
  /** Whether a finger is on it, so the caller can turn its easing off. */
  dragging: boolean;
}

interface From { x: number; y: number; at: number; axis: "?" | "x" | "y" }

export function useSwipe(onLeft: () => void, onRight: () => void): Swipe {
  const from = useRef<From | null>(null);
  const [dx, setDx] = useState(0);

  const rest = () => { from.current = null; setDx(0); };

  return {
    dx,
    dragging: dx !== 0,
    handlers: {
      onTouchStart: (e) => {
        // One finger. Two is a pinch or a scroll, and neither is this.
        const t = e.touches.length === 1 ? e.touches[0] : null;
        from.current = t ? { x: t.clientX, y: t.clientY, at: Date.now(), axis: "?" } : null;
        setDx(0);
      },
      onTouchMove: (e) => {
        const start = from.current;
        const t = e.touches[0];
        if (!start || !t) return;
        const moved = t.clientX - start.x;
        const fell = t.clientY - start.y;
        // Which way this gesture is going is decided once, at the moment it
        // becomes clear, and then held. Deciding it afresh on every move lets
        // a scroll that wanders sideways drag the page along with it.
        if (start.axis === "?") {
          if (Math.abs(moved) < DRAG_WAKE && Math.abs(fell) < DRAG_WAKE) return;
          start.axis = Math.abs(moved) > Math.abs(fell) * SWIPE_SLOPE ? "x" : "y";
        }
        if (start.axis !== "x") return;
        setDx(drag(moved));
      },
      onTouchEnd: (e) => {
        const start = from.current;
        const t = e.changedTouches[0];
        rest();
        if (!start || !t) return;
        const went = direction(t.clientX - start.x, t.clientY - start.y, Date.now() - start.at);
        if (went === "left") onLeft();
        else if (went === "right") onRight();
      },
      onTouchCancel: rest,
    },
  };
}

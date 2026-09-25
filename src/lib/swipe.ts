import { useRef } from "react";
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
 * finger exactly as it did; this only reads what the finger did afterwards,
 * so a gesture that turns out to be a scroll costs nothing and a tap that
 * lands on a button is still a tap on that button.
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

export interface Swipe {
  onTouchStart: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
}

export function useSwipe(onLeft: () => void, onRight: () => void): Swipe {
  const from = useRef<{ x: number; y: number; at: number } | null>(null);
  return {
    onTouchStart: (e) => {
      // One finger. Two is a pinch or a scroll, and neither is this.
      const t = e.touches.length === 1 ? e.touches[0] : null;
      from.current = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
    },
    onTouchEnd: (e) => {
      const start = from.current;
      from.current = null;
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const went = direction(t.clientX - start.x, t.clientY - start.y, Date.now() - start.at);
      if (went === "left") onLeft();
      else if (went === "right") onRight();
    },
  };
}

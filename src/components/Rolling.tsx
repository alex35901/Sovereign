import { useEffect, useRef } from "react";
import { useMediaQuery } from "../lib/media";
import { cx } from "./ui";
import { whenOpened } from "../lib/opening";

/**
 * The headline figure, following the pen as its chart is drawn.
 *
 * The companion to Reveal in charts.tsx, and it runs off the same signal and
 * the same clock. The wipe uncovers the line left to right over two seconds;
 * this reads the line at whatever point the wipe has reached and says that
 * figure, so the number starts where the chart starts, walks the series as it
 * appears, and arrives at today's figure exactly as the pen reaches the right
 * edge.
 *
 * Digits that are not changing do not move, which is what anybody actually
 * wants from this: a month that ran from 10,056 to 10,775 shows a "10," that
 * never flickers, because every figure in between begins with it. That falls
 * out of reading the real series rather than being a rule imposed on top.
 *
 * It replaces a per-digit odometer. Wheels looked right in a still frame and
 * wrong in motion: every one of them crawled between two numerals for most of
 * the animation and read as a figure stuck half way, and because the headline
 * is today's figure rather than the last plotted one, changing the timeframe
 * moved the chart without moving the number and nothing ran at all.
 */

/** As long as the wipe in index.css, because it is following it. */
export const REVEAL_MS = 2000;

/** The wipe's own curve, so the figure sits under the pen and not behind it. */
const CURVE = [0.37, 0, 0.63, 1] as const;

/**
 * One axis of a cubic bezier whose ends are pinned at 0 and 1.
 *
 * The usual polynomial form: three coefficients worked out from the two
 * control points.
 */
const axis = (t: number, a: number, b: number): number => {
  const c = 3 * a;
  const d = 3 * (b - a) - c;
  const e = 1 - c - d;
  return ((e * t + d) * t + c) * t;
};

/**
 * The CSS easing, solved in JavaScript.
 *
 * A cubic bezier gives y from a parameter, not from x, so x has to be solved
 * for first. Binary subdivision rather than Newton: it is a handful of
 * iterations either way, this one cannot run away on a flat stretch of the
 * curve, and this is a curve with one.
 */
export function ease(x: number, curve: readonly number[] = CURVE): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 24; i++) {
    const at = axis(t, curve[0]!, curve[2]!);
    if (Math.abs(at - x) < 1e-5) break;
    if (at < x) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return axis(t, curve[1]!, curve[3]!);
}

/**
 * Where the line is, a given fraction of the way along it.
 *
 * Interpolated between the two points either side rather than snapped to the
 * nearer one, because the line itself is drawn straight between them: the pen
 * really is at the figure this returns. Both ends are exact, so it opens on
 * the first point and lands on the last.
 */
export function valueAt(path: readonly number[], p: number): number {
  if (!path.length) return 0;
  if (path.length === 1) return path[0]!;
  if (!(p > 0)) return path[0]!;
  if (p >= 1) return path[path.length - 1]!;
  const span = (path.length - 1) * p;
  const i = Math.floor(span);
  const a = path[i]!;
  const b = path[i + 1] ?? a;
  return a + (b - a) * (span - i);
}

/** Whether there is anything to watch: a flat line has nothing to count. */
export const worthRolling = (path: readonly number[]): boolean =>
  path.length > 1 && path.some((v) => v !== path[0]);

export function Rolling({ value, through, format, run, className }: {
  /** Where it ends, and what the figure says at every moment regardless. */
  value: number;
  /** The line it follows on the way there. */
  through: readonly number[];
  format: (n: number) => string;
  /**
   * What makes it run again: the same signature the wipe uses. It changes when
   * the series changes, including when the timeframe does, and stands still
   * while a finger moves over the chart.
   */
  run: string;
  className?: string;
}) {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const node = useRef<HTMLSpanElement>(null);
  const seenRun = useRef<string | null>(null);
  const frame = useRef(0);
  // Held in a ref so a caller passing a fresh function on every render does
  // not restart the walk under its own feet.
  const write = useRef(format);
  write.current = format;

  /**
   * One effect, not two.
   *
   * The run and the figure change together when the timeframe moves, so a
   * separate effect watching the figure would cancel the walk the first one
   * had just started: effects run in order and the second would always win.
   * Which of the two happened is decided here instead.
   */
  useEffect(() => {
    const el = node.current;
    if (!el) return;
    const stop = () => {
      cancelAnimationFrame(frame.current);
      el.classList.remove("rolling-on");
      el.style.removeProperty("--roll-text");
    };

    const fresh = seenRun.current !== run;
    seenRun.current = run;
    // The same chart, a different figure: a finger is on it. The figure is
    // following the finger now, and a walk still running underneath would be
    // answering a question nobody is asking any more.
    if (!fresh) { stop(); return; }
    if (still) return;

    const path = [...through];
    // The headline is today's figure, which is not always the last point
    // plotted, so it is the last step of the walk rather than left off it.
    if (path.length && path[path.length - 1] !== value) path.push(value);
    if (!worthRolling(path)) return;

    /*
     * Not before the opening is over.
     *
     * The figure walks in step with the chart being drawn beside it, and the
     * chart is held at the start line while the rabbit is on screen. Starting
     * this on mount regardless meant the walk happened behind the opening and
     * the figure was simply sitting at its final value when the screen was
     * uncovered, with the chart only then beginning to draw.
     *
     * A clock is no good here: what it is waiting for is an event.
     */
    const begin = () => {
      const begun = performance.now();
      el.classList.add("rolling-on");
      const step = () => {
        const p = Math.min(1, (performance.now() - begun) / REVEAL_MS);
        const at = valueAt(path, ease(p));
        // Through the pseudo-element, which is read by nothing and copied by
        // nothing: the figure in the span stays the figure throughout, so what
        // this says and what can be taken off it never disagree.
        el.style.setProperty("--roll-text", JSON.stringify(write.current(at)));
        if (p < 1) { frame.current = requestAnimationFrame(step); return; }
        stop();
      };
      frame.current = requestAnimationFrame(step);
    };

    const waiting = whenOpened(begin);
    return () => { waiting(); stop(); };
    // `through` is left out on purpose: it is a fresh array on every render
    // and `run` is the signature of what is in it, which is the whole reason
    // that signature exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, value, still]);

  return <span ref={node} className={cx("num rolling", className)}>{format(value)}</span>;
}

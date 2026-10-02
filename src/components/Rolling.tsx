import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../lib/media";
import { cx } from "./ui";

/**
 * The headline figure, rolled into place like an odometer while its chart
 * draws itself in.
 *
 * The companion to Reveal in charts.tsx, and it runs off the same signal: when
 * the series changes the line is wiped in again, and the number above it
 * should arrive the same way rather than snapping to its answer a second and a
 * half before the line gets there.
 *
 * Only the digits that actually changed move. Going from 10,056 to 10,775 the
 * "10," is the same figure it was and a wheel spinning under it would be
 * saying something happened there that did not. Everything from the first
 * digit that differs rightward turns, which is what the lower wheels of a real
 * odometer do, and everything to its left stands still.
 */

/** One character of the figure, and where its wheel starts and stops. */
export interface Slot {
  /** What is finally shown here. */
  ch: string;
  /** Where the wheel starts, in digit positions. Absent means it does not turn. */
  from?: number;
  /** Where it stops: whole spins, plus the digit to land on. */
  to?: number;
}

/** How many times a turning wheel comes all the way round before it lands. */
export const SPINS = 2;

/**
 * What each character of `to` does, given what was there before.
 *
 * The two are lined up from the right, because that is how a number grows: a
 * figure that gained a digit has had every column shift along, and comparing
 * from the left would call every one of them changed.
 */
export function reels(from: string, to: string, spins = SPINS): Slot[] {
  // Padded on the left when the old figure was shorter, trimmed from the left
  // when it was longer: either way the columns line up at the units.
  const was = from.length >= to.length
    ? from.slice(from.length - to.length)
    : " ".repeat(to.length - from.length) + from;

  let first = to.length;
  for (let i = 0; i < to.length; i++) {
    if (to[i] !== was[i]) { first = i; break; }
  }

  return [...to].map((ch, i) => {
    // Nothing to the left of the first change moves, and a comma is not a
    // wheel: the separators sit still while the digits turn past them.
    if (i < first || ch < "0" || ch > "9") return { ch };
    const had = was[i] ?? "";
    const start = had >= "0" && had <= "9" ? Number(had) : 0;
    return { ch, from: start, to: spins * 10 + Number(ch) };
  });
}

/** How long one wheel takes, and how much longer each one to its right takes. */
const BASE_MS = 900;
const STEP_MS = 90;
/** Never longer than the wipe it accompanies, which is two seconds. */
const LONGEST_MS = 1900;

/** The whole roll, which is however long its slowest wheel takes. */
export function rollMs(slots: readonly Slot[]): number {
  const turning = slots.filter((s) => s.to !== undefined).length;
  return turning ? Math.min(LONGEST_MS, BASE_MS + (turning - 1) * STEP_MS) : 0;
}

/** One wheel's own duration, so the leftmost settles first and the units last. */
export function wheelMs(index: number, total: number): number {
  const span = rollMs(Array.from({ length: total }, () => ({ ch: "0", from: 0, to: 0 })));
  return total <= 1 ? span : BASE_MS + ((span - BASE_MS) * index) / (total - 1);
}

export function Rolling({ value, format, run, className }: {
  value: number;
  /** How the figure is written. Both ends of the roll go through this. */
  format: (n: number) => string;
  /**
   * What makes it run again. The same rule Reveal follows: it changes when the
   * series changes and stands still while a finger moves over the chart, or
   * every scrub would set the wheels going.
   */
  run: string;
  className?: string;
}) {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [roll, setRoll] = useState<{ slots: Slot[]; ms: number; seq: number } | null>(null);
  const seenRun = useRef<string | null>(null);
  const settled = useRef(value);
  const seq = useRef(0);

  useEffect(() => {
    if (seenRun.current === run) {
      // The same chart, a different figure: a finger is on it. Snap, and drop
      // any roll still running, whose ending digits are now the wrong ones.
      settled.current = value;
      setRoll((cur) => (cur ? null : cur));
      return;
    }
    const first = seenRun.current === null;
    const from = first ? 0 : settled.current;
    seenRun.current = run;
    settled.current = value;
    if (still) return;
    const slots = reels(format(from), format(value));
    const ms = rollMs(slots);
    if (ms > 0) { seq.current += 1; setRoll({ slots, ms, seq: seq.current }); }
  }, [run, value, format, still]);

  // Cleared on a timer rather than on the animation's own event: the event
  // comes from a pseudo-element, there is one per wheel, and the last to
  // finish is not always the last in the list once a figure changes length.
  useEffect(() => {
    if (!roll) return;
    const t = window.setTimeout(() => setRoll(null), roll.ms + 60);
    return () => window.clearTimeout(t);
  }, [roll]);

  const text = format(value);
  if (!roll) return <span className={cx("num", className)}>{text}</span>;

  const turning = roll.slots.filter((s) => s.to !== undefined).length;
  let nth = -1;
  return (
    <span className={cx("num rolling", className)} key={roll.seq}>
      {/* Every character in the same kind of box, turning or not. A wheel has
          to clip, a clipping inline-block takes its baseline from its bottom
          edge rather than from its text, and a figure where only some of the
          characters did that would sit on two baselines at once. */}
      {roll.slots.map((s, i) => {
        if (s.to === undefined) return <span key={i} className="reel">{s.ch}</span>;
        nth += 1;
        return (
          <span
            key={i}
            className="reel turn"
            style={{
              "--reel-from": s.from,
              "--reel-to": s.to,
              "--reel-ms": `${Math.round(wheelMs(nth, turning))}ms`,
            } as React.CSSProperties}
          >
            {/* The real character, kept in the text so that what the figure
                says and what can be read off it never disagree, including
                while it is turning. Hidden by opacity rather than by
                visibility, which would take it out of the text as well. */}
            <span className="reel-end">{s.ch}</span>
          </span>
        );
      })}
    </span>
  );
}

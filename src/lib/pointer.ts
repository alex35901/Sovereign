/**
 * Whether the thing pointing at this app is a finger.
 *
 * Asked so a search box above a list can decide whether to take focus when it
 * opens. Under a mouse it should: the menu was opened to find something, and
 * typing is how you find it. On a phone it must not, because the keyboard
 * comes up over the list the menu was opened to look at, and the first thing
 * you do is dismiss it.
 *
 * Capability rather than width, and asked at the moment it matters rather than
 * cached, because a tablet with a keyboard attached can be both in one session.
 */
export const coarsePointer = (): boolean =>
  typeof window !== "undefined"
  && typeof window.matchMedia === "function"
  && window.matchMedia("(pointer: coarse)").matches;

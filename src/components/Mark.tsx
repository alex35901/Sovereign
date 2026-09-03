/**
 * The app's mark: a leaping rabbit, the same drawing as public/icon.svg.
 *
 * Kept in step by hand rather than imported, because the icon has to be a
 * standalone file for the home screen and this has to be inline to take its
 * colour from CSS — but it is one drawing, and changing one without the other
 * is the thing to watch for.
 *
 * The body is currentColor and the eye is a hole: it takes the colour behind
 * the mark rather than being drawn, so the whole logo is two colours and there
 * is no third one to get wrong.
 */
export function Mark({ size = 26, cut = "var(--accent)" }: {
  size?: number;
  /** Whatever the mark is sitting on — the eye is painted in it. */
  cut?: string;
}) {
  return (
    <svg
      width={size} height={size}
      // The drawing's own bounding box with a few units of air, so the rabbit
      // fills the space it is given instead of floating inside the margin the
      // home screen icon needs.
      viewBox="134 43 262 312"
      aria-hidden="true" focusable="false"
    >
      <g fill="currentColor">
        <path d="M140 300 C176 352 250 366 306 326 C340 302 360 272 348 250
                 C336 228 310 230 298 246 C262 278 200 304 140 300 Z"/>
        <ellipse cx="326" cy="196" rx="50" ry="44"/>
        <path d="M352 184 C384 188 396 208 386 224 C376 238 350 238 340 226 Z"/>
        <path d="M304 160 C282 128 264 92 258 70 C254 56 272 50 280 64
                 C300 96 320 130 328 156 Z"/>
        <path d="M336 154 C342 116 352 80 360 58 C364 44 382 48 380 62
                 C376 96 366 132 354 160 Z"/>
        <ellipse cx="176" cy="246" rx="23" ry="17" transform="rotate(-16 176 246)"/>
      </g>
      <circle cx="344" cy="186" r="10" fill={cut}/>
    </svg>
  );
}

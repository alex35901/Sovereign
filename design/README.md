# Logo candidates

Three rabbit marks in the house style of the reference that prompted them: one
uniform open stroke, round caps and joins, no fills, symmetric about the
vertical axis, white on the brand orange.

Nothing here is wired into the app. `public/icon.svg` is still the diamond;
when one of these is chosen, it replaces that file and `npm run icons`
regenerates the PNGs the phone actually uses.

| File | What it is |
| --- | --- |
| `rabbit-hare.svg` | One unbroken line — a head with the ears splayed off its crown. |
| `rabbit-ribbon.svg` | The ears cross at a neck, the way the reference's wings cross at a waist. |
| `rabbit-sovereign.svg` | Ears raked back to leave the crown of the head free for a crown. |

Three things the drawing has to obey, each learned by breaking it:

- **The loops must be wide open relative to the stroke.** At 42 units on a 512
  grid, a loop narrower than about 90 units has no negative space left once the
  line is drawn through it, and the mark turns into a blob.
- **Never send three strands through the same place.** Two crossing strokes
  read as a crossing; three read as a lump. Every place the ears meet the head
  is a two-strand crossing.
- **Four symmetric loops around one waist is a butterfly**, whatever shape the
  loops are. A rabbit needs a head that is a mass, with the ears standing on it.

The crowned one carries a different ear rake from the other two on purpose: with
ears upright there is nowhere for a crown to go that is not already taken, and a
crown squeezed into a 100-unit gap at this stroke weight reads as a sawtooth.
Raking the ears back opens the crown of the head, which is where a crown goes.

Every candidate was checked at 220, 96, 60 and 32 px, in white, in the dark ink
the current icon uses, and in orange on the dark surface — 32px is the sidebar
brand mark, and it is the size that kills a mark.

/**
 * Choosing the passphrase that seals the document.
 *
 * Separate from crypto.ts because none of this is cryptography — it is the
 * human half, and it is the half that actually went wrong: a passphrase set in
 * one sitting, never written down, and confused with the entirely different
 * one that lives in Vercel.
 *
 * The generator is here for that last reason as much as for strength. A phrase
 * of random words is obviously not the server password, which no amount of
 * explanatory text achieves as reliably as simply not looking like it.
 */

/**
 * Short, common, unambiguous words.
 *
 * Deliberately 256 of them, so each one is exactly one byte of choice and the
 * arithmetic below needs no rounding or apology. No words that sound alike
 * when read aloud down a phone, and none under three letters.
 */
const WORDS = [
  "amber", "anchor", "apple", "arrow", "attic", "autumn", "bacon", "badge",
  "bakery", "balloon", "bamboo", "banjo", "barley", "basket", "beacon", "beetle",
  "bellow", "bench", "berry", "bishop", "bison", "blanket", "blossom", "bobcat",
  "bonfire", "bottle", "boulder", "bracket", "branch", "brass", "bridge", "bronze",
  "brook", "bucket", "buffalo", "bundle", "burrow", "button", "cabin", "cactus",
  "camel", "candle", "canoe", "canvas", "canyon", "caramel", "cargo", "carpet",
  "carrot", "castle", "cattle", "cedar", "cellar", "cement", "chalk", "cherry",
  "chimney", "chisel", "cider", "cinder", "circus", "clover", "cobalt", "cocoa",
  "collar", "comet", "compass", "copper", "coral", "cotton", "cougar", "crater",
  "crayon", "cricket", "crimson", "crystal", "cuckoo", "curtain", "cushion", "cymbal",
  "daisy", "dagger", "damson", "dolphin", "domino", "donkey", "dragon", "drawer",
  "driftwood", "drummer", "dugout", "dumpling", "eagle", "ember", "emerald", "engine",
  "escape", "falcon", "fennel", "ferry", "fiddle", "filbert", "flamingo", "flannel",
  "flask", "flint", "floral", "flute", "forest", "fossil", "fountain", "foxglove",
  "freckle", "frost", "gable", "gallop", "garden", "garlic", "gecko", "geyser",
  "ginger", "glacier", "glimmer", "granite", "gravel", "grotto", "guitar", "gully",
  "hammer", "hamster", "harbour", "harvest", "hazel", "heather", "hedgehog", "helmet",
  "heron", "hickory", "hollow", "honey", "hornet", "hurdle", "iceberg", "igloo",
  "indigo", "inkwell", "ivory", "jackal", "jasmine", "jersey", "jigsaw", "jungle",
  "juniper", "kettle", "keystone", "kitten", "koala", "ladder", "lagoon", "lantern",
  "lattice", "lavender", "ledger", "lemon", "leopard", "lichen", "lilac", "linen",
  "lobster", "locket", "lumber", "magnet", "magpie", "mallard", "mammoth", "mango",
  "maple", "marble", "marigold", "marsh", "meadow", "medal", "melon", "mermaid",
  "meteor", "mildew", "mimosa", "mineral", "minnow", "mitten", "monsoon", "moss",
  "mustard", "narwhal", "nectar", "needle", "nickel", "noodle", "nutmeg", "oatmeal",
  "obsidian", "octopus", "olive", "onyx", "opal", "orbit", "orchard", "orchid",
  "otter", "oyster", "paddle", "pancake", "panther", "papaya", "parcel", "parsley",
  "pasture", "pebble", "pelican", "pepper", "petal", "pewter", "phantom", "pigeon",
  "pillow", "pinecone", "pistol", "planet", "plaster", "plover", "plumage", "pocket",
  "pollen", "poppy", "porridge", "possum", "pottery", "prairie", "pretzel", "prism",
  "pudding", "puffin", "pumpkin", "quarry", "quartz", "quiver", "rabbit", "radish",
  "rafter", "rainbow", "raisin", "rattle", "raven", "ribbon", "rocket", "rooster",
] as const;

/** Bits of choice per word. Exact, because the list is a power of two. */
export const BITS_PER_WORD = Math.log2(WORDS.length);

/** How many words the generator uses, and why. */
export const WORD_COUNT = 6;

/**
 * A phrase nobody has to invent.
 *
 * crypto.getRandomValues, not Math.random: this is the key to everything in
 * the document, and a predictable generator would make the whole exercise
 * decorative. Rejection sampling keeps every word equally likely — taking a
 * random byte modulo the list length would quietly favour the first few.
 */
export function generate(words = WORD_COUNT): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  while (out.length < words) {
    crypto.getRandomValues(buf);
    // With 256 words every byte is in range, so this never actually rejects.
    // It is here so the list can change size without silently going lopsided.
    const limit = Math.floor(256 / WORDS.length) * WORDS.length;
    if (buf[0]! >= limit) continue;
    out.push(WORDS[buf[0]! % WORDS.length]!);
  }
  return out.join("-");
}

/** What a generated phrase is worth, said plainly rather than as a bar. */
export const generatedBits = (words = WORD_COUNT): number => Math.round(words * BITS_PER_WORD);

/** A short passphrase behind AES is weaker than a short one behind a rate limiter. */
export const MIN = 12;

export interface Strength { ok: boolean; note: string }

export function strength(p: string): Strength {
  if (p.length < MIN) return { ok: false, note: `At least ${MIN} characters — this one is ${p.length}.` };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 20 && classes < 3) {
    return { ok: true, note: "Workable, but a longer phrase of several words would be much stronger." };
  }
  return { ok: true, note: "Long enough. What matters now is that it is written down somewhere." };
}

/**
 * Whether the second typing matched the first.
 *
 * Trimmed on both sides because the thing that gets sealed is trimmed too, so
 * a trailing space must not be the difference between matching and not.
 */
export const matches = (a: string, b: string): boolean =>
  a.trim().length > 0 && a.trim() === b.trim();

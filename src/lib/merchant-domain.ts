import { iconFor } from "./icon.js";

/**
 * The domain behind a merchant name, for merchants worth recognising.
 *
 * A list rather than a guess. Turning "Starbucks" into starbucks.com is easy
 * and turning "Dr Ellen Yao Dds" into a domain is not — and the difference
 * matters, because a guess would send every string a bank ever put on a
 * statement to an icon service. Names of people, small businesses and the odd
 * medical practice among them.
 *
 * So the lookup only ever resolves to a brand on this list, and everything
 * else keeps the lettered avatar it has today. What the icon service learns is
 * that somebody shops at well-known chains, which it could have guessed.
 */

/* Normalised key → domain. Keys are lower case, letters and digits only,
   single-spaced — whatever `normalize` produces. */
const BRANDS: Record<string, string> = {
  /* groceries and warehouse */
  costco: "costco.com", "costco wholesale": "costco.com", "sams club": "samsclub.com",
  kroger: "kroger.com", safeway: "safeway.com", albertsons: "albertsons.com",
  publix: "publix.com", wegmans: "wegmans.com", "whole foods": "wholefoodsmarket.com",
  "trader joes": "traderjoes.com", aldi: "aldi.us", lidl: "lidl.com", sprouts: "sprouts.com",
  heb: "heb.com", meijer: "meijer.com", "stop and shop": "stopandshop.com",
  "food lion": "foodlion.com", winco: "wincofoods.com", vons: "vons.com", ralphs: "ralphs.com",
  "harris teeter": "harristeeter.com", "hy vee": "hy-vee.com", "fred meyer": "fredmeyer.com",
  shoprite: "shoprite.com", "giant eagle": "gianteagle.com", "market basket": "shopmarketbasket.com",

  /* big box, home and general retail */
  target: "target.com", walmart: "walmart.com", amazon: "amazon.com",
  "amzn mktp": "amazon.com", "amazon marketplace": "amazon.com", "amazon prime": "amazon.com",
  "best buy": "bestbuy.com", ikea: "ikea.com", "home depot": "homedepot.com",
  lowes: "lowes.com", menards: "menards.com", "ace hardware": "acehardware.com",
  "tractor supply": "tractorsupply.com", michaels: "michaels.com", "hobby lobby": "hobbylobby.com",
  joann: "joann.com", "dollar general": "dollargeneral.com", "dollar tree": "dollartree.com",
  "family dollar": "familydollar.com", "five below": "fivebelow.com", "big lots": "biglots.com",
  wayfair: "wayfair.com", overstock: "overstock.com", etsy: "etsy.com", ebay: "ebay.com",
  temu: "temu.com", shein: "shein.com", chewy: "chewy.com", petco: "petco.com",
  petsmart: "petsmart.com", staples: "staples.com", "office depot": "officedepot.com",

  /* clothing */
  "tj maxx": "tjmaxx.com", marshalls: "marshalls.com", homegoods: "homegoods.com",
  ross: "rossstores.com", nordstrom: "nordstrom.com", macys: "macys.com", kohls: "kohls.com",
  jcpenney: "jcpenney.com", dillards: "dillards.com", "old navy": "oldnavy.com",
  gap: "gap.com", "banana republic": "bananarepublic.com", "j crew": "jcrew.com",
  uniqlo: "uniqlo.com", zara: "zara.com", "h and m": "hm.com", lululemon: "lululemon.com",
  nike: "nike.com", adidas: "adidas.com", "under armour": "underarmour.com",
  rei: "rei.com", patagonia: "patagonia.com", columbia: "columbia.com",
  "dicks sporting goods": "dickssportinggoods.com", "academy sports": "academy.com",
  "bass pro": "basspro.com", cabelas: "cabelas.com", "foot locker": "footlocker.com",
  sephora: "sephora.com", ulta: "ulta.com", "bath and body works": "bathandbodyworks.com",
  "american eagle": "ae.com", "urban outfitters": "urbanoutfitters.com",
  anthropologie: "anthropologie.com", madewell: "madewell.com", "warby parker": "warbyparker.com",

  /* coffee and quick food */
  starbucks: "starbucks.com", dunkin: "dunkindonuts.com", peets: "peets.com",
  "caribou coffee": "cariboucoffee.com", "tim hortons": "timhortons.com",
  "blue bottle": "bluebottlecoffee.com", "la colombe": "lacolombe.com",
  panera: "panerabread.com", chipotle: "chipotle.com", mcdonalds: "mcdonalds.com",
  "burger king": "bk.com", wendys: "wendys.com", "taco bell": "tacobell.com",
  kfc: "kfc.com", popeyes: "popeyes.com", "chick fil a": "chick-fil-a.com",
  subway: "subway.com", "jimmy johns": "jimmyjohns.com", "jersey mikes": "jerseymikes.com",
  potbelly: "potbelly.com", "five guys": "fiveguys.com", "shake shack": "shakeshack.com",
  "in n out": "in-n-out.com", whataburger: "whataburger.com", culvers: "culvers.com",
  sonic: "sonicdrivein.com", arbys: "arbys.com", "dairy queen": "dairyqueen.com",
  "jack in the box": "jackinthebox.com", "del taco": "deltaco.com",
  "raising canes": "raisingcanes.com", zaxbys: "zaxbys.com", wingstop: "wingstop.com",
  "buffalo wild wings": "buffalowildwings.com", dominos: "dominos.com",
  "pizza hut": "pizzahut.com", "papa johns": "papajohns.com", "little caesars": "littlecaesars.com",
  "blaze pizza": "blazepizza.com", sweetgreen: "sweetgreen.com", cava: "cava.com",
  qdoba: "qdoba.com", "panda express": "pandaexpress.com",
  "noodles and company": "noodles.com",

  /* sit-down restaurants */
  "olive garden": "olivegarden.com", applebees: "applebees.com", chilis: "chilis.com",
  "outback steakhouse": "outback.com", "texas roadhouse": "texasroadhouse.com",
  "red lobster": "redlobster.com", "cheesecake factory": "thecheesecakefactory.com",
  ihop: "ihop.com", dennys: "dennys.com", "waffle house": "wafflehouse.com",
  "cracker barrel": "crackerbarrel.com", "red robin": "redrobin.com", "pf changs": "pfchangs.com",

  /* delivery and getting about */
  doordash: "doordash.com", uber: "uber.com", "uber eats": "ubereats.com",
  ubereats: "ubereats.com", lyft: "lyft.com", grubhub: "grubhub.com",
  instacart: "instacart.com", postmates: "postmates.com", gopuff: "gopuff.com",
  amtrak: "amtrak.com", greyhound: "greyhound.com",

  /* fuel and motoring */
  shell: "shell.com", chevron: "chevron.com", exxon: "exxon.com", exxonmobil: "exxon.com",
  mobil: "mobil.com", bp: "bp.com", texaco: "texaco.com", marathon: "marathonbrand.com",
  speedway: "speedway.com", wawa: "wawa.com", sheetz: "sheetz.com", quiktrip: "quiktrip.com",
  "circle k": "circlek.com", caseys: "caseys.com", "pilot travel": "pilotflyingj.com",
  sunoco: "sunoco.com", valero: "valero.com", arco: "arco.com", "phillips 66": "phillips66.com",
  autozone: "autozone.com", oreilly: "oreillyauto.com", "advance auto parts": "advanceautoparts.com",
  "napa auto parts": "napaonline.com", "jiffy lube": "jiffylube.com", valvoline: "valvoline.com",
  "discount tire": "discounttire.com", "les schwab": "lesschwab.com", firestone: "firestone.com",
  midas: "midas.com", "pep boys": "pepboys.com", carmax: "carmax.com", carvana: "carvana.com",
  tesla: "tesla.com",

  /* pharmacy and health */
  cvs: "cvs.com", walgreens: "walgreens.com", "rite aid": "riteaid.com",
  goodrx: "goodrx.com", "quest diagnostics": "questdiagnostics.com", labcorp: "labcorp.com",
  "one medical": "onemedical.com", teladoc: "teladoc.com",

  /* subscriptions, software and streaming */
  netflix: "netflix.com", spotify: "spotify.com", hulu: "hulu.com", disney: "disney.com",
  "disney plus": "disneyplus.com", max: "max.com", "hbo max": "max.com",
  "paramount plus": "paramountplus.com", peacock: "peacocktv.com", apple: "apple.com",
  itunes: "apple.com", google: "google.com", youtube: "youtube.com", audible: "audible.com",
  dropbox: "dropbox.com", adobe: "adobe.com", microsoft: "microsoft.com", xbox: "xbox.com",
  playstation: "playstation.com", nintendo: "nintendo.com", steam: "steampowered.com",
  twitch: "twitch.tv", patreon: "patreon.com", substack: "substack.com", notion: "notion.so",
  slack: "slack.com", zoom: "zoom.us", github: "github.com", openai: "openai.com",
  chatgpt: "openai.com", anthropic: "anthropic.com", claude: "anthropic.com",
  figma: "figma.com", canva: "canva.com", "1password": "1password.com",
  nordvpn: "nordvpn.com", backblaze: "backblaze.com", squarespace: "squarespace.com",
  godaddy: "godaddy.com", namecheap: "namecheap.com", cloudflare: "cloudflare.com",
  vercel: "vercel.com", digitalocean: "digitalocean.com", mailchimp: "mailchimp.com",
  grammarly: "grammarly.com", duolingo: "duolingo.com", masterclass: "masterclass.com",
  coursera: "coursera.org", udemy: "udemy.com", audiblecom: "audible.com",

  /* phones, internet and television */
  verizon: "verizon.com", att: "att.com", "at t": "att.com", "t mobile": "t-mobile.com",
  tmobile: "t-mobile.com", xfinity: "xfinity.com", comcast: "xfinity.com",
  spectrum: "spectrum.com", cox: "cox.com", centurylink: "centurylink.com",
  "google fi": "fi.google.com", "mint mobile": "mintmobile.com", visible: "visible.com",
  "boost mobile": "boostmobile.com", "cricket wireless": "cricketwireless.com",
  dish: "dish.com", directv: "directv.com",

  /* travel */
  delta: "delta.com", united: "united.com", "american airlines": "aa.com",
  southwest: "southwest.com", jetblue: "jetblue.com", "alaska airlines": "alaskaair.com",
  "spirit airlines": "spirit.com", "frontier airlines": "flyfrontier.com",
  "hawaiian airlines": "hawaiianairlines.com", marriott: "marriott.com", hilton: "hilton.com",
  hyatt: "hyatt.com", ihg: "ihg.com", wyndham: "wyndhamhotels.com",
  "best western": "bestwestern.com", airbnb: "airbnb.com", vrbo: "vrbo.com",
  booking: "booking.com", expedia: "expedia.com", priceline: "priceline.com",
  kayak: "kayak.com", tripadvisor: "tripadvisor.com", hertz: "hertz.com", avis: "avis.com",
  enterprise: "enterprise.com", alamo: "alamo.com", turo: "turo.com",

  /* money and insurance */
  chase: "chase.com", "bank of america": "bankofamerica.com", "wells fargo": "wellsfargo.com",
  citi: "citi.com", "capital one": "capitalone.com", amex: "americanexpress.com",
  "american express": "americanexpress.com", discover: "discover.com", usaa: "usaa.com",
  "navy federal": "navyfederal.org", ally: "ally.com", sofi: "sofi.com",
  robinhood: "robinhood.com", fidelity: "fidelity.com", vanguard: "vanguard.com",
  schwab: "schwab.com", "charles schwab": "schwab.com", etrade: "etrade.com",
  coinbase: "coinbase.com", venmo: "venmo.com", paypal: "paypal.com",
  "cash app": "cash.app", wise: "wise.com", geico: "geico.com", progressive: "progressive.com",
  "state farm": "statefarm.com", allstate: "allstate.com", "liberty mutual": "libertymutual.com",
  nationwide: "nationwide.com", farmers: "farmers.com", aaa: "aaa.com", lemonade: "lemonade.com",

  /* home services and boxes */
  adt: "adt.com", ring: "ring.com", simplisafe: "simplisafe.com", terminix: "terminix.com",
  orkin: "orkin.com", angi: "angi.com", thumbtack: "thumbtack.com",
  "stitch fix": "stitchfix.com", "blue apron": "blueapron.com", hellofresh: "hellofresh.com",
  "hello fresh": "hellofresh.com", factor: "factor75.com",

  /* fitness */
  "planet fitness": "planetfitness.com", "la fitness": "lafitness.com", equinox: "equinox.com",
  orangetheory: "orangetheory.com", peloton: "onepeloton.com", classpass: "classpass.com",
  ymca: "ymca.net", "life time": "lifetime.life", "anytime fitness": "anytimefitness.com",
};

/**
 * Card processors, which staple their own name to the front.
 *
 * "SQ *BLUE BOTTLE" is Blue Bottle's transaction, not Square's, and showing
 * Square's logo on forty different coffee shops would be worse than showing
 * none. Stripped before matching, so the real merchant is what gets looked up.
 */
const PROCESSORS = ["sq", "tst", "sp", "pp", "paypal", "toast", "square", "clover"];

/**
 * Lower case, letters and digits only, single-spaced.
 *
 * Apostrophes go before anything else rather than becoming spaces: "Trader
 * Joe's" is one word ending in s, and splitting it leaves a stray "s" that
 * matches nothing.
 */
export const normalize = (name: string): string =>
  name.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’ʼ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Keys grouped by first word.
 *
 * A transaction list is a few hundred rows, and walking every brand for each
 * one is work nobody needs: the first word narrows it to a handful, and the
 * longest of those wins so "costco gas" reaches Costco and "costco" alone
 * doesn't beat a longer key that also matched.
 */
const BY_FIRST = ((): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  for (const key of Object.keys(BRANDS)) {
    const head = key.split(" ")[0]!;
    const bucket = index.get(head);
    if (bucket) bucket.push(key);
    else index.set(head, [key]);
  }
  for (const bucket of index.values()) bucket.sort((a, b) => b.length - a.length);
  return index;
})();

const cache = new Map<string, string | null>();

/** The domain for this merchant, or null when it isn't one we know. */
export function domainFor(merchant: string): string | null {
  const held = cache.get(merchant);
  if (held !== undefined) return held;

  let n = normalize(merchant);
  for (const p of PROCESSORS) {
    if (n.startsWith(`${p} `)) { n = n.slice(p.length + 1); break; }
  }

  let found: string | null = null;
  const head = n.split(" ")[0];
  if (head) {
    for (const key of BY_FIRST.get(head) ?? []) {
      // Whole words only: "target" matches "Target Optical" and not "Targeted".
      if (n === key || n.startsWith(`${key} `)) { found = BRANDS[key]!; break; }
    }
  }

  cache.set(merchant, found);
  return found;
}

/** The logo for this merchant, or null to leave the lettered avatar alone. */
export function logoFor(merchant: string): string | null {
  const domain = domainFor(merchant);
  return domain ? iconFor(domain) : null;
}

/** How many brands are recognised, for saying so in Settings. */
export const BRAND_COUNT = Object.keys(BRANDS).length;

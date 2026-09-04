/**
 * Where a logo comes from.
 *
 * DuckDuckGo's icon service, chosen for being run by a company that sells no
 * advertising. Every lookup tells it something — which banks, which shops — so
 * both callers are behind a setting rather than an assumption, and both fall
 * back to initials when the image doesn't load.
 */
export const iconFor = (domain: string): string =>
  `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;

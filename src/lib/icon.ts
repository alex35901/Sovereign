/**
 * Where a logo comes from.
 *
 * Through this app's own function rather than straight to an icon service, for
 * two reasons. The service would otherwise see the reader's address alongside
 * the name of every bank and shop they use; and when it has no icon it answers
 * with a placeholder rather than a 404, so the page's fallback never fired and
 * some brands showed a grey circle belonging to nobody. api/icon.ts has the
 * rest of it.
 *
 * Still behind a setting on both sides, and still falling back to initials
 * when nothing loads.
 */
export const iconFor = (domain: string): string =>
  `/api/icon?domain=${encodeURIComponent(domain)}`;

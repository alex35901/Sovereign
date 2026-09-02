import { useEffect, useState } from "react";
import type { Account } from "../types";
import { useDB } from "../store";

/**
 * The institution's mark, with initials as the floor.
 *
 * Three sources, best first. Plaid hands over a logo when an item is connected,
 * which is stored on the account and involves nobody else. SimpleFIN sends only
 * a domain, so a logo has to be looked up — that tells the icon service which
 * institutions these are, so it is a setting rather than an assumption. Failing
 * both, or if the image doesn't load, the initials stand.
 */

/** Chosen for being a company that sells no advertising. */
const iconFor = (domain: string) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;

/** A stable colour per institution, so the initials still tell them apart. */
export function toneOf(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `--c${(hash % 12) + 1}`;
}

export const initialsOf = (name: string): string =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase() || "?";

export function InstitutionLogo({ account, size = 32 }: { account: Account; size?: number }) {
  const db = useDB();
  const lookupAllowed = db.settings.institutionLogos !== false;
  const src = account.logo || (lookupAllowed && account.domain ? iconFor(account.domain) : "");
  const [failed, setFailed] = useState(false);

  // A different account, or the setting turned back on, deserves another go.
  useEffect(() => setFailed(false), [src]);

  const tone = toneOf(account.institution || account.name);

  if (src && !failed) {
    return (
      <span
        className="avatar institution-logo"
        style={{ width: size, height: size }}
      >
        <img
          src={src} alt="" width={size} height={size} loading="lazy"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="avatar"
      style={{
        width: size, height: size,
        background: `color-mix(in srgb, var(${tone}) 16%, transparent)`,
        color: `var(${tone})`,
        fontWeight: 700,
        fontSize: Math.round(size * 0.37),
      }}
    >
      {initialsOf(account.institution || account.name)}
    </span>
  );
}

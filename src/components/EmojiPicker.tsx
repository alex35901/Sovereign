import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Emoji, EmojiGroup } from "../lib/emoji-data";
import { Popover, cx } from "./ui";

/**
 * The dataset is ~35KB gzipped and only needed once someone opens the picker,
 * so it is a separate chunk fetched on first open and cached thereafter.
 */
type EmojiModule = { EMOJI_GROUPS: EmojiGroup[]; searchEmoji: (q: string, limit?: number) => Emoji[] };
let cached: EmojiModule | null = null;

function useEmojiData(): EmojiModule | null {
  const [mod, setMod] = useState<EmojiModule | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    void import("../lib/emoji-data").then((m) => {
      cached = m;
      if (alive) setMod(m);
    });
    return () => { alive = false; };
  }, []);
  return mod;
}

const RECENT_KEY = "sovereign.emoji.recent";
const RECENT_MAX = 16;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberRecent(emoji: string): string[] {
  const next = [emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode — recents just won't persist */ }
  return next;
}

/** Emoji field: shows the current icon, opens a searchable picker. */
export function EmojiPicker({ value, onChange }: { value: string; onChange: (emoji: string) => void }) {
  return (
    <Popover
      width={330}
      className="emoji-menu"
      trigger={(open) => (
        <button type="button" className="btn emoji-trigger" onClick={open} title="Choose an icon">
          <span style={{ fontSize: 19, lineHeight: 1 }}>{value || "🏷️"}</span>
          <span className="tiny faint">Change</span>
        </button>
      )}
    >
      {(close) => (
        <EmojiPanel
          value={value}
          onPick={(emoji) => {
            rememberRecent(emoji);
            onChange(emoji);
            close();
          }}
        />
      )}
    </Popover>
  );
}

function EmojiPanel({ value, onPick }: { value: string; onPick: (emoji: string) => void }) {
  const data = useEmojiData();
  const [query, setQuery] = useState("");
  const [groupKey, setGroupKey] = useState("smileys");
  const [recent] = useState(loadRecent);

  const groups = data?.EMOJI_GROUPS ?? [];
  const searching = query.trim().length > 0;
  const shown: Emoji[] = useMemo(() => {
    if (!data) return [];
    return searching ? data.searchEmoji(query) : data.EMOJI_GROUPS.find((g) => g.key === groupKey)?.emojis ?? [];
  }, [data, searching, query, groupKey]);

  if (!data) {
    return (
      <div className="emoji-panel">
        <div className="tiny faint" style={{ padding: 24, textAlign: "center" }}>Loading emoji…</div>
      </div>
    );
  }

  return (
    <div className="emoji-panel">
      <div className="emoji-head">
        <div className="search">
          <Search size={13} />
          <input
            className="input" autoFocus placeholder="Search 1,900+ emoji"
            value={query} onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!searching ? (
          <div className="emoji-tabs">
            {groups.map((g) => (
              <button
                key={g.key} type="button" title={g.name}
                className={cx("emoji-tab", g.key === groupKey && "on")}
                onClick={() => setGroupKey(g.key)}
              >
                {g.icon}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="emoji-scroll">
        {!searching && recent.length ? (
          <>
            <div className="emoji-label">Recent</div>
            <div className="emoji-grid">
              {recent.map((c) => (
                <button
                  key={`r-${c}`} type="button" onClick={() => onPick(c)}
                  className={cx("emoji-cell", c === value && "on")}
                >
                  {c}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <div className="emoji-label">
          {searching ? `${shown.length} result${shown.length === 1 ? "" : "s"}` : groups.find((g) => g.key === groupKey)?.name}
        </div>
        <div className="emoji-grid">
          {shown.map((e) => (
            <button
              key={e.c} type="button" title={e.n} onClick={() => onPick(e.c)}
              className={cx("emoji-cell", e.c === value && "on")}
            >
              {e.c}
            </button>
          ))}
        </div>
        {searching && !shown.length ? (
          <div className="tiny faint" style={{ padding: "14px 10px", textAlign: "center" }}>
            Nothing matches “{query}”.
          </div>
        ) : null}
      </div>
    </div>
  );
}

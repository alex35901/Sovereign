import { useState } from "react";
import { Download, History, RotateCcw, Search } from "lucide-react";
import { cloudEnabled, history, readVersion, restoreVersion } from "../lib/cloud";
import type { HistoryEntry } from "../lib/cloud";
import { Btn, Card, CardHead, ConfirmButton } from "../components/ui";
import { exportJSON } from "../lib/storage";
import type { DB } from "../types";

/**
 * The versions this budget used to be, and the way back to one of them.
 *
 * The stored document is one row, overwritten in place. That was fine until a
 * device holding an old copy saved it over a day's work: there was no history,
 * no backup on the server, and nothing at all to go back to. The version being
 * replaced is kept now, and this is where it is found.
 *
 * Deliberately plain. Somebody opening this has just lost something and wants
 * a list of times and a button, not an explanation of how versioning works.
 */
export function HistoryCard() {
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** What a version holds, once somebody has asked to see it. */
  const [seen, setSeen] = useState<Record<number, string>>({});

  if (!cloudEnabled()) return null;

  const load = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setList(await history());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the history.");
    } finally {
      setBusy(false);
    }
  };

  const goBack = async (entry: HistoryEntry) => {
    setBusy(true);
    setError(null);
    try {
      await restoreVersion(entry.version);
      // Reloaded rather than installed in place: this browser is holding the
      // copy that is being replaced, and every path that reconciles the two
      // runs on load. Fewer ways for the thing fixing a mess to make one.
      setDone(`Version ${entry.version} is back. Reloading…`);
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore that version.");
      setBusy(false);
    }
  };

  /**
   * What a version holds, without putting it back.
   *
   * Restoring used to be the only way to find out, and a restore is a write,
   * and a write trims the oldest kept version away. Hunting for the right
   * version consumed the versions being hunted through, which is exactly the
   * wrong behaviour for the one screen somebody reaches for after losing
   * something. Looking is free now.
   */
  const look = async (entry: HistoryEntry) => {
    setBusy(true);
    setError(null);
    try {
      const doc = await readVersion(entry.version);
      const accounts = doc.accounts?.length ?? 0;
      const transactions = doc.transactions?.length ?? 0;
      const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
      setSeen((cur) => ({
        ...cur,
        [entry.version]: `${plural(accounts, "account")}, ${plural(transactions, "transaction")}`,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that version.");
    } finally {
      setBusy(false);
    }
  };

  /** The same version, saved to disk. A backup nothing on the server can trim. */
  const download = async (entry: HistoryEntry) => {
    setBusy(true);
    setError(null);
    try {
      const doc = await readVersion(entry.version);
      const url = URL.createObjectURL(new Blob([exportJSON(doc as DB)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `sovereign-v${entry.version}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that version.");
    } finally {
      setBusy(false);
    }
  };

  const when = (iso: string) => {
    const at = new Date(iso);
    return `${at.toLocaleDateString()} ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <Card>
      <CardHead
        title="Earlier versions"
        sub="Every save keeps the one it replaced"
        right={
          <Btn onClick={() => void load()} disabled={busy}>
            <History size={14} /> {busy && list === null ? "Loading…" : list === null ? "Show them" : "Refresh"}
          </Btn>
        }
      />

      <div className="small muted">
        Each save keeps the version it replaced, so a device that saved an old copy over a newer one can be
        undone. <b>Look</b> says what a version holds without changing anything, and <b>Save</b> writes it to
        a file. Use those to find the one you want: restoring is a save of its own, and the oldest version
        kept drops off the end each time something is saved. Restoring puts a version back as the newest one,
        and every other device picks it up the way it picks up any other change.
      </div>

      {list !== null ? (
        <>
          <div className="divider" />
          {list.length === 0 ? (
            <div className="small muted">Nothing kept yet. The next save will start the list.</div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {list.map((h) => (
                <div key={h.version} className="spread">
                  <span className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="num" style={{ fontWeight: 500 }}>v{h.version}</span>
                    <span className="truncate small muted">
                      {when(h.updatedAt)} · {h.updatedBy}
                      {seen[h.version] ? ` · ${seen[h.version]}` : ""}
                    </span>
                  </span>
                  <span className="row" style={{ gap: 10 }}>
                    {/* The size is the one thing a locked browser can read
                        about a version, and a copy that lost a year of
                        history is a copy that got noticeably smaller. */}
                    <span className="tiny faint nowrap">{Math.round(h.bytes / 1024)} KB</span>
                    <Btn onClick={() => void look(h)} disabled={busy}><Search size={13} /> Look</Btn>
                    <Btn onClick={() => void download(h)} disabled={busy}><Download size={13} /> Save</Btn>
                    <ConfirmButton
                      label="Restore"
                      confirmLabel="Click again to restore"
                      variant="default"
                      onConfirm={() => void goBack(h)}
                    />
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {done ? <div className="small pos" style={{ marginTop: 10 }}><RotateCcw size={13} /> {done}</div> : null}
      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}
    </Card>
  );
}

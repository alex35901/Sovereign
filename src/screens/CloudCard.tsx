import { useEffect, useState } from "react";
import { Cloud, CloudOff, Download, RefreshCw, Stethoscope } from "lucide-react";
import { useDB, useStore } from "../store";
import {
  cloudEnabled, cloudState, clearConflict, diagnose, pull, push,
  setCloudState, setPassphrase, takeConflict,
} from "../lib/cloud";
import type { CloudDiagnosis, RemoteDoc } from "../lib/cloud";
import { Btn, Card, CardHead, ConfirmButton } from "../components/ui";

/** What the function sees of the database, in words rather than a stack trace. */
function Diagnosis({ check }: { check: CloudDiagnosis }) {
  const lines: { ok: boolean; text: string }[] = [];

  lines.push({
    ok: check.driver.ok,
    text: check.driver.ok ? "Postgres driver loaded" : `Postgres driver failed to load: ${check.driver.error}`,
  });
  lines.push({
    ok: Boolean(check.variable),
    text: check.variable
      ? `Connection string found in ${check.variable}`
      : "No connection string — add a database in Vercel under Storage, then redeploy",
  });
  if (check.host) {
    lines.push({ ok: true, text: `Points at ${check.host}${check.database ? ` / ${check.database}` : ""}, TLS ${check.ssl ? "on" : "off"}` });
  }
  lines.push({
    ok: check.connect.ok,
    text: check.connect.ok
      ? "The database answered"
      : `Could not connect${check.connect.code ? ` [${check.connect.code}]` : ""}: ${check.connect.error}`,
  });
  if (check.connect.ok) {
    lines.push({
      ok: check.table.ok,
      text: check.table.ok
        ? `Table ready, holding ${check.documents} document${check.documents === 1 ? "" : "s"}`
        : `Table unavailable: ${check.table.error}`,
    });
  }

  const advice = !check.driver.ok
    ? "That is a packaging problem in the deployment rather than anything to do with your database — send me this line."
    : !check.variable
    ? "Vercel sets this when you create the database — the deployment has to be redeployed afterwards for it to appear."
    : !check.connect.ok
      ? "The usual causes: the database was created after this deployment was built, so redeploy; the project is paused or asleep on a free plan; or the connection string was pasted by hand and is missing part of the password."
      : !check.table.ok
        ? "The role in the connection string needs permission to create a table in this database."
        : null;

  return (
    <div className="col" style={{ gap: 5, width: "100%", marginTop: 4 }}>
      {lines.map((l, i) => (
        <div key={i} className={`small ${l.ok ? "muted" : "neg"}`}>{l.ok ? "✓" : "✗"} {l.text}</div>
      ))}
      {advice ? <div className="small muted" style={{ marginTop: 6 }}>{advice}</div> : null}
    </div>
  );
}

/**
 * Turns this browser into one of several windows onto the same budget.
 *
 * Without it the whole database lives in this browser's local storage, which is
 * why a second browser opens on demo data: it has nothing of yours to load.
 */
export function CloudCard() {
  const db = useDB();
  const { notify, replaceFromCloud } = useStore();
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteDoc | null>(null);
  const [check, setCheck] = useState<CloudDiagnosis | null>(null);
  const [checked, setChecked] = useState(false);
  const on = cloudEnabled();
  const stashed = takeConflict();

  useEffect(() => {
    if (!on) { setChecked(true); return; }
    let dead = false;
    pull()
      .then((r) => { if (!dead) { setRemote(r); setError(null); } })
      .catch((e: unknown) => { if (!dead) setError(e instanceof Error ? e.message : "Could not reach the sync service."); })
      .finally(() => { if (!dead) setChecked(true); });
    return () => { dead = true; };
  }, [on, db.settings.lastSyncAt]);

  const connect = async () => {
    const phrase = entry.trim();
    if (!phrase) return;
    setBusy("connect");
    setError(null);
    setPassphrase(phrase);
    try {
      const found = await pull();
      if (found) {
        replaceFromCloud(found.doc);
        setCloudState({ version: found.version, dirty: false });
        notify(`Loaded the budget saved by ${found.updatedBy}.`);
      } else {
        const res = await push(db, 0);
        setCloudState({ version: res.version, dirty: false });
        notify("This budget is now the cloud copy. Open the app anywhere with the same passphrase.");
      }
      setEntry("");
      setRemote(await pull());
    } catch (err) {
      setPassphrase("");
      setError(err instanceof Error ? err.message : "Could not connect.");
    } finally {
      setBusy(null);
    }
  };

  const pullNow = async () => {
    setBusy("pull");
    setError(null);
    try {
      const found = await pull();
      if (!found) { setError("Nothing is stored yet."); return; }
      replaceFromCloud(found.doc);
      setCloudState({ version: found.version, dirty: false });
      setRemote(found);
      notify(`Loaded version ${found.version}, last saved by ${found.updatedBy}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load.");
    } finally {
      setBusy(null);
    }
  };

  const pushNow = async () => {
    setBusy("push");
    setError(null);
    try {
      const at = cloudState();
      const res = await push(db, at.version);
      setCloudState({ version: res.version, dirty: false });
      setRemote(await pull());
      notify(`Saved as version ${res.version}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async () => {
    setBusy("check");
    setError(null);
    try {
      // works before connecting, using whatever is typed in the box
      setCheck(await diagnose(entry.trim() || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run the check.");
    } finally {
      setBusy(null);
    }
  };

  const downloadStash = () => {
    if (!stashed) return;
    const blob = new Blob([JSON.stringify(stashed.doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sovereign-set-aside-${stashed.savedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card>
      <CardHead
        title="Sync across devices"
        sub="Keep one budget, open it from any browser — and let the schedule run without one"
        right={on ? (
          <Btn onClick={() => void pushNow()} disabled={busy !== null}>
            <RefreshCw size={14} style={busy === "push" ? { animation: "spin 1s linear infinite" } : undefined} />
            {busy === "push" ? "Saving…" : "Save now"}
          </Btn>
        ) : null}
      />

      {on ? (
        <div className="col" style={{ gap: 10 }}>
          <span className="small pos row" style={{ gap: 6 }}><Cloud size={14} /> This browser is syncing</span>
          <span className="small muted">
            {!checked ? "Checking…"
              : remote
                ? `Cloud copy is version ${remote.version}, saved ${new Date(remote.updatedAt).toLocaleString()} by ${remote.updatedBy}.`
                : "Nothing stored yet — press Save now."}
          </span>
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn onClick={() => void pullNow()} disabled={busy !== null}>
              {busy === "pull" ? "Loading…" : "Load the cloud copy"}
            </Btn>
            <ConfirmButton
              label="Stop syncing this browser"
              confirmLabel="Click again to stop"
              onConfirm={() => {
                setPassphrase("");
                setCloudState({ version: 0, dirty: false });
                notify("This browser no longer syncs. The cloud copy is untouched.");
              }}
            />
          </div>
        </div>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          <span className="small row" style={{ gap: 6, color: "var(--muted)" }}>
            <CloudOff size={14} /> This browser keeps its own private copy
          </span>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="input" type="password" style={{ maxWidth: 260 }}
              placeholder="Sync passphrase" value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void connect(); }}
            />
            <Btn variant="primary" onClick={() => void connect()} disabled={busy !== null || !entry.trim()}>
              {busy === "connect" ? "Connecting…" : "Connect"}
            </Btn>
          </div>
          <div className="tiny faint" style={{ maxWidth: 560 }}>
            The passphrase is whatever you set as <b>SYNC_PASSPHRASE</b> in Vercel. The first browser to
            connect uploads what it has; every browser after that downloads it. Nothing is uploaded until
            you connect.
          </div>
        </div>
      )}

      {stashed ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            <span className="small neg">
              Changes made on this device were set aside on {new Date(stashed.savedAt).toLocaleString()},
              because a newer copy had been saved elsewhere.
            </span>
            <div className="row wrap" style={{ gap: 8 }}>
              <Btn onClick={downloadStash}><Download size={14} /> Download that copy</Btn>
              <ConfirmButton
                label="Discard it"
                confirmLabel="Click again to discard"
                onConfirm={() => { clearConflict(); notify("Set-aside copy discarded."); }}
              />
            </div>
          </div>
        </>
      ) : null}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}

      <div className="divider" />
      <div className="row wrap" style={{ gap: 10 }}>
        <Btn onClick={() => void runCheck()} disabled={busy !== null}>
          <Stethoscope size={14} /> {busy === "check" ? "Checking…" : "Check the database"}
        </Btn>
        {check ? <Diagnosis check={check} /> : null}
      </div>

      <div className="divider" />
      <details>
        <summary className="small muted" style={{ cursor: "pointer" }}>Setup — a database and a passphrase</summary>
        <ol className="small muted" style={{ margin: "10px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
          <li>
            In Vercel, open your project → <b>Storage</b> → <b>Create Database</b> → <b>Neon</b>. The free tier is
            ample and it sets <code>DATABASE_URL</code> for you. Supabase works too; avoid <b>Prisma Postgres</b>,
            whose URL is an accelerate proxy rather than a Postgres connection.
          </li>
          <li>Under Settings → Environment Variables, add <b>SYNC_PASSPHRASE</b> — any phrase you'll remember. This is what the box above asks for.</li>
          <li>Add <b>CRON_SECRET</b> as well, any long random string. Vercel sends it to the scheduled job so nobody else can trigger it.</li>
          <li>Redeploy, then come back and connect. Do the same on your phone and laptop.</li>
        </ol>
        <div className="tiny faint" style={{ marginTop: 8 }}>
          The scheduled pull runs once a day at 9am UTC — Vercel's Hobby plan allows one daily cron. Because
          the budget now lives in the database rather than this browser, that pull happens whether or not
          anything is open, and every device sees the result.
        </div>
      </details>
    </Card>
  );
}

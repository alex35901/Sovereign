import { useEffect, useState } from "react";
import { Lock, LockOpen, ShieldCheck, ShieldAlert, Download } from "lucide-react";
import { useDB, useStore } from "../store";
import { cloudState, passphrase, peek, pull, push, setCloudState } from "../lib/cloud";
import type { Envelope } from "../lib/crypto";
import { isUnlocked, lock, restore, unlock } from "../lib/vault";
import { drainQueue } from "../lib/sync/drain";
import { Btn, Card, CardHead, ConfirmButton } from "../components/ui";

/**
 * Turning end-to-end encryption on, and opening it on a new browser.
 *
 * The passphrase here is not the one that opens the API. That one is a server
 * environment variable and the server checks it; this one never leaves the
 * browser, and the server could not check it if it wanted to. Two separate
 * barriers: breaking either still leaves the other.
 */

/** A short passphrase behind AES is weaker than a short one behind a rate limiter. */
const MIN = 12;

const strength = (p: string): { ok: boolean; note: string } => {
  if (p.length < MIN) return { ok: false, note: `At least ${MIN} characters — this one is ${p.length}.` };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 20 && classes < 3) {
    return { ok: true, note: "Workable, but a longer phrase of several words would be much stronger." };
  }
  return { ok: true, note: "Good length. Write it down somewhere safe — it cannot be reset." };
};

export function EncryptionCard() {
  const db = useDB();
  const { notify, replaceFromCloud } = useStore();

  const [ready, setReady] = useState(false);
  const [encrypted, setEncrypted] = useState(false);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [unlocked, setUnlocked] = useState(isUnlocked());
  const [entry, setEntry] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whether this browser is connected at all — deliberately not cloudEnabled(),
  // which is false while sync has stood down. Being locked is the very reason
  // to show this card, so keying it off that would hide the way back in.
  const on = passphrase().length > 0;

  useEffect(() => {
    let dead = false;
    void (async () => {
      await restore();
      if (dead) return;
      setUnlocked(isUnlocked());
      if (!on) { setReady(true); return; }
      try {
        const seen = await peek();
        if (dead) return;
        setEncrypted(seen.encrypted);
        setEnvelope(seen.envelope);
      } catch { /* the sync card reports why; this one just stays quiet */ }
      if (!dead) setReady(true);
    })();
    return () => { dead = true; };
  }, [on]);

  /** Downloads everything in the clear, so a forgotten passphrase isn't the end. */
  const backup = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sovereign-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Backup downloaded. Keep it somewhere only you can reach.");
  };

  const turnOn = async () => {
    const phrase = entry.trim();
    if (phrase !== again.trim()) return setError("The two passphrases don't match.");
    if (!strength(phrase).ok) return setError(strength(phrase).note);
    setBusy(true);
    setError(null);
    try {
      await unlock(null, phrase);
      // The push encrypts, because a key now exists. Version guard kept so a
      // save from another device in the meantime is a conflict, not a clobber.
      const res = await push(db, cloudState().version);
      setCloudState({ version: res.version, dirty: false });
      setUnlocked(true);
      setEncrypted(true);
      setEntry(""); setAgain("");
      notify("Encrypted. The server now holds a document it cannot read.");
    } catch (err) {
      await lock();
      setError(err instanceof Error ? err.message : "Could not encrypt.");
    } finally { setBusy(false); }
  };

  const openIt = async () => {
    const phrase = entry.trim();
    if (!phrase || !envelope) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(envelope, phrase);
      const found = await pull();
      if (found) {
        replaceFromCloud(found.doc);
        setCloudState({ version: found.version, dirty: false });
      }
      setUnlocked(true);
      setEntry("");
      notify("Unlocked. This browser can read the budget again.");

      // Anything the scheduled job queued has been waiting for exactly this
      // key. Taken now rather than on the next poll a minute from now, so the
      // figures are current the moment the budget appears.
      const drained = await drainQueue(found?.doc ?? db, found?.version ?? cloudState().version)
        .catch(() => null);
      if (drained) {
        replaceFromCloud(drained.db);
        setCloudState({ version: drained.version, dirty: false });
        if (drained.said) notify(drained.said);
      }
    } catch {
      await lock();
      // GCM fails identically for a wrong passphrase and a damaged document,
      // and inventing a distinction would mean storing something that confirms
      // a correct guess.
      setError("That passphrase doesn't open this document.");
    } finally { setBusy(false); }
  };

  const note = entry ? strength(entry) : null;

  return (
    <Card>
      <CardHead
        title="Encryption"
        sub="Who can read the copy stored in the cloud"
        right={unlocked && encrypted
          ? <span className="small pos row" style={{ gap: 6 }}><ShieldCheck size={15} /> End-to-end encrypted</span>
          : encrypted
            ? <span className="small row" style={{ gap: 6, color: "var(--muted)" }}><Lock size={15} /> Locked on this browser</span>
            : <span className="small neg row" style={{ gap: 6 }}><ShieldAlert size={15} /> Stored in the clear</span>}
      />

      {!on ? (
        <div className="small muted">
          This applies to the cloud copy. Connect this browser under “Sync across devices” first.
        </div>
      ) : !ready ? (
        <div className="small muted">Checking…</div>
      ) : unlocked && encrypted ? (
        <div className="col" style={{ gap: 12 }}>
          <div className="small muted" style={{ maxWidth: 620 }}>
            The document is sealed with AES-256-GCM before it leaves this browser. Neon stores ciphertext,
            Vercel passes ciphertext, and the passphrase that opens it has never been sent anywhere. The key
            is held on this browser in a form no script can read back out — clearing site data will ask for
            the passphrase again.
          </div>
          <div className="setting-row">
            <span className="small">
              <b>The overnight sync still runs.</b> It cannot read the document, so it encrypts each pull to
              this installation&rsquo;s public key and leaves it in a queue. Whichever browser opens the app
              next merges it in — that is the only place it can be read. For that to work, the SimpleFIN
              access URL has to live in Vercel as <b>SIMPLEFIN_ACCESS_URL</b>, since the job can no longer
              find it inside the document.
            </span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn onClick={backup}><Download size={14} /> Download a plain backup</Btn>
            <ConfirmButton
              label="Forget the key on this browser"
              confirmLabel="Click again to forget"
              onConfirm={() => {
                void lock().then(() => { setUnlocked(false); notify("Key forgotten. The passphrase will be asked for again."); });
              }}
            />
          </div>
        </div>
      ) : encrypted ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="small muted" style={{ maxWidth: 620 }}>
            This budget is encrypted and this browser has no key for it. Enter the encryption passphrase —
            not the sync passphrase — to read it here.
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="input" type="password" style={{ maxWidth: 300 }}
              placeholder="Encryption passphrase" value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void openIt(); }}
            />
            <Btn variant="primary" onClick={() => void openIt()} disabled={busy || !entry.trim()}>
              <LockOpen size={14} /> {busy ? "Opening…" : "Unlock"}
            </Btn>
          </div>
        </div>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          <div className="small muted" style={{ maxWidth: 620 }}>
            Right now the stored copy is readable by anyone who can reach the database — which includes
            anyone with your Neon or Vercel login. Setting a passphrase here seals it before it leaves this
            browser, so what is stored gives up nothing on inspection.
          </div>
          <div className="setting-row" style={{ borderColor: "var(--neg)", background: "var(--neg-soft)" }}>
            <span className="small">
              <b>There is no way to reset this.</b> The passphrase is never sent anywhere, so nobody —
              including this app — can recover the document without it. Take the backup first, and keep it
              somewhere safe. Your other devices will each ask for the passphrase once.
            </span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <input
              className="input" type="password" style={{ maxWidth: 260 }}
              placeholder="Encryption passphrase" value={entry}
              onChange={(e) => setEntry(e.target.value)}
            />
            <input
              className="input" type="password" style={{ maxWidth: 260 }}
              placeholder="Type it again" value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void turnOn(); }}
            />
          </div>
          {note ? <div className={`tiny ${note.ok ? "faint" : "neg"}`}>{note.note}</div> : null}
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn onClick={backup}><Download size={14} /> Download a plain backup first</Btn>
            <Btn
              variant="primary" onClick={() => void turnOn()}
              disabled={busy || !entry.trim() || !again.trim()}
            >
              <Lock size={14} /> {busy ? "Encrypting…" : "Encrypt everything"}
            </Btn>
          </div>
        </div>
      )}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}
    </Card>
  );
}

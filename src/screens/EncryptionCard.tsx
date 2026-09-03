import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Lock, LockOpen, ShieldCheck, ShieldAlert, Download, Copy, Eye, EyeOff, Check, X, Stethoscope } from "lucide-react";
import { useDB, useStore } from "../store";
import {
  cloudState, diagnose, passphrase, peek, pull, push, setCloudState, subscribeSync, syncEpoch,
} from "../lib/cloud";
import type { CloudDiagnosis } from "../lib/cloud";
import type { Envelope } from "../lib/crypto";
import { WrongPassphrase } from "../lib/crypto";
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

/**
 * The SimpleFIN access URL, shown so it can be put into Vercel.
 *
 * Once the document is encrypted the scheduled job can no longer read the URL
 * out of it, so it needs its own copy in the environment. The app is the only
 * place that value exists in readable form, which makes this the only place it
 * can be got from — it is a live credential to the bank feed, so it stays
 * hidden until asked for.
 */
function AccessUrl() {
  const db = useDB();
  const { notify } = useStore();
  const [shown, setShown] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const url = db.settings.simplefinAccessUrl;

  if (!url) {
    return (
      <div className="tiny faint">
        SimpleFIN isn’t connected, so the scheduled job has nothing to pull yet. Connect it above first.
      </div>
    );
  }

  /**
   * Copy, with somewhere to fall back to.
   *
   * navigator.clipboard can be missing, refused, or — in some browsers when the
   * page isn't focused — simply never settle, which would leave this button
   * doing nothing at all and saying nothing about it. So the text is revealed
   * and selected first: whatever happens after that, Ctrl/Cmd+C works.
   */
  const copy = async () => {
    setShown(true);
    // after the re-render that reveals it, so the selection covers the real text
    await new Promise((r) => setTimeout(r, 0));
    field.current?.select();

    try {
      await Promise.race([
        navigator.clipboard.writeText(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("no answer")), 1500)),
      ]);
      notify("Access URL copied. Paste it into Vercel as SIMPLEFIN_ACCESS_URL.");
    } catch {
      notify("Selected it for you — press Ctrl/Cmd+C to copy.");
    }
  };

  return (
    <div className="col" style={{ gap: 6, marginTop: 8 }}>
      <div className="tiny faint">Value for SIMPLEFIN_ACCESS_URL</div>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          ref={field}
          className="input" readOnly value={shown ? url : "•".repeat(44)}
          onFocus={(e) => e.currentTarget.select()}
          style={{ maxWidth: 380, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
        />
        <Btn onClick={() => setShown(!shown)}>
          {shown ? <><EyeOff size={14} /> Hide</> : <><Eye size={14} /> Show</>}
        </Btn>
        <Btn onClick={() => void copy()}><Copy size={14} /> Copy</Btn>
      </div>
      <div className="tiny faint" style={{ maxWidth: 560 }}>
        This is a live credential to your bank feed. Anyone holding it can read the same data SimpleFIN
        sends here, so treat it like a password.
      </div>
    </div>
  );
}

/** One line of the readiness check: what was looked at, and what was found. */
function Row({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
      {ok
        ? <Check size={15} className="pos" style={{ flex: "none", marginTop: 2 }} />
        : <X size={15} className="neg" style={{ flex: "none", marginTop: 2 }} />}
      <span className="small" style={{ minWidth: 0 }}>
        <b>{label}</b> <span className="muted">{detail}</span>
      </span>
    </div>
  );
}

/**
 * Whether the setup is actually finished.
 *
 * Half of it cannot be seen from the browser: the scheduled job reads its
 * SimpleFIN URL from the Vercel environment, and getting that wrong shows up
 * only as an overnight pull that quietly never happens. The server reports
 * whether the variables are set — presence only, never a value.
 */
function Readiness({ unlocked }: { unlocked: boolean }) {
  const [seen, setSeen] = useState<CloudDiagnosis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try { setSeen(await diagnose()); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not reach the server."); }
    finally { setBusy(false); }
  };

  const e = seen?.encryption;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <Btn onClick={() => void run()} disabled={busy}>
          <Stethoscope size={14} /> {busy ? "Checking…" : "Check the setup"}
        </Btn>
      </div>
      {error ? <div className="small neg">{error}</div> : null}
      {e ? (
        <div className="col" style={{ gap: 7 }}>
          <Row
            ok={e.documentSealed === true}
            label="The stored document"
            detail={e.documentSealed === true
              ? "is encrypted — what the database holds is ciphertext."
              : e.documentSealed === null
                ? "is not there yet — save once from this browser."
                : "is still readable. Set a passphrase above."}
          />
          <Row
            ok={unlocked}
            label="The key on this browser"
            detail={unlocked ? "is held — it can read and save." : "is missing. Enter the encryption passphrase."}
          />
          <Row
            ok={e.simplefinUrlSet}
            label="SIMPLEFIN_ACCESS_URL in Vercel"
            detail={e.simplefinUrlSet
              ? "is set — the 9am pull can reach SimpleFIN."
              : "is not set. The overnight pull will do nothing until it is: copy the value above into Vercel and redeploy."}
          />
          <Row
            ok={e.cronSecretSet}
            label="CRON_SECRET in Vercel"
            detail={e.cronSecretSet ? "is set — the scheduled job can authenticate." : "is not set, so the 9am job cannot run."}
          />
          <div className="tiny faint" style={{ marginTop: 2 }}>
            {e.queued === 0
              ? "Nothing waiting in the overnight queue."
              : `${e.queued} overnight pull${e.queued === 1 ? "" : "s"} waiting to be merged in${
                  e.queuedOldest ? `, oldest from ${new Date(e.queuedOldest).toLocaleString()}` : ""}.`}
            {" "}Only a browser with the passphrase can open them.
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function EncryptionCard(){
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
  //
  // Subscribed, because the passphrase is module state: connecting happens in
  // the card above this one, and without this that leaves no React state
  // changing here, so this card would keep saying to go and connect.
  useSyncExternalStore(subscribeSync, syncEpoch);
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

  /**
   * Opening the document on this browser.
   *
   * Deliberately two steps, because they fail for unrelated reasons and only
   * the first one is about the passphrase. Loading the budget afterwards can
   * fail because the network dropped or the server is timing this address out,
   * and reporting that as "that passphrase doesn't open this document" sent
   * people hunting for a typo in a passphrase that had just worked — while
   * throwing away the key it had correctly derived.
   */
  const openIt = async () => {
    const phrase = entry.trim();
    if (!phrase || !envelope) return;
    setBusy(true);
    setError(null);

    try {
      await unlock(envelope, phrase);
    } catch (err) {
      await lock();
      setError(err instanceof WrongPassphrase
        ? err.message
        // The passphrase decrypted something only it could, and then something
        // else went wrong. Saying so is the difference between a person
        // re-typing for ever and a person knowing to tell someone.
        : `The passphrase was right, but this browser could not finish opening the document: ${
          err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      return;
    }

    // The key is good and kept from here on, whatever else happens.
    setUnlocked(true);
    setEntry("");
    notify("Unlocked. This browser can read the budget again.");

    try {
      const found = await pull();
      if (found) {
        replaceFromCloud(found.doc);
        setCloudState({ version: found.version, dirty: false });
      }
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
    } catch (err) {
      setError(`Unlocked, but the budget could not be fetched just now: ${
        err instanceof Error ? err.message : String(err)} The key is kept, and syncing will retry.`);
    } finally { setBusy(false); }
  };

  const note = entry ? strength(entry) : null;

  return (
    <Card>
      <CardHead
        title="Encryption"
        sub="Who can read the copy stored in the cloud"
        right={!on
          // Nothing has been looked at yet, so nothing is claimed. Saying
          // "stored in the clear" here was a statement about someone's
          // security made without checking, and on an encrypted document it
          // was the opposite of the truth.
          ? <span className="small row" style={{ gap: 6, color: "var(--muted)" }}><Lock size={15} /> Not checked</span>
          : unlocked && encrypted
            ? <span className="small pos row" style={{ gap: 6 }}><ShieldCheck size={15} /> End-to-end encrypted</span>
            : encrypted
              ? <span className="small row" style={{ gap: 6, color: "var(--muted)" }}><Lock size={15} /> Locked on this browser</span>
              : <span className="small neg row" style={{ gap: 6 }}><ShieldAlert size={15} /> Stored in the clear</span>}
      />

      {!on ? (
        <div className="small muted">
          This applies to the cloud copy, so there is nothing to say until this browser is talking to it.
          Connect it under “Sync across devices” above — if the budget turns out to be encrypted, the box
          for opening it appears here.
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
          <AccessUrl />
          <Readiness unlocked />
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
          <div className="setting-row">
            <span className="small">
              <b>Set this up first.</b> Once the document is sealed, the scheduled 9am sync can no longer
              read the SimpleFIN access URL out of it. Add the value below to Vercel as
              <b> SIMPLEFIN_ACCESS_URL</b> and redeploy, or the overnight pull will stop until you do.
            </span>
          </div>
          <AccessUrl />
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

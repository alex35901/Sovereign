import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Lock, LockOpen, RefreshCw, ShieldCheck, ShieldAlert, Download, Copy, Eye, EyeOff, Check, X, Stethoscope } from "lucide-react";
import { useDB, useStore } from "../store";
import {
  cloudState, diagnose, passphrase, peek, pull, push, setCloudState, subscribeSync, syncEpoch,
} from "../lib/cloud";
import type { CloudDiagnosis } from "../lib/cloud";
import type { Envelope } from "../lib/crypto";
import { WrongPassphrase } from "../lib/crypto";
import { isUnlocked, lock, restore, unlock } from "../lib/vault";
import { drainQueue } from "../lib/sync/drain";
import { WORD_COUNT, generate, generatedBits, matches, strength } from "../lib/passphrase";
import { Btn, Card, CardHead, ConfirmButton, SecretInput } from "../components/ui";

/**
 * Turning end-to-end encryption on, and opening it on a new browser.
 *
 * The passphrase here is not the one that opens the API. That one is a server
 * environment variable and the server checks it; this one never leaves the
 * browser, and the server could not check it if it wanted to. Two separate
 * barriers: breaking either still leaves the other.
 */


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
  const [sealed, setSealed] = useState<{ at: string | null; by: string | null }>({ at: null, by: null });
  const [unlocked, setUnlocked] = useState(isUnlocked());
  const [entry, setEntry] = useState("");
  const [fresh, setFresh] = useState("");
  const [freshAgain, setFreshAgain] = useState("");
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
        setSealed({ at: seen.updatedAt, by: seen.updatedBy });
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

  const turnOn = async (chosen: string) => {
    const phrase = chosen.trim();
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

  /**
   * Starting again when the passphrase is gone.
   *
   * Nobody can open the stored copy without it — that is the point, and no
   * amount of wanting to changes it. But this browser's own copy was never
   * encrypted and is sitting right here, so the budget is not lost; only the
   * stored copy is. This seals that copy again under a new passphrase.
   *
   * The server's ratchet forbids putting a readable document back, and rightly
   * so, which is exactly why this exists: without it a forgotten passphrase
   * leaves someone with their data on screen and no way to save it anywhere.
   */
  const reseal = async () => {
    const phrase = fresh.trim();
    if (phrase !== freshAgain.trim()) return setError("The two passphrases don't match.");
    if (!strength(phrase).ok) return setError(strength(phrase).note);
    setBusy(true);
    setError(null);
    try {
      // The stored version, so this does not race a device that can still read
      // the document and is saving to it right now.
      const seen = await peek();
      await unlock(null, phrase);
      const res = await push(db, seen.version);
      setCloudState({ version: res.version, dirty: false });
      setUnlocked(true);
      setEncrypted(true);
      setFresh(""); setFreshAgain("");
      notify("Sealed again from this browser's copy. Your other devices will each ask for the new passphrase.");
    } catch (err) {
      // Nothing was sealed with it, so the key is no use and is not kept.
      await lock();
      setError(err instanceof Error ? err.message : "Could not seal it again.");
    } finally { setBusy(false); }
  };

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
          <div className="tiny faint" style={{ maxWidth: 620 }}>
            Forgetting the key here is also the only way to check that a passphrase is the right one: this
            browser will ask for it back, and what it says is the truth. Take the backup first — if the
            passphrase turns out not to be the one, that file is how you get the budget back.
          </div>
        </div>
      ) : encrypted ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="small muted" style={{ maxWidth: 620 }}>
            This budget is encrypted and this browser has no key for it. Enter the encryption passphrase —
            not the sync passphrase — to read it here.
          </div>
          {sealed.at ? (
            <div className="tiny faint">
              The stored copy was last written {new Date(sealed.at).toLocaleString()}
              {sealed.by ? ` by ${sealed.by}` : ""}. A passphrase that used to work and no longer does means
              the document was sealed again — check that date against when you last set one.
            </div>
          ) : null}
          <div className="row wrap" style={{ gap: 8 }}>
            <SecretInput
              name="sovereign-encryption-unlock" placeholder="Encryption passphrase"
              value={entry} onChange={setEntry} onEnter={() => void openIt()}
            />
            <Btn variant="primary" onClick={() => void openIt()} disabled={busy || !entry.trim()}>
              <LockOpen size={14} /> {busy ? "Opening…" : "Unlock"}
            </Btn>
          </div>

          <details className="col" style={{ gap: 10 }}>
            <summary className="small muted" style={{ cursor: "pointer" }}>Lost the passphrase?</summary>
            <div className="col" style={{ gap: 10, marginTop: 10 }}>
              <div className="small muted" style={{ maxWidth: 620 }}>
                Then the stored copy can never be opened again — not by you, not by this app, not by anyone
                holding the database. That part is not recoverable and is the whole point of it.
                <b> Your budget is not lost, though.</b> This browser keeps its own readable copy, and it is
                what you are looking at right now: {db.transactions.length.toLocaleString()} transactions
                across {db.accounts.length} accounts. Sealing again replaces the stored copy with this one.
              </div>
              <div className="setting-row" style={{ borderColor: "var(--neg)", background: "var(--neg-soft)" }}>
                <span className="small">
                  <b>Anything that exists only in the stored copy goes with it.</b> Edits made on a device
                  you can no longer open, and any overnight pulls not yet merged in, are inside a document
                  nobody can read — sealing again writes over it. Take the backup first.
                </span>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <SecretInput
                  name="sovereign-encryption-reseal" placeholder="New passphrase"
                  value={fresh} onChange={setFresh} maxWidth={260}
                />
                <SecretInput
                  name="sovereign-encryption-reseal-again" placeholder="Type it again"
                  value={freshAgain} onChange={setFreshAgain} maxWidth={260}
                />
              </div>
              {fresh ? (
                <div className={`tiny ${strength(fresh).ok ? "faint" : "neg"}`}>{strength(fresh).note}</div>
              ) : null}
              <div className="row wrap" style={{ gap: 8 }}>
                <Btn onClick={backup}><Download size={14} /> Download a plain backup first</Btn>
                <ConfirmButton
                  label="Seal again with a new passphrase"
                  confirmLabel="Click again — the old copy goes"
                  onConfirm={() => void reseal()}
                />
              </div>
            </div>
          </details>
        </div>
      ) : (
        <SetupFlow busy={busy} onBackup={backup} onSeal={(phrase) => void turnOn(phrase)} />
      )}

      {error ? <div className="small neg" style={{ marginTop: 10 }}>{error}</div> : null}
    </Card>
  );
}

/**
 * Setting up encryption, one decision at a time.
 *
 * It used to be two boxes and a button on a page that already had another
 * password box on it, and the results were exactly what that deserves: the two
 * passphrases were taken for the same thing, the one that cannot be reset was
 * never written down, and the backup beside the button was never pressed.
 *
 * So: say what the difference is before anything else, make the backup a step
 * rather than a suggestion, offer a phrase so nobody has to reuse one, and ask
 * for it back from a cleared field before sealing anything. None of it is
 * clever. All of it is the part that went wrong.
 */
type Step = "learn" | "backup" | "choose" | "confirm";

function SetupFlow({ busy, onBackup, onSeal }: {
  busy: boolean; onBackup: () => void; onSeal: (phrase: string) => void;
}) {
  const db = useDB();
  const [step, setStep] = useState<Step>("learn");
  const [backedUp, setBackedUp] = useState(false);
  const [own, setOwn] = useState(false);
  const [phrase, setPhrase] = useState(() => generate());
  const [echo, setEcho] = useState("");
  const [wrong, setWrong] = useState(false);

  const note = own && phrase ? strength(phrase) : null;
  const ready = strength(phrase).ok;

  const steps: { key: Step; label: string }[] = [
    { key: "learn", label: "Which passphrase" },
    { key: "backup", label: "Back up" },
    { key: "choose", label: "Choose" },
    { key: "confirm", label: "Confirm" },
  ];
  const at = steps.findIndex((x) => x.key === step);

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {steps.map((x, i) => (
          <span
            key={x.key}
            className={`chip ${i === at ? "on" : ""}`}
            style={{ cursor: "default", opacity: i > at ? 0.45 : 1 }}
          >
            {i < at ? "✓" : `${i + 1}`} {x.label}
          </span>
        ))}
      </div>

      {step === "learn" ? (
        <>
          <div className="small muted" style={{ maxWidth: 640 }}>
            Right now the stored copy is readable by anyone who can reach the database — which includes
            anyone with your Neon or Vercel login. A passphrase set here seals it before it leaves this
            browser, so what is stored gives up nothing on inspection.
          </div>
          <div className="setting-row" style={{ alignItems: "stretch" }}>
            <div className="col" style={{ gap: 5, flex: 1, minWidth: 0 }}>
              <div className="tiny faint">The sync passphrase — you already have one</div>
              <div className="small">Set in Vercel as <b>SYNC_PASSPHRASE</b>.</div>
              <div className="tiny muted">The server checks it. Change it whenever you like.</div>
              <div className="tiny muted">It decides who may <i>reach</i> the database.</div>
            </div>
            <div className="col" style={{ gap: 5, flex: 1, minWidth: 0 }}>
              <div className="tiny" style={{ color: "var(--accent)" }}>The encryption passphrase — new, and different</div>
              <div className="small">Set here. Never sent anywhere.</div>
              <div className="tiny muted">Nothing can check it and nothing can reset it.</div>
              <div className="tiny muted">It decides who may <i>read</i> what the database holds.</div>
            </div>
          </div>
          <div className="setting-row" style={{ borderColor: "var(--neg)", background: "var(--neg-soft)" }}>
            <span className="small">
              <b>Do not reuse your SYNC_PASSPHRASE here.</b> They are different secrets with different
              lifetimes: changing the one in Vercel is routine and has no effect on this one, and people
              who have used the same value for both have later changed Vercel&rsquo;s and concluded this
              one had changed too. It had not. It cannot.
            </span>
          </div>
          <div className="row">
            <Btn variant="primary" onClick={() => setStep("backup")}>Understood — next</Btn>
          </div>
        </>
      ) : null}

      {step === "backup" ? (
        <>
          <div className="small muted" style={{ maxWidth: 640 }}>
            A plain copy of everything, downloaded before anything is sealed. If the passphrase is ever
            lost this file is the budget — {db.transactions.length.toLocaleString()} transactions across{" "}
            {db.accounts.length} accounts — and without it there is nothing anyone can do.
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn variant={backedUp ? "default" : "primary"} onClick={() => { onBackup(); setBackedUp(true); }}>
              <Download size={14} /> {backedUp ? "Download it again" : "Download the backup"}
            </Btn>
            <Btn variant={backedUp ? "primary" : "default"} disabled={!backedUp} onClick={() => setStep("choose")}>
              Next
            </Btn>
          </div>
          {!backedUp ? (
            <div className="tiny faint">This one is not optional — the button above unlocks the next step.</div>
          ) : (
            <div className="tiny pos">Saved. Keep it somewhere only you can reach.</div>
          )}
        </>
      ) : null}

      {step === "choose" ? (
        <>
          <div className="small muted" style={{ maxWidth: 640 }}>
            {own
              ? "Your own phrase. Several unrelated words beat one clever word, and length beats punctuation."
              : `${WORD_COUNT} words picked at random by this browser — about ${generatedBits()} bits, which is far past anything guessable, and unmistakably not your SYNC_PASSPHRASE.`}
          </div>
          {own ? (
            <SecretInput
              name="sovereign-encryption-new" placeholder="Encryption passphrase"
              value={phrase} onChange={(v) => { setPhrase(v); setEcho(""); setWrong(false); }} maxWidth={340}
            />
          ) : (
            <div className="row wrap" style={{ gap: 8 }}>
              <code className="statement" style={{ fontSize: 15, letterSpacing: ".01em" }}>{phrase}</code>
              <Btn onClick={() => { setPhrase(generate()); setEcho(""); setWrong(false); }}>
                <RefreshCw size={14} /> Another
              </Btn>
            </div>
          )}
          {note && !note.ok ? <div className="tiny neg">{note.note}</div> : null}
          <div className="setting-row">
            <span className="small">
              <b>Write it down now, before the next step.</b> A password manager, or paper somewhere only
              you can reach. The next step asks for it back from an empty box, which is the only way to
              find out whether you really have it — and the moment to find out is now, not in six months
              on a phone.
            </span>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn variant="primary" disabled={!ready} onClick={() => { setEcho(""); setWrong(false); setStep("confirm"); }}>
              I have written it down
            </Btn>
            <Btn variant="ghost" onClick={() => { setOwn(!own); setPhrase(own ? generate() : ""); setEcho(""); }}>
              {own ? "Use a generated phrase" : "Use my own"}
            </Btn>
          </div>
        </>
      ) : null}

      {step === "confirm" ? (
        <>
          <div className="small muted" style={{ maxWidth: 640 }}>
            Type it in from wherever you wrote it. Not from the last screen — that would only prove the
            screen still exists.
          </div>
          <SecretInput
            name="sovereign-encryption-confirm" placeholder="The passphrase again"
            value={echo} onChange={(v) => { setEcho(v); setWrong(false); }} maxWidth={340}
          />
          {wrong ? (
            <div className="small neg">
              That is not the same phrase. Nothing has been sealed — go back and look at it again.
            </div>
          ) : null}
          <div className="row wrap" style={{ gap: 8 }}>
            <Btn
              variant="primary" disabled={busy || !echo.trim()}
              onClick={() => (matches(phrase, echo) ? onSeal(phrase) : setWrong(true))}
            >
              <Lock size={14} /> {busy ? "Encrypting…" : "Encrypt everything"}
            </Btn>
            <Btn variant="ghost" onClick={() => setStep("choose")}>Show it to me again</Btn>
          </div>
        </>
      ) : null}

      <div className="divider" />
      <div className="setting-row">
        <span className="small">
          <b>One thing to do afterwards.</b> Once the document is sealed the scheduled 9am sync can no
          longer read the SimpleFIN access URL out of it. Put the value below into Vercel as
          <b> SIMPLEFIN_ACCESS_URL</b> and redeploy, or the overnight pull stops until you do.
        </span>
      </div>
      <AccessUrl />
    </div>
  );
}

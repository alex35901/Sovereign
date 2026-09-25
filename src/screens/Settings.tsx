import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { toCSV } from "../lib/csv";
import { download, exportJSON, importJSON } from "../lib/storage";
import { Btn, Card, CardHead, Field, Segmented, TextInput } from "../components/ui";
import { IntegrationsCard } from "./IntegrationsCard";
import { PlaidCard } from "./PlaidCard";
import { CloudCard } from "./CloudCard";
import { HistoryCard } from "./HistoryCard";
import { EncryptionCard } from "./EncryptionCard";

export default function Settings() {
  const db = useDB();
  const { actions, notify } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (file: File) => {
    try {
      actions.loadDB(importJSON(await file.text()));
      notify("Backup restored.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file could not be read.");
    }
  };

  return (
    <>
      <TopBar title="Settings" />
      <div className="page stack">
        <div className="grid g2">
          <Card>
            <CardHead title="Preferences" />
            <div className="col" style={{ gap: 14 }}>
              <Field label="Household name">
                <TextInput
                  name="sovereign-household"
                  value={db.settings.householdName}
                  onChange={(v) => actions.patchSettings({ householdName: v })}
                />
              </Field>
              {/* It used to be a sun in the bar at the top of every screen,
                  beside the buttons pressed every day. It is a thing chosen
                  once, so it sits with the other things chosen once. */}
              <Field label="Appearance">
                <span className="theme-pick">
                  <Segmented
                    value={db.settings.theme}
                    options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]}
                    onChange={(theme) => actions.patchSettings({ theme })}
                  />
                </span>
              </Field>
            </div>
          </Card>

          <Card>
            {/* What was here was a breakdown of where the megabytes go, which
                mattered while the document was growing and two providers were
                metering it. The buttons are not decoration though: this is the
                only way to take a copy out or put one back, so they stay. */}
            <CardHead
              title="Backup"
              sub="Kept in this browser and in your own database. A copy on disk is the one that survives both."
            />
            <div className="col" style={{ gap: 10 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <Btn onClick={() => download(`sovereign-backup-${new Date().toISOString().slice(0, 10)}.json`, exportJSON(db))}>
                  <Download size={14} /> Back up JSON
                </Btn>
                <Btn onClick={() => download("transactions.csv", toCSV(db, db.transactions), "text/csv")}>
                  <Download size={14} /> Export CSV
                </Btn>
                <Btn onClick={() => fileRef.current?.click()}><Upload size={14} /> Restore backup</Btn>
                <input
                  ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void restore(f); }}
                />
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <Btn onClick={() => actions.compressHistory()}>Compress balance history</Btn>
                <span className="tiny faint" style={{ maxWidth: 320 }}>
                  Drops balance points that repeat the one before them. Charts read the same, because
                  they fill forward from the last change.
                </span>
              </div>
              {/* A file that would not read said so in the sync card, which is
                  no longer here. It says so beside the button that read it. */}
              {error ? <div className="small neg">{error}</div> : null}
            </div>
          </Card>
        </div>

        <IntegrationsCard />

        <CloudCard />
        <HistoryCard />
        <EncryptionCard />

        <PlaidCard />

      </div>
    </>
  );
}


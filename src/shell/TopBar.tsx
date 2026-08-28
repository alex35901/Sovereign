import { useState } from "react";
import { Eye, EyeOff, Moon, Plus, RefreshCw, Sun } from "lucide-react";
import { useStore } from "../store";
import { Btn } from "../components/ui";
import { TransactionModal } from "../screens/TransactionModal";

export function TopBar({ title, actions }: { title: string; actions?: React.ReactNode }) {
  const { db, actions: act } = useStore();
  const [adding, setAdding] = useState(false);
  const privacy = db.settings.privacyMode;

  return (
    <>
      <header className="topbar">
        <h1 className="grow truncate" style={{ fontSize: 19 }}>{title}</h1>
        <div className="row" style={{ gap: 6 }}>
          {actions}
          <button
            className="btn btn-ghost btn-icon" title={privacy ? "Show amounts" : "Hide amounts"}
            onClick={() => act.patchSettings({ privacyMode: !privacy })}
          >
            {privacy ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button className="btn btn-ghost btn-icon" title="Toggle theme" onClick={act.toggleTheme}>
            {db.settings.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <Btn variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Transaction</Btn>
        </div>
      </header>
      {adding ? <TransactionModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

export function SyncButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <Btn onClick={onClick} disabled={busy}>
      <RefreshCw size={15} style={busy ? { animation: "spin 1s linear infinite" } : undefined} />
      {busy ? "Syncing…" : "Sync"}
    </Btn>
  );
}

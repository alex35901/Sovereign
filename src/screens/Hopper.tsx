import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { useDB, useStore } from "../store";
import { TopBar } from "../shell/TopBar";
import { Btn, Card, ConfirmButton, Empty } from "../components/ui";
import { HopperError, ask } from "../lib/hopper/loop";
import type { Progress } from "../lib/hopper/loop";
import { cloudEnabled } from "../lib/cloud";

/**
 * Hopper: the one screen that asks a model something.
 *
 * The conversation lives in the document, so it follows the household from
 * phone to laptop. What it stores is the questions and the answers — the tool
 * traffic behind them is thrown away, because replaying yesterday's figures
 * into today's conversation is worse than looking them up again.
 */

const SUGGESTIONS = [
  "Where did the money go last month?",
  "Am I on track for my goals?",
  "What is my biggest recurring cost?",
  "How does this month compare to my average?",
];

export default function Hopper() {
  const db = useDB();
  const { actions, notify } = useStore();
  const history = db.hopper ?? [];

  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<Progress | null>(null);
  const [failed, setFailed] = useState<{ message: string; hint?: string } | null>(null);
  const foot = useRef<HTMLDivElement>(null);

  // Follow the answer as it is written, the way any chat does.
  useEffect(() => { foot.current?.scrollIntoView({ behavior: "smooth", block: "end" }); },
    [history.length, live?.text, live?.used.length]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setQuestion("");
    setFailed(null);
    setBusy(true);
    setLive({ text: "", used: [], thinking: true });
    try {
      const { answer, used } = await ask(db, history, q, setLive);
      actions.rememberHopper({ question: q, answer, used, at: new Date().toISOString() });
    } catch (err) {
      if (err instanceof HopperError) setFailed({ message: err.message, hint: err.hint });
      else setFailed({ message: err instanceof Error ? err.message : "Something went wrong." });
      setQuestion(q); // so it isn't lost
    } finally {
      setBusy(false);
      setLive(null);
    }
  };

  if (!cloudEnabled()) {
    return (
      <>
        <TopBar title="Hopper" />
        <div className="page">
          <Empty
            title="Hopper needs this browser connected"
            body="He runs here, on your own data, but the key that reaches the model lives on the server. Connect under Settings → Sync across devices."
            action={<Btn variant="primary" onClick={() => { window.location.href = "/settings"; }}>Open Settings</Btn>}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Hopper"
        primary={history.length ? (
          <ConfirmButton
            label="Clear"
            confirmLabel="Click again to clear"
            onConfirm={() => { actions.forgetHopper(); notify("Cleared the conversation."); }}
          />
        ) : undefined}
      />

      <div className="page stack hopper">
        {!history.length && !live ? (
          <Card>
            <div className="col" style={{ gap: 12 }}>
              <div>
                <div className="bold" style={{ fontSize: 15 }}>Ask about your money.</div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  Hopper reads your accounts, transactions, budget and goals — the same figures the
                  rest of the app shows, worked out by the same code. He can look, not change.
                </div>
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            </div>
          </Card>
        ) : null}

        {history.map((e) => (
          <div key={e.id} className="col" style={{ gap: 10 }}>
            <div className="hopper-you">{e.question}</div>
            <Card>
              <Answer text={e.answer} />
              {e.used.length ? <Used names={e.used} /> : null}
            </Card>
          </div>
        ))}

        {live ? (
          <div className="col" style={{ gap: 10 }}>
            <div className="hopper-you">{question || "…"}</div>
            <Card>
              {live.text ? <Answer text={live.text} /> : (
                <span className="small muted">
                  {live.used.length ? `Looking at ${live.used[live.used.length - 1]}…` : "Thinking…"}
                </span>
              )}
              {live.used.length ? <Used names={live.used} /> : null}
            </Card>
          </div>
        ) : null}

        {failed ? (
          <Card>
            <div className="col" style={{ gap: 6 }}>
              <span className="neg bold small">{failed.message}</span>
              {failed.hint ? <span className="small muted">{failed.hint}</span> : null}
            </div>
          </Card>
        ) : null}

        <div ref={foot} />

        <form
          className="hopper-ask"
          onSubmit={(e) => { e.preventDefault(); void send(question); }}
        >
          <input
            className="input"
            name="hopper-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={busy ? "Hopper is working…" : "Ask about your money"}
            disabled={busy}
            autoComplete="off"
          />
          <Btn variant="primary" type="submit" disabled={busy || !question.trim()}>
            <Send size={14} /> <span className="btn-label">Ask</span>
          </Btn>
        </form>
      </div>
    </>
  );
}

/**
 * The answer, with the little markdown a chat actually produces.
 *
 * Not a markdown library: bold, bullets and paragraphs are the whole of what
 * the system prompt asks for, and a dependency that renders arbitrary HTML is
 * a poor thing to point at text a model wrote about a bank's merchant names.
 */
function Answer({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="col hopper-answer" style={{ gap: 10 }}>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const bullets = lines.every((l) => /^\s*[-*]\s+/.test(l));
        if (bullets) {
          return (
            <ul key={i} className="hopper-list">
              {lines.map((l, j) => <li key={j}>{bold(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
            </ul>
          );
        }
        return <p key={i}>{bold(block)}</p>;
      })}
    </div>
  );
}

/** **like this** — the one inline mark worth handling. */
function bold(s: string) {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>);
}

/** What he looked at, so a figure can be traced back to the screen it came from. */
function Used({ names }: { names: string[] }) {
  const unique = [...new Set(names)];
  return (
    <div className="row wrap tiny faint" style={{ gap: 6, marginTop: 10 }}>
      <span>Looked at</span>
      {unique.map((n) => <span key={n} className="tag">{n.replace(/_/g, " ")}</span>)}
    </div>
  );
}

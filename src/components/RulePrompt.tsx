import { useEffect, useState } from "react";
import { useDB, useStore } from "../store";
import { RuleModal } from "../screens/SettingsPanels";

/** How long the offer stands before it gets out of the way. */
const SECONDS = 15;

/**
 * After a category is changed by hand, the offer to make it a standing rule.
 *
 * It expires on its own because it is a suggestion, not a question: doing
 * nothing has to be the same as declining, and cost nothing to read past.
 */
export function RulePrompt() {
  const db = useDB();
  const { rulePrompt, dismissRulePrompt } = useStore();
  const [editing, setEditing] = useState(false);

  const key = rulePrompt?.key;
  useEffect(() => {
    if (key === undefined || editing) return;
    const id = window.setTimeout(dismissRulePrompt, SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [key, editing, dismissRulePrompt]);

  if (!rulePrompt) return null;
  const category = db.categories.find((c) => c.id === rulePrompt.categoryId);

  if (editing) {
    return (
      <RuleModal
        preset={{
          merchantContains: rulePrompt.merchant,
          categoryId: rulePrompt.categoryId,
          name: `${rulePrompt.merchant} → ${category?.name ?? "category"}`,
        }}
        onClose={() => { setEditing(false); dismissRulePrompt(); }}
      />
    );
  }

  return (
    <div className="rule-prompt" role="status">
      <div className="rule-prompt-body">
        <div style={{ fontWeight: 600 }}>
          Updated to {category?.icon ?? ""} {category?.name ?? "a category"}
        </div>
        <div className="small muted" style={{ marginTop: 2 }}>
          Create a rule to do this automatically in the future.
        </div>
        {/* the countdown, so the offer visibly expires rather than just vanishing */}
        <i className="rule-prompt-timer" key={rulePrompt.key} style={{ animationDuration: `${SECONDS}s` }} />
      </div>
      <div className="rule-prompt-acts">
        <button onClick={() => setEditing(true)}>Create rule</button>
        <button onClick={dismissRulePrompt}>Dismiss</button>
      </div>
    </div>
  );
}

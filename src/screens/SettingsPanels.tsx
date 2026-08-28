import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Category, Rule } from "../types";
import { useDB, useStore } from "../store";
import { countMatches } from "../lib/rules";
import { Btn, Card, CardHead, ConfirmButton, Field, Modal, MoneyInput, Popover, SelectInput, TagPill, TextInput, Toggle, cx } from "../components/ui";
import { CategoryPicker } from "../components/pickers";

const PALETTE = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8", "--c9", "--c10", "--c11", "--c12"];

export function CategoriesPanel() {
  const db = useDB();
  const [editing, setEditing] = useState<Category | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  return (
    <Card pad={false}>
      <CardHead flush title="Categories" sub={`${db.categories.length} across ${db.groups.length} groups`} />
      {[...db.groups].sort((a, b) => a.order - b.order).map((g) => (
        <div key={g.id}>
          <div className="date-head spread" style={{ position: "static" }}>
            <span>{g.name} <span className="faint">· {g.kind}</span></span>
            <button className="link tiny" onClick={() => setAddingTo(g.id)}>+ Add category</button>
          </div>
          {db.categories.filter((c) => c.groupId === g.id).sort((a, b) => a.order - b.order).map((c) => (
            <div key={c.id} className="list-row">
              <span style={{ fontSize: 15, width: 22 }}>{c.icon}</span>
              <span className="grow truncate">{c.name}</span>
              {c.rollover ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>rollover</span> : null}
              {c.excludeFromBudget ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>off-budget</span> : null}
              <span className="tiny faint">{db.transactions.filter((t) => t.categoryId === c.id).length} txns</span>
              <Btn size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Btn>
            </div>
          ))}
        </div>
      ))}
      {editing || addingTo ? (
        <CategoryModal
          category={editing ?? undefined}
          groupId={addingTo ?? editing?.groupId ?? db.groups[0].id}
          onClose={() => { setEditing(null); setAddingTo(null); }}
        />
      ) : null}
      <div style={{ padding: 14 }}>
        <Popover
          trigger={(open) => <Btn size="sm" onClick={open}><Plus size={13} /> New group</Btn>}
        >
          {(close) => <NewGroupForm onDone={close} />}
        </Popover>
      </div>
    </Card>
  );
}

function NewGroupForm({ onDone }: { onDone: () => void }) {
  const { actions } = useStore();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"income" | "expense">("expense");
  return (
    <div className="col" style={{ gap: 8, padding: 8, width: 220 }}>
      <TextInput value={name} onChange={setName} placeholder="Group name" autoFocus />
      <SelectInput value={kind} onChange={setKind} options={[{ value: "expense", label: "Expense" }, { value: "income", label: "Income" }]} />
      <Btn size="sm" variant="primary" onClick={() => { if (name.trim()) actions.addGroup(name.trim(), kind); onDone(); }}>Create</Btn>
    </div>
  );
}

function CategoryModal({ category, groupId, onClose }: { category?: Category; groupId: string; onClose: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const [name, setName] = useState(category?.name ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "🏷️");
  const [color, setColor] = useState(category?.color ?? "--c1");
  const [group, setGroup] = useState(category?.groupId ?? groupId);
  const [rollover, setRollover] = useState(category?.rollover ?? false);
  const [excludeFromBudget, setExclude] = useState(category?.excludeFromBudget ?? false);
  const [reassignTo, setReassign] = useState("c_uncategorized");

  const save = () => {
    const payload = { name: name.trim() || "New category", icon, color, groupId: group, rollover, excludeFromBudget };
    if (category) actions.updateCategory(category.id, payload);
    else actions.addCategory({ ...payload, archived: false });
    onClose();
  };

  return (
    <Modal
      title={category ? "Edit category" : "New category"}
      onClose={onClose}
      footer={<><div className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save}>Save</Btn></>}
    >
      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 74 }}><Field label="Icon"><TextInput value={icon} onChange={setIcon} /></Field></div>
        <Field label="Name"><TextInput value={name} onChange={setName} autoFocus /></Field>
      </div>
      <Field label="Group">
        <SelectInput value={group} onChange={setGroup} options={db.groups.map((g) => ({ value: g.id, label: g.name }))} />
      </Field>
      <div className="col" style={{ gap: 6 }}>
        <span className="small muted">Color</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {PALETTE.map((c) => (
            <button
              key={c} onClick={() => setColor(c)}
              className={cx("dot")}
              style={{
                width: 22, height: 22, border: color === c ? "2px solid var(--text)" : "2px solid transparent",
                background: `var(${c})`, cursor: "pointer", borderRadius: "50%",
              }}
            />
          ))}
        </div>
      </div>
      <Toggle on={rollover} onChange={setRollover} label={<span className="small">Roll unspent money into next month</span>} />
      <Toggle on={excludeFromBudget} onChange={setExclude} label={<span className="small">Exclude from budget</span>} />
      {category ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            <span className="small muted">Delete — move its transactions to:</span>
            <div className="row" style={{ gap: 8 }}>
              <CategoryPicker value={reassignTo} onChange={setReassign} />
              <ConfirmButton
                label="Delete category"
                onConfirm={() => { actions.deleteCategory(category.id, reassignTo); onClose(); }}
              />
            </div>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

export function TagsPanel() {
  const db = useDB();
  const { actions } = useStore();
  const [name, setName] = useState("");
  const [color, setColor] = useState("--c5");
  return (
    <Card>
      <CardHead title="Tags" sub="Cross-cutting labels — reimbursable, tax deductible, shared" />
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        {db.tags.map((t) => (
          <span key={t.id} className="row" style={{ gap: 4 }}>
            <TagPill name={t.name} tone={t.color} />
            <button className="btn btn-ghost btn-icon" onClick={() => actions.deleteTag(t.id)}><Trash2 size={12} /></button>
          </span>
        ))}
        {!db.tags.length ? <span className="small faint">No tags yet.</span> : null}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <TextInput value={name} onChange={setName} placeholder="New tag name" />
        <SelectInput value={color} onChange={setColor} options={PALETTE.map((c) => ({ value: c, label: c.replace("--c", "Color ") }))} />
        <Btn onClick={() => { if (name.trim()) { actions.addTag(name.trim(), color); setName(""); } }}>Add</Btn>
      </div>
    </Card>
  );
}

export function RulesPanel() {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<Rule | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Card pad={false}>
      <CardHead
        flush title="Rules" sub="Applied to every imported or synced transaction, in order"
        right={<Btn size="sm" onClick={() => setAdding(true)}><Plus size={13} /> New rule</Btn>}
      />
      {db.rules.map((r) => (
        <div key={r.id} className="list-row">
          <Toggle on={r.enabled} onChange={(v) => actions.updateRule(r.id, { enabled: v })} />
          <div className="grow col" style={{ gap: 1 }}>
            <span style={{ fontWeight: 500 }}>{r.name}</span>
            <span className="tiny faint truncate">
              {r.criteria.merchantContains ? `merchant contains "${r.criteria.merchantContains}"` : "any merchant"}
              {r.criteria.direction ? ` · ${r.criteria.direction === "in" ? "money in" : "money out"}` : ""}
              {" → "}
              {r.actions.categoryId ? db.categories.find((c) => c.id === r.actions.categoryId)?.name : "no category change"}
              {r.actions.renameMerchant ? `, rename to "${r.actions.renameMerchant}"` : ""}
            </span>
          </div>
          <span className="tiny faint">{countMatches(db, r)} match</span>
          <Btn size="sm" variant="ghost" onClick={() => actions.applyRuleToExisting(r.id)}>Run now</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Btn>
        </div>
      ))}
      {!db.rules.length ? <div style={{ padding: 16 }}><span className="small faint">No rules yet.</span></div> : null}
      {editing || adding ? <RuleModal rule={editing ?? undefined} onClose={() => { setEditing(null); setAdding(false); }} /> : null}
    </Card>
  );
}

function RuleModal({ rule, onClose }: { rule?: Rule; onClose: () => void }) {
  const { actions } = useStore();
  const [name, setName] = useState(rule?.name ?? "");
  const [merchantContains, setMerchant] = useState(rule?.criteria.merchantContains ?? "");
  const [direction, setDirection] = useState<"" | "in" | "out">(rule?.criteria.direction ?? "");
  const [amountMin, setMin] = useState(rule?.criteria.amountMin ?? 0);
  const [amountMax, setMax] = useState(rule?.criteria.amountMax ?? 0);
  const [categoryId, setCategory] = useState(rule?.actions.categoryId ?? "");
  const [renameMerchant, setRename] = useState(rule?.actions.renameMerchant ?? "");
  const [markReviewed, setReviewed] = useState(rule?.actions.markReviewed ?? false);
  const [hideFromReports, setHide] = useState(rule?.actions.hideFromReports ?? false);

  const save = () => {
    const payload = {
      name: name.trim() || merchantContains || "Untitled rule",
      enabled: rule?.enabled ?? true,
      criteria: {
        merchantContains: merchantContains.trim() || undefined,
        direction: direction || undefined,
        amountMin: amountMin || undefined,
        amountMax: amountMax || undefined,
      },
      actions: {
        categoryId: categoryId || undefined,
        renameMerchant: renameMerchant.trim() || undefined,
        markReviewed: markReviewed || undefined,
        hideFromReports: hideFromReports || undefined,
      },
    };
    if (rule) actions.updateRule(rule.id, payload);
    else actions.addRule(payload);
    onClose();
  };

  return (
    <Modal
      title={rule ? "Edit rule" : "New rule"}
      onClose={onClose}
      footer={
        <>
          {rule ? <Btn variant="danger" onClick={() => { actions.deleteRule(rule.id); onClose(); }}>Delete</Btn> : null}
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={save}>Save rule</Btn>
        </>
      }
    >
      <Field label="Rule name"><TextInput value={name} onChange={setName} placeholder="Coffee runs" autoFocus /></Field>
      <div className="section-title">When</div>
      <Field label="Merchant or statement contains">
        <TextInput value={merchantContains} onChange={setMerchant} placeholder="blue bottle" />
      </Field>
      <div className="row" style={{ gap: 12 }}>
        <Field label="Direction">
          <SelectInput
            value={direction} onChange={(v) => setDirection(v as "" | "in" | "out")}
            options={[{ value: "", label: "Any" }, { value: "out", label: "Money out" }, { value: "in", label: "Money in" }]}
          />
        </Field>
        <Field label="Min amount"><MoneyInput value={amountMin} onChange={setMin} /></Field>
        <Field label="Max amount"><MoneyInput value={amountMax} onChange={setMax} /></Field>
      </div>
      <div className="section-title">Then</div>
      <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
        <Field label="Set category"><CategoryPicker value={categoryId} onChange={setCategory} /></Field>
        <Field label="Rename merchant to"><TextInput value={renameMerchant} onChange={setRename} placeholder="Leave blank to keep" /></Field>
      </div>
      <Toggle on={markReviewed} onChange={setReviewed} label={<span className="small">Mark as reviewed</span>} />
      <Toggle on={hideFromReports} onChange={setHide} label={<span className="small">Hide from reports</span>} />
    </Modal>
  );
}

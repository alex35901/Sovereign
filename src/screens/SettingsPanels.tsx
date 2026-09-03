import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import type { Category, CategoryGroup, ID, Rule } from "../types";
import { useDB, useStore } from "../store";
import { countMatches } from "../lib/rules";
import { Btn, Card, CardHead, ConfirmButton, Field, Modal, MoneyInput, Popover, SelectInput, TagPill, TextInput, Toggle, cx } from "../components/ui";
import { AccountPicker, CategoryPicker } from "../components/pickers";
import { groupColor, GROUP_TONES, TONE_NAMES } from "../lib/category-colors";
import { EmojiPicker } from "../components/EmojiPicker";


export function CategoriesPanel() {
  const db = useDB();
  const [editing, setEditing] = useState<Category | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<CategoryGroup | null>(null);

  return (
    <Card pad={false}>
      <CardHead flush title="Categories" sub={`${db.categories.length} across ${db.groups.length} groups`} />
      {[...db.groups].sort((a, b) => a.order - b.order).map((g) => (
        <div key={g.id}>
          <div className="date-head spread" style={{ position: "static" }}>
            <span className="row" style={{ gap: 8 }}>
              {/* the group's colour, which every category under it now wears */}
              <span
                style={{
                  width: 11, height: 11, borderRadius: "50%", flex: "none",
                  background: `var(${groupColor(g, db.categories)})`,
                }}
              />
              {g.name} <span className="faint">· {g.kind}</span>
            </span>
            <span className="row" style={{ gap: 12 }}>
              {/* "Rename" undersold it once the modal set colour and kind too */}
              <button className="link tiny" onClick={() => setEditingGroup(g)}>Edit</button>
              <button className="link tiny" onClick={() => setAddingTo(g.id)}>+ Add category</button>
            </span>
          </div>
          {db.categories.filter((c) => c.groupId === g.id).sort((a, b) => a.order - b.order).map((c) => (
            <div key={c.id} className="list-row">
              <span style={{ fontSize: 15, width: 22 }}>{c.icon}</span>
              <Link to={`/categories/${c.id}`} className="grow truncate cat-open">{c.name}</Link>
              {c.rollover ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>rollover</span> : null}
              {c.excludeFromBudget ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>off-budget</span> : null}
              <span className="tiny faint">{db.transactions.filter((t) => t.categoryId === c.id).length} txns</span>
              <Btn size="sm" variant="ghost" onClick={() => setEditing(c)}>Edit</Btn>
            </div>
          ))}
        </div>
      ))}
      {editingGroup ? <GroupModal group={editingGroup} onClose={() => setEditingGroup(null)} /> : null}
      {editing || addingTo ? (
        <CategoryModal
          category={editing ?? undefined}
          groupId={addingTo ?? editing?.groupId ?? db.groups[0].id}
          onClose={() => { setEditing(null); setAddingTo(null); }}
        />
      ) : null}
    </Card>
  );
}

function GroupModal({ group, onClose }: { group: CategoryGroup; onClose: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const [name, setName] = useState(group.name);
  const members = db.categories.filter((c) => c.groupId === group.id);
  const [color, setColor] = useState(() => groupColor(group, db.categories));
  const isTransfer = group.kind === "transfer";
  const [kind, setKind] = useState<"income" | "expense">(group.kind === "income" ? "income" : "expense");

  return (
    <Modal
      title="Edit group"
      onClose={onClose}
      footer={
        <>
          <ConfirmButton
            label="Delete group"
            confirmLabel="Click again to delete"
            onConfirm={() => { actions.deleteGroup(group.id); onClose(); }}
            variant={members.length ? "default" : "danger"}
          />
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn
            variant="primary"
            onClick={() => {
              actions.updateGroup(group.id, {
                name: name.trim() || group.name, color, ...(isTransfer ? {} : { kind }),
              });
              onClose();
            }}
          >
            Save
          </Btn>
        </>
      }
    >
      <div className="col" style={{ gap: 6, marginBottom: 14 }}>
        <span className="small muted">Colour</span>
        <div className="row wrap" style={{ gap: 6 }}>
          {GROUP_TONES.map((c) => (
            <button
              key={c} onClick={() => setColor(c)}
              aria-label={TONE_NAMES[c] ?? c} title={TONE_NAMES[c] ?? c}
              style={{
                width: 26, height: 26, borderRadius: "50%", cursor: "pointer",
                background: `var(${c})`,
                border: color === c ? "2px solid var(--fg)" : "2px solid transparent",
              }}
            />
          ))}
        </div>
        <span className="tiny faint">
          Every category in this group wears it — {members.length} of them
          {members.length ? `, including ${members.slice(0, 3).map((m) => m.name).join(", ")}` : ""}.
        </span>
      </div>

      <Field label="Group name" hint="Shown on the Budget and Reports screens">
        <TextInput value={name} onChange={setName} autoFocus />
      </Field>

      {isTransfer ? (
        <div className="small muted">
          This is the transfers group. Its categories are deliberately kept out of budgets and cash
          flow, so its type can't be changed — rename it freely.
        </div>
      ) : (
        <Field
          label="Type"
          hint={members.length ? `${members.length} categories move with it — income and expenses are treated differently everywhere` : undefined}
        >
          <SelectInput
            value={kind} onChange={setKind}
            options={[{ value: "expense", label: "Expense" }, { value: "income", label: "Income" }]}
          />
        </Field>
      )}

      <div className="small faint">
        {members.length
          ? `Holds ${members.length} categor${members.length === 1 ? "y" : "ies"}: ${members.slice(0, 6).map((c) => c.name).join(", ")}${members.length > 6 ? "…" : ""}. Move a category elsewhere by editing it and changing its group. A group has to be empty before it can be deleted.`
          : "Empty, so it can be deleted."}
      </div>
    </Modal>
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

/** Shared with the category drill-down, which edits the one it is showing. */
export function CategoryModal({ category, groupId, onClose }: { category?: Category; groupId: string; onClose: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const [name, setName] = useState(category?.name ?? "");
  const [icon, setIcon] = useState(category?.icon ?? "🏷️");
  const [group, setGroup] = useState(category?.groupId ?? groupId);
  const [rollover, setRollover] = useState(category?.rollover ?? false);
  const [excludeFromBudget, setExclude] = useState(category?.excludeFromBudget ?? false);
  const [reassignTo, setReassign] = useState("c_uncategorized");

  const save = () => {
    // No colour here: it comes from the group, and withGroupColors puts it on.
    const payload = { name: name.trim() || "New category", icon, color: "--c1", groupId: group, rollover, excludeFromBudget };
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
        <div style={{ width: 120 }}><Field label="Icon"><EmojiPicker value={icon} onChange={setIcon} /></Field></div>
        <Field label="Name"><TextInput value={name} onChange={setName} autoFocus /></Field>
      </div>
      <Field label="Group">
        <SelectInput value={group} onChange={setGroup} options={db.groups.map((g) => ({ value: g.id, label: g.name }))} />
      </Field>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span
          style={{ width: 14, height: 14, borderRadius: "50%", flex: "none",
            background: `var(${groupColor(db.groups.find((g) => g.id === group) ?? db.groups[0]!, db.categories)})` }}
        />
        <span className="tiny faint">
          Colour comes from the group. Change it there and every category in it follows.
        </span>
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

/**
 * Picking a colour by looking at it.
 *
 * It was a dropdown of "Color 1" through "Color 12", which is a list of names
 * for things that have no names — you had to pick one, save it, and look at
 * the result to find out what you had chosen. A swatch is the colour.
 */
export function ColorSwatches({ value, onChange }: { value: string; onChange: (tone: string) => void }) {
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      {GROUP_TONES.map((tone) => (
        <button
          key={tone}
          type="button"
          onClick={() => onChange(tone)}
          title={TONE_NAMES[tone] ?? tone}
          aria-label={TONE_NAMES[tone] ?? tone}
          aria-pressed={value === tone}
          style={{
            width: 26, height: 26, borderRadius: "50%", cursor: "pointer",
            background: `var(${tone})`,
            border: value === tone ? "2px solid var(--text)" : "2px solid transparent",
          }}
        />
      ))}
    </div>
  );
}

/** Name, colour, add — shared by the page and the button in its action bar. */
export function NewTagForm({ onDone }: { onDone?: () => void }) {
  const { actions } = useStore();
  const [name, setName] = useState("");
  const [color, setColor] = useState("--c5");

  const add = () => {
    if (!name.trim()) return;
    actions.addTag(name.trim(), color);
    setName("");
    onDone?.();
  };

  return (
    <div className="col" style={{ gap: 10, minWidth: 240, maxWidth: 320 }}>
      <TextInput value={name} onChange={setName} placeholder="New tag name" />
      <div className="col" style={{ gap: 6 }}>
        <span className="tiny faint">Colour — {TONE_NAMES[color] ?? color}</span>
        <ColorSwatches value={color} onChange={setColor} />
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <Btn variant="primary" onClick={add} disabled={!name.trim()}>Add tag</Btn>
        <TagPill name={name.trim() || "preview"} tone={color} />
      </div>
    </div>
  );
}

/** The "+ Tag" button, for the screen's action bar. */
export function NewTagButton() {
  return (
    <Popover
      align="right" width={280}
      trigger={(open) => (
        <Btn variant="primary" onClick={open}>
          <Plus size={15} /> <span className="btn-label">Tag</span>
        </Btn>
      )}
    >
      {(close) => <div style={{ padding: 12 }}><NewTagForm onDone={close} /></div>}
    </Popover>
  );
}

export function TagsPanel() {
  const db = useDB();
  const { actions } = useStore();
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
      <div className="divider" />
      <NewTagForm />
    </Card>
  );
}

/** The "+ Category group" button, for the screen's action bar. */
export function NewGroupButton() {
  return (
    <Popover
      align="right"
      trigger={(open) => (
        <Btn variant="primary" onClick={open}>
          <Plus size={15} /> <span className="btn-label">Category group</span>
        </Btn>
      )}
    >
      {(close) => <NewGroupForm onDone={close} />}
    </Popover>
  );
}

/** How a rule's merchant test reads in its one-line summary. */
const MATCH_WORD: Record<string, string> = {
  contains: "contains", exact: "is exactly", starts: "starts with", ends: "ends with",
};

/**
 * The rules, as a list.
 *
 * Adding one and running them all live in the screen's action bar now, where
 * every other screen keeps its actions, rather than in this card's own header
 * where they were a second set of controls six inches below the first.
 */
export function RulesPanel({ adding, onAddingDone }: { adding: boolean; onAddingDone: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<Rule | null>(null);
  const enabled = db.rules.filter((r) => r.enabled);

  return (
    <Card pad={false}>
      <CardHead
        flush title="Rules"
        sub={`${enabled.length} of ${db.rules.length} on — applied to every imported or synced transaction, in order`}
      />
      {db.rules.map((r) => (
        <div key={r.id} className="list-row">
          <Toggle on={r.enabled} onChange={(v) => actions.updateRule(r.id, { enabled: v })} />
          <div className="grow col" style={{ gap: 1 }}>
            <span style={{ fontWeight: 500 }}>{r.name}</span>
            <span className="tiny faint truncate">
              {r.criteria.merchantContains ? `merchant ${MATCH_WORD[r.criteria.merchantMatch ?? "contains"]} "${r.criteria.merchantContains}"` : "any merchant"}
              {r.criteria.accountId ? ` · in ${db.accounts.find((a) => a.id === r.criteria.accountId)?.name ?? "an account"}` : ""}
              {r.criteria.direction ? ` · ${r.criteria.direction === "in" ? "money in" : "money out"}` : ""}
              {" → "}
              {r.actions.categoryId ? db.categories.find((c) => c.id === r.actions.categoryId)?.name : "no category change"}
              {r.actions.renameMerchant ? `, rename to "${r.actions.renameMerchant}"` : ""}
              {r.actions.addTags?.length
                ? `, tag ${r.actions.addTags.map((id) => db.tags.find((t) => t.id === id)?.name).filter(Boolean).join(", ")}`
                : ""}
            </span>
          </div>
          <span className="tiny faint">{countMatches(db, r)} match</span>
          <Btn size="sm" variant="ghost" onClick={() => actions.applyRuleToExisting(r.id)}>Run now</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Btn>
        </div>
      ))}
      {!db.rules.length ? <div style={{ padding: 16 }}><span className="small faint">No rules yet.</span></div> : null}
      {editing || adding ? (
        <RuleModal rule={editing ?? undefined} onClose={() => { setEditing(null); onAddingDone(); }} />
      ) : null}
    </Card>
  );
}

/** A new rule started from something the user just did, rather than from blank. */
export interface RulePreset {
  merchantContains?: string;
  categoryId?: ID;
  renameMerchant?: string;
  name?: string;
}

export function RuleModal({ rule, preset, onClose }: { rule?: Rule; preset?: RulePreset; onClose: () => void }) {
  const db = useDB();
  const { actions, notify } = useStore();
  const [name, setName] = useState(rule?.name ?? preset?.name ?? "");
  const [merchantContains, setMerchant] = useState(rule?.criteria.merchantContains ?? preset?.merchantContains ?? "");
  const [direction, setDirection] = useState<"" | "in" | "out">(rule?.criteria.direction ?? "");
  const [amountMin, setMin] = useState(rule?.criteria.amountMin ?? 0);
  const [amountMax, setMax] = useState(rule?.criteria.amountMax ?? 0);
  const [accountId, setAccount] = useState(rule?.criteria.accountId ?? "");
  const [categoryId, setCategory] = useState(rule?.actions.categoryId ?? preset?.categoryId ?? "");
  const [renameMerchant, setRename] = useState(rule?.actions.renameMerchant ?? preset?.renameMerchant ?? "");
  const [addTags, setAddTags] = useState<ID[]>(rule?.actions.addTags ?? []);
  // On by default: a rule firing is the review, so leaving them unreviewed just
  // makes work. An existing rule keeps whatever it was saved with.
  const [markReviewed, setReviewed] = useState(rule ? (rule.actions.markReviewed ?? false) : true);
  const [hideFromReports, setHide] = useState(rule?.actions.hideFromReports ?? false);
  const [applyToExisting, setApplyToExisting] = useState(!rule);

  const payload = useMemo(() => ({
    name: name.trim() || merchantContains || "Untitled rule",
    enabled: rule?.enabled ?? true,
    criteria: {
      merchantContains: merchantContains.trim() || undefined,
      // was dropped on save before, so editing a rule scoped to an account
      // silently widened it to every account
      accountId: accountId || undefined,
      direction: direction || undefined,
      amountMin: amountMin || undefined,
      amountMax: amountMax || undefined,
    },
    actions: {
      categoryId: categoryId || undefined,
      renameMerchant: renameMerchant.trim() || undefined,
      addTags: addTags.length ? addTags : undefined,
      markReviewed: markReviewed || undefined,
      hideFromReports: hideFromReports || undefined,
    },
  }), [name, merchantContains, accountId, direction, amountMin, amountMax,
       categoryId, renameMerchant, addTags, markReviewed, hideFromReports, rule]);

  // What this rule would touch as it currently stands, counted live so the
  // offer to back-fill says how much it is about to change.
  const matches = useMemo(
    () => countMatches(db, { ...payload, id: rule?.id ?? "draft", order: 0 }),
    [db, payload, rule],
  );
  const doesSomething = Boolean(payload.actions.categoryId || payload.actions.renameMerchant
    || payload.actions.addTags || payload.actions.markReviewed || payload.actions.hideFromReports);
  const c = payload.criteria;
  const hasCriteria = Boolean(c.merchantContains || c.accountId || c.direction || c.amountMin || c.amountMax);
  // A rule with no conditions matches everything, and "Mark as reviewed" is on
  // by default — so back-filling a blank rule would quietly rewrite the whole
  // history. It stays unavailable until the rule says who it is for.
  const canBackfill = hasCriteria && doesSomething;

  const save = () => {
    const backfill = applyToExisting && canBackfill;
    if (rule) actions.updateRule(rule.id, payload, backfill);
    else actions.addRule(payload, backfill);
    notify(
      backfill && matches
        ? `Rule saved and applied to ${matches} transaction${matches === 1 ? "" : "s"}.`
        : "Rule saved.",
    );
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

      <section className="rule-block">
        <header><span className="rule-when">When</span> a transaction matches all of these</header>
        <div className="col" style={{ gap: 12 }}>
          <Field label="Merchant or statement contains">
            <TextInput value={merchantContains} onChange={setMerchant} placeholder="blue bottle" />
          </Field>
          <Field label="Account">
            <AccountPicker value={accountId} onChange={setAccount} allowAll />
          </Field>
          <div className="row wrap" style={{ gap: 12 }}>
            <Field label="Direction">
              <SelectInput
                value={direction} onChange={(v) => setDirection(v as "" | "in" | "out")}
                options={[{ value: "", label: "Any" }, { value: "out", label: "Money out" }, { value: "in", label: "Money in" }]}
              />
            </Field>
            <Field label="Min amount"><MoneyInput value={amountMin} onChange={setMin} /></Field>
            <Field label="Max amount"><MoneyInput value={amountMax} onChange={setMax} /></Field>
          </div>
        </div>
      </section>

      <section className="rule-block">
        <header><span className="rule-then">Then</span> do all of these</header>
        <div className="col" style={{ gap: 12 }}>
          <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
            <Field label="Set category"><CategoryPicker value={categoryId} onChange={setCategory} /></Field>
            <Field label="Rename merchant to"><TextInput value={renameMerchant} onChange={setRename} placeholder="Leave blank to keep" /></Field>
          </div>
          <Field label="Set tags">
            {db.tags.length ? (
              <div className="row wrap" style={{ gap: 6 }}>
                {db.tags.map((t) => (
                  <button
                    key={t.id} type="button"
                    className={cx("chip", addTags.includes(t.id) && "on")}
                    onClick={() => setAddTags((prev) => prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id])}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            ) : (
              <span className="tiny faint">No tags yet — create them under Configuration → Tags.</span>
            )}
          </Field>
          <div className="col" style={{ gap: 8 }}>
            <Toggle on={markReviewed} onChange={setReviewed} label={<span className="small">Mark as reviewed</span>} />
            <Toggle on={hideFromReports} onChange={setHide} label={<span className="small">Hide from reports</span>} />
          </div>
        </div>
      </section>

      <div className="rule-backfill">
        <Toggle
          on={applyToExisting && canBackfill}
          onChange={(v) => { if (canBackfill) setApplyToExisting(v); }}
          label={
            <span className={cx("small", !canBackfill && "faint")}>
              Also update transactions already here
              <span className="faint">
                {" · "}
                {!doesSomething ? "add an action below first"
                  : !hasCriteria ? "add a condition above first, or this would match everything"
                    : matches === 0 ? "nothing matches right now"
                      : `${matches} transaction${matches === 1 ? "" : "s"} would change`}
              </span>
            </span>
          }
        />
      </div>
    </Modal>
  );
}

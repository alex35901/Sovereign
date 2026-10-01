import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Filter, Minus, Plus, Search, Trash2 } from "lucide-react";
import type { Category, CategoryGroup, ID, Rule } from "../types";
import { useDB, useStore } from "../store";
import { MATCH_WORD, countMatches, merchantTests } from "../lib/rules";
import type { MerchantTest } from "../lib/rules";
import { Btn, Card, CardHead, ConfirmButton, Field, Modal, MoneyInput, Popover, SelectInput, TagPill, TextInput, Toggle, cx } from "../components/ui";
import { AccountPicker, CategoryPicker } from "../components/pickers";
import { SortHead, sortRows, useSort } from "../components/sort";
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
              {c.rollover && g.kind !== "income"
                ? <span className="tag" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>rollover</span> : null}
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
          Every category in this group wears it. {members.length} of them
          {members.length ? `, including ${members.slice(0, 3).map((m) => m.name).join(", ")}` : ""}.
        </span>
      </div>

      <Field label="Group name" hint="Shown on the Budget and Reports screens">
        <TextInput value={name} onChange={setName} autoFocus />
      </Field>

      {isTransfer ? (
        <div className="small muted">
          This is the transfers group. Its categories are deliberately kept out of budgets and cash
          flow, so its type can't be changed, rename it freely.
        </div>
      ) : (
        <Field
          label="Type"
          hint={members.length ? `${members.length} categories move with it, income and expenses are treated differently everywhere` : undefined}
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
  const incomeGroup = db.groups.find((g) => g.id === group)?.kind === "income";

  const save = () => {
    // No colour here: it comes from the group, and withGroupColors puts it on.
    const payload = {
      name: name.trim() || "New category", icon, color: "--c1", groupId: group,
      // Cleared rather than carried, so a category moved into Income does not
      // keep a switch that is no longer shown and no longer does anything.
      rollover: incomeGroup ? false : rollover,
      excludeFromBudget,
    };
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
      {/* Not offered on income. Rolling money you did not spend into next
          month is a sentence about spending; the same idea on income would
          mean a paycheque you were not paid is still owed to you, and it
          compounds every month. The calculation ignores the flag there, so
          offering the switch would only promise something that cannot
          happen. */}
      {incomeGroup ? null : (
        <Toggle on={rollover} onChange={setRollover} label={<span className="small">Roll unspent money into next month</span>} />
      )}
      <Toggle on={excludeFromBudget} onChange={setExclude} label={<span className="small">Exclude from budget</span>} />
      {category ? (
        <>
          <div className="divider" />
          <div className="col" style={{ gap: 8 }}>
            <span className="small muted">Delete, move its transactions to:</span>
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
 * for things that have no names, you had to pick one, save it, and look at
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

/** Name, colour, add, shared by the page and the button in its action bar. */
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
        <span className="tiny faint">Colour. {TONE_NAMES[color] ?? color}</span>
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
      <CardHead title="Tags" sub="Cross-cutting labels, reimbursable, tax deductible, shared" />
      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        {db.tags.map((t) => (
          <span key={t.id} className="row" style={{ gap: 4 }}>
            <TagPill name={t.name} tone={t.color} />
            <button className="btn btn-ghost btn-icon" onClick={() => actions.deleteTag(t.id)}><Trash2 size={12} /></button>
          </span>
        ))}
        {!db.tags.length ? (
          <span className="small faint">No tags yet, the button at the top of the page makes one.</span>
        ) : null}
      </div>
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

/** The comparisons a merchant condition can use, for the editor's picker. */
const MATCH_OPTIONS = [
  { value: "contains", label: "contains" },
  { value: "exact", label: "is exactly" },
  { value: "starts", label: "starts with" },
  { value: "ends", label: "ends with" },
];

/** A rule's merchant conditions, as one line. */
function describeMerchant(c: Rule["criteria"]): string {
  const tests = merchantTests(c);
  if (!tests.length) return "any merchant";
  return tests
    .map((t, i) => `${i ? `${t.join === "or" ? "or " : "and "}` : ""}merchant ${MATCH_WORD[t.match]} "${t.text}"`)
    .join(" ");
}

/**
 * The rules, as a list.
 *
 * Adding one and running them all live in the screen's action bar now, where
 * every other screen keeps its actions, rather than in this card's own header
 * where they were a second set of controls six inches below the first.
 */
/**
 * Every rule, with a way to find the one you mean.
 *
 * A household that has been running a while has a few hundred of these, and a
 * list that long is a list nobody reads: the question is never "what are all
 * my rules", it is "what did I write about Amazon", or "which of these never
 * fire any more". So it searches and narrows, and the one column worth
 * ordering by orders.
 */
export function RulesPanel({ adding, onAddingDone }: { adding: boolean; onAddingDone: () => void }) {
  const db = useDB();
  const { actions } = useStore();
  const [editing, setEditing] = useState<Rule | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "on" | "off">("");
  const [direction, setDirection] = useState<"" | "in" | "out">("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [hits, setHits] = useState<"" | "none">("");
  const { sort, toggle: onSort } = useSort<"matches">();

  /**
   * How many transactions each rule touches, counted once per document.
   *
   * This used to be worked out inside the row, so every render walked the
   * whole ledger once per rule: three hundred rules against twenty thousand
   * transactions is six million tests to redraw a list. Keyed on the document,
   * which is replaced whole on every write, so the answer cannot outlive the
   * figures it came from.
   */
  const counts = useMemo(
    () => new Map(db.rules.map((r) => [r.id, countMatches(db, r)])),
    [db],
  );
  const catName = useMemo(() => new Map(db.categories.map((c) => [c.id, c.name])), [db.categories]);

  const narrowed = [status, direction, categoryId, accountId, hits].filter(Boolean).length;
  const clear = () => {
    setStatus(""); setDirection(""); setCategoryId(""); setAccountId(""); setHits("");
  };

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return db.rules.filter((r) => {
      if (status === "on" && !r.enabled) return false;
      if (status === "off" && r.enabled) return false;
      if (direction && r.criteria.direction !== direction) return false;
      if (categoryId && r.actions.categoryId !== categoryId) return false;
      if (accountId && r.criteria.accountId !== accountId) return false;
      if (hits === "none" && (counts.get(r.id) ?? 0) > 0) return false;
      if (!needle) return true;
      // Everything somebody might type looking for one rule: what they called
      // it, the text it looks for, what it renames to, and what it files it
      // under. Searching only the name would miss every rule left untitled.
      return [
        r.name,
        ...merchantTests(r.criteria).map((t) => t.text),
        r.actions.renameMerchant ?? "",
        r.actions.categoryId ? catName.get(r.actions.categoryId) ?? "" : "",
      ].join(" ").toLowerCase().includes(needle);
    });
  }, [db.rules, q, status, direction, categoryId, accountId, hits, counts, catName]);

  const shown = sortRows(filtered, sort, (r) => counts.get(r.id) ?? 0);
  const filtering = narrowed > 0 || q.trim().length > 0;

  return (
    <Card pad={false}>
      <CardHead flush title="Rules" />
      <div className="rules-filter">
        <div className="row filter-bar" style={{ gap: 8 }}>
          <div className="search grow" style={{ minWidth: 0 }}>
            <Search size={14} />
            <TextInput value={q} onChange={setQ} placeholder="Search rules" />
          </div>
          <Popover
            align="right" width={290} className="filter-panel"
            trigger={(open) => (
              <button
                className={cx("btn btn-icon filter-toggle", narrowed > 0 && "on")}
                onClick={open} title="Filters" aria-label="Filters"
              >
                <Filter size={16} />
                {narrowed ? <span className="filter-count">{narrowed}</span> : null}
              </button>
            )}
          >
            {(close) => (
              <div className="col" style={{ gap: 12 }}>
                <div className="spread">
                  <span style={{ fontWeight: 600 }}>Filters</span>
                  {narrowed ? (
                    <Btn size="sm" variant="ghost" onClick={() => { clear(); close(); }}>
                      <Trash2 size={13} /> Clear all
                    </Btn>
                  ) : null}
                </div>
                <Field label="Switched">
                  <SelectInput
                    value={status} onChange={(v) => setStatus(v as "" | "on" | "off")}
                    placeholder="On and off"
                    options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]}
                  />
                </Field>
                <Field label="Direction" hint="Rules that only look at money going one way">
                  <SelectInput
                    value={direction} onChange={(v) => setDirection(v as "" | "in" | "out")}
                    placeholder="Either way"
                    options={[{ value: "in", label: "Money in" }, { value: "out", label: "Money out" }]}
                  />
                </Field>
                <Field label="Files it under">
                  <CategoryPicker
                    value={categoryId} onChange={setCategoryId} clearLabel="Any category"
                  />
                </Field>
                <Field label="Only in account">
                  <AccountPicker value={accountId} onChange={setAccountId} allowAll />
                </Field>
                {/* The one filter that is a cleanup tool: a rule nothing
                    matches any more is a rule to look at, and finding them in
                    three hundred rows by eye is not a job anybody does. */}
                <Field label="Matches" hint="A rule nothing matches is usually one to delete">
                  <SelectInput
                    value={hits} onChange={(v) => setHits(v as "" | "none")}
                    placeholder="Any number"
                    options={[{ value: "none", label: "Nothing at all" }]}
                  />
                </Field>
              </div>
            )}
          </Popover>
        </div>
        {filtering ? (
          <span className="tiny faint">
            {shown.length.toLocaleString()} of {db.rules.length.toLocaleString()} rules
          </span>
        ) : null}
        {/* Said only when it is true. Rules run top to bottom, so a list in
            any other order is not the order they fire in, and a sorted list
            that did not say so would be quietly misleading about the one
            thing this page is about. */}
        {sort ? <span className="tiny warn">Sorted, so this is not the order they run in.</span> : null}
      </div>
      {shown.length ? (
        <>
          <div className="rule-row head">
            <span />
            <span />
            <span className="tiny faint rule-hits">
              <SortHead field="matches" sort={sort} onSort={onSort}>Transactions</SortHead>
            </span>
            <span />
          </div>
          {shown.map((r) => (
            <div key={r.id} className="rule-row">
              <Toggle on={r.enabled} onChange={(v) => actions.updateRule(r.id, { enabled: v })} />
              <div className="col" style={{ gap: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{r.name}</span>
                <span className="tiny faint truncate">
                  {describeMerchant(r.criteria)}
                  {r.criteria.accountId ? ` · in ${db.accounts.find((a) => a.id === r.criteria.accountId)?.name ?? "an account"}` : ""}
                  {r.criteria.direction ? ` · ${r.criteria.direction === "in" ? "money in" : "money out"}` : ""}
                  {" → "}
                  {r.actions.categoryId ? catName.get(r.actions.categoryId) : "no category change"}
                  {r.actions.renameMerchant ? `, rename to "${r.actions.renameMerchant}"` : ""}
                  {r.actions.addTags?.length
                    ? `, tag ${r.actions.addTags.map((id) => db.tags.find((t) => t.id === id)?.name).filter(Boolean).join(", ")}`
                    : ""}
                </span>
              </div>
              <span className="num tiny faint rule-hits">{(counts.get(r.id) ?? 0).toLocaleString()}</span>
              <span className="rule-actions">
                <Btn size="sm" variant="ghost" onClick={() => actions.applyRuleToExisting(r.id)}>Run now</Btn>
                <Btn size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Btn>
              </span>
            </div>
          ))}
        </>
      ) : (
        <div style={{ padding: 16 }}>
          <span className="small faint">
            {db.rules.length
              ? "No rules match what you are looking for."
              : "No rules yet."}
          </span>
          {db.rules.length && filtering ? (
            <div className="row" style={{ marginTop: 10 }}>
              <Btn size="sm" onClick={() => { clear(); setQ(""); }}>Clear search and filters</Btn>
            </div>
          ) : null}
        </div>
      )}
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
  /**
   * The merchant conditions, as one list however they are stored.
   *
   * Always at least one row, even when it is blank: a rule with no merchant
   * condition is a real thing to write, and an empty first box says so more
   * plainly than an empty list with a plus under it.
   */
  const [tests, setTests] = useState<MerchantTest[]>(() => {
    const held = merchantTests(rule?.criteria ?? {});
    if (held.length) return held;
    return [{ text: preset?.merchantContains ?? "", match: "contains" }];
  });
  const setTest = (i: number, patch: Partial<MerchantTest>) =>
    setTests((prev) => prev.map((t, n) => (n === i ? { ...t, ...patch } : t)));
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

  // Blank boxes are conditions nobody has written yet, not conditions that
  // match everything.
  const written = useMemo(
    () => tests.map((t) => ({ ...t, text: t.text.trim() })).filter((t) => t.text),
    [tests],
  );

  const payload = useMemo(() => ({
    name: name.trim() || written[0]?.text || "Untitled rule",
    enabled: rule?.enabled ?? true,
    criteria: {
      // The first condition stays where every rule ever written keeps it, and
      // the rest sit beside it, so nothing has to be migrated to be read.
      merchantContains: written[0]?.text || undefined,
      merchantMatch: written[0] ? written[0].match : undefined,
      merchantAlso: written.length > 1
        ? written.slice(1).map((t) => ({ join: t.join ?? "and", match: t.match, text: t.text }))
        : undefined,
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
  }), [name, written, accountId, direction, amountMin, amountMax,
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
          <Field label="Merchant">
            <div className="col" style={{ gap: 8 }}>
              {tests.map((t, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={i} className="row rule-cond">
                  {i === 0 ? (
                    <span className="small muted rule-join">Merchant</span>
                  ) : (
                    <SelectInput
                      style={{ width: 74, flex: "none" }}
                      value={t.join ?? "and"}
                      onChange={(v) => setTest(i, { join: v as "and" | "or" })}
                      options={[{ value: "and", label: "and" }, { value: "or", label: "or" }]}
                    />
                  )}
                  <SelectInput
                    style={{ width: 128, flex: "none" }}
                    value={t.match}
                    onChange={(v) => setTest(i, { match: v as MerchantTest["match"] })}
                    options={MATCH_OPTIONS}
                  />
                  <TextInput
                    value={t.text}
                    onChange={(v) => setTest(i, { text: v })}
                    placeholder={i === 0 ? "blue bottle" : "hawk"}
                  />
                  {/* Only past the first: there is always one condition, and a
                      way to remove the last one would leave nothing to type
                      into. Emptying it is how a rule stops naming a merchant. */}
                  {i > 0 ? (
                    <button
                      type="button" className="btn btn-icon"
                      title="Remove this condition" aria-label="Remove this condition"
                      onClick={() => setTests((prev) => prev.filter((_, n) => n !== i))}
                    >
                      <Minus size={14} />
                    </button>
                  ) : null}
                </div>
              ))}
              <div className="row" style={{ gap: 10 }}>
                <button
                  type="button" className="btn btn-icon"
                  title="Add a condition" aria-label="Add a condition"
                  onClick={() => setTests((prev) => [...prev, { text: "", match: "contains", join: "and" }])}
                >
                  <Plus size={14} />
                </button>
                {/* Said only once there is an order to be wrong about. */}
                {tests.length > 1 ? (
                  <span className="tiny faint">
                    Read top to bottom, in order. "Contains" looks at the bank's own wording too; the
                    others compare the merchant name alone.
                  </span>
                ) : (
                  <span className="tiny faint">"Contains" looks at the bank's own wording too.</span>
                )}
              </div>
            </div>
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
              <span className="tiny faint">No tags yet, create them under Configuration → Tags.</span>
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

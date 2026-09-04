import { Fragment, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff, X } from "lucide-react";
import { fmt, fmt0, parseMoney, toInput } from "../lib/money";
import { useStore } from "../store";

export const cx = (...xs: (string | false | null | undefined)[]): string => xs.filter(Boolean).join(" ");

/** CSS custom-property token → usable color. */
export const color = (token: string): string => (token.startsWith("--") ? `var(${token})` : token);

export function Card({ children, className, style, pad = true }: { children: ReactNode; className?: string; style?: CSSProperties; pad?: boolean }) {
  return <div className={cx("card", !pad && "flush", className)} style={style}>{children}</div>;
}

export function CardHead({ title, sub, right, flush }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; flush?: boolean }) {
  return (
    <div className={cx("card-head", flush && "flush")}>
      <div className="col">
        <h2>{title}</h2>
        {sub ? <span className="small muted">{sub}</span> : null}
      </div>
      {right}
    </div>
  );
}

/** Money display that respects privacy mode. */
export function Money({ value, cents = true, sign, colored, compact, className, style }: {
  value: number; cents?: boolean; sign?: boolean; colored?: boolean; compact?: boolean; className?: string; style?: CSSProperties;
}) {
  const { db } = useStore();
  const text = cents ? fmt(value, { sign, compact }) : fmt0(value, { sign, compact });
  const tone = colored ? (value > 0 ? "pos" : value < 0 ? "neg" : "muted") : "";
  return (
    <span className={cx("num", tone, db.settings.privacyMode && "blurred", className)} style={style}>{text}</span>
  );
}

export function Tile({ label, value, sub, tone, onClick }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: "pos" | "neg"; onClick?: () => void;
}) {
  return (
    <Card style={onClick ? { cursor: "pointer" } : undefined}>
      <div onClick={onClick} className="col" style={{ gap: 6 }}>
        <span className="tile-label">{label}</span>
        <span className={cx("tile-value", "num", tone)}>{value}</span>
        {sub ? <span className="small muted">{sub}</span> : null}
      </div>
    </Card>
  );
}

export function Btn({ children, onClick, variant = "default", size, disabled, title, type = "button" }: {
  children: ReactNode; onClick?: () => void; variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm"; disabled?: boolean; title?: string; type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx("btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm")}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={cx(o.value === value && "on")} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <span className="tiny faint">{hint}</span> : null}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, type = "text", autoFocus, name }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
  autoFocus?: boolean;
  /** Optional, and only for telling one field on a page from another. */
  name?: string;
}) {
  return (
    <input
      className="input" type={type} value={value} placeholder={placeholder} autoFocus={autoFocus}
      name={name}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
    />
  );
}

/**
 * A passphrase field you can look at.
 *
 * Two things a bare <input type="password"> gets wrong on a phone. A password
 * manager holding the sync passphrase will happily offer it for the encryption
 * box — they are both nameless password fields on one page — and you cannot
 * see that it did, so a rejected passphrase looks like a rejected passphrase
 * rather than the wrong one pasted in. Hence a name, autocomplete off, and an
 * eye.
 *
 * autoCapitalize and autoCorrect are off because iOS applies both to some
 * fields and a capitalised first letter is a different passphrase.
 */
export function SecretInput({ value, onChange, placeholder, name, onEnter, maxWidth = 300 }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Distinct per field, so nothing cross-fills between them. */
  name: string;
  onEnter?: () => void;
  maxWidth?: number;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="row" style={{ gap: 6, position: "relative", maxWidth, flex: `1 1 ${maxWidth}px` }}>
      <input
        className="input"
        type={shown ? "text" : "password"}
        name={name}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
        style={{ paddingRight: 34 }}
      />
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        title={shown ? "Hide" : "Show"}
        aria-label={shown ? "Hide the passphrase" : "Show the passphrase"}
        onClick={() => setShown((v) => !v)}
        style={{ position: "absolute", right: 2, top: "50%", transform: "translateY(-50%)", padding: 4 }}
      >
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  );
}

/** Keeps a free-text buffer while focused so "-12." stays editable. */
export function MoneyInput({ value, onChange, placeholder, autoFocus }: {
  value: number; onChange: (cents: number) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <input
      className="input num" inputMode="decimal" autoFocus={autoFocus} placeholder={placeholder ?? "0.00"}
      value={buf ?? toInput(value)}
      onChange={(e) => { setBuf(e.target.value); onChange(parseMoney(e.target.value)); }}
      onFocus={(e) => { setBuf(e.target.value); e.currentTarget.select(); }}
      onBlur={() => setBuf(null)}
    />
  );
}

/**
 * A rate, typed as a percentage.
 *
 * Same free-text buffer trick as MoneyInput, for the same reason: "6." is a
 * legitimate thing to be half way through typing, and a field that reformats
 * on every keystroke will not let you get to "6.5".
 */
export function PercentInput({ value, onChange, placeholder }: {
  value: number; onChange: (percent: number) => void; placeholder?: string;
}) {
  const [buf, setBuf] = useState<string | null>(null);
  return (
    <span style={{ position: "relative", display: "flex", width: "100%" }}>
      <input
        className="input num" inputMode="decimal" placeholder={placeholder ?? "0"}
        value={buf ?? String(value)}
        onChange={(e) => {
          setBuf(e.target.value);
          const n = Number.parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? n : 0);
        }}
        onFocus={(e) => { setBuf(e.target.value); e.currentTarget.select(); }}
        onBlur={() => setBuf(null)}
        style={{ paddingRight: 26 }}
      />
      <span
        className="tiny faint"
        style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
      >
        %
      </span>
    </span>
  );
}

/**
 * A dropdown, with headings when the options carry one.
 *
 * `group` is optional and consecutive: options are rendered in the order
 * given, and a run sharing a group becomes an optgroup. A list where nothing
 * carries one renders exactly as it always did, which is what makes this safe
 * to add to a component every screen uses.
 */
export function SelectInput<T extends string>({ value, onChange, options, placeholder, style }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; group?: string }[];
  placeholder?: string;
  style?: CSSProperties;
}) {
  const runs: { group?: string; items: typeof options }[] = [];
  for (const o of options) {
    const last = runs[runs.length - 1];
    if (last && last.group === o.group) last.items.push(o);
    else runs.push({ group: o.group, items: [o] });
  }

  return (
    <select className="select" style={style} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {runs.map((run, i) => {
        const items = run.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>);
        return run.group
          ? <optgroup key={`${run.group}-${i}`} label={run.group}>{items}</optgroup>
          : <Fragment key={`plain-${i}`}>{items}</Fragment>;
      })}
    </select>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  const id = useId();
  return (
    <div className="row" style={{ gap: 9 }}>
      <div className={cx("switch", on && "on")} id={id} role="switch" aria-checked={on} onClick={() => onChange(!on)} />
      {label ? <label htmlFor={id} onClick={() => onChange(!on)} style={{ cursor: "pointer" }}>{label}</label> : null}
    </div>
  );
}

export function Modal({ title, children, onClose, footer, wide }: {
  title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", esc); document.body.style.overflow = ""; };
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx("modal", wide && "wide")}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Anchored popover menu. The menu is portalled to <body> and positioned from the
 * trigger's rect — anchoring it in place would let cards (which clip their
 * contents so rows keep the rounded corners) cut the menu off.
 */
/**
 * How a popover knows a click belongs to one of its own.
 *
 * Every menu is portalled to document.body so a card row cannot clip it, which
 * means a menu opened from inside another menu is not a DOM descendant of it.
 * The outer one saw a click on the inner one as a click outside itself and
 * shut — so choosing a category in the Move money panel closed the panel
 * along with the list, and the panel could only ever be used with whatever it
 * had guessed.
 *
 * So a popover hands its subtree a way to say "this node is mine". Claims pass
 * on up, which makes nesting work to any depth.
 */
const Nest = createContext<((node: Node) => void) | null>(null);

export function Popover({ trigger, children, align = "left", width = 220, className, fill, onOpenChange }: {
  trigger: (open: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
  className?: string;
  /** Stretch the anchor to its container, so a full-width trigger can fill a column. */
  fill?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false });
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const outer = useContext(Nest);
  const owned = useRef(new Set<Node>());
  const claim = useCallback((node: Node) => {
    owned.current.add(node);
    outer?.(node);
  }, [outer]);

  /** Menus opened from inside this one, still on the page. */
  const nested = useCallback((): Node[] => {
    for (const n of owned.current) if (!n.isConnected) owned.current.delete(n);
    return [...owned.current];
  }, []);

  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const up = room < 260 && r.top > room;
    setPos({
      top: up ? r.top - 4 : r.bottom + 4,
      left: Math.max(8, Math.min(
        align === "right" ? r.right - width : r.left,
        window.innerWidth - width - 8,
      )),
      up,
    });
  }, [align, width]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Held in a ref so an inline callback can't retrigger this every render.
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  useEffect(() => { report.current?.(open); }, [open]);

  // Tell whoever opened this one that the menu belongs to them too.
  useEffect(() => {
    if (open && menu.current) outer?.(menu.current);
  }, [open, outer]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.current?.contains(t) || menu.current?.contains(t)) return;
      if (nested().some((n) => n.contains(t))) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      // The innermost open menu takes it, so Escape backs out one step rather
      // than collapsing the whole stack.
      if (e.key === "Escape" && !nested().length) setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, nested]);

  return (
    <div ref={anchor} style={fill ? { display: "flex", width: "100%" } : { display: "inline-flex" }}>
      {trigger(() => setOpen((o) => !o))}
      {open
        ? createPortal(
            <div
              ref={menu}
              className={cx("menu", className)}
              style={{
                position: "fixed", top: pos.top, left: pos.left, width,
                transform: pos.up ? "translateY(-100%)" : undefined,
              }}
            >
              <Nest.Provider value={claim}>{children(() => setOpen(false))}</Nest.Provider>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * A read-only card shown on hover or keyboard focus. Portalled like Popover so
 * a card row can't clip it, and suppressed on mousedown so it doesn't sit on
 * top of whatever the click opens.
 */
export function HoverCard({ children, card, width = 260, fill, disabled }: {
  children: ReactNode;
  card: ReactNode;
  width?: number;
  fill?: boolean;
  /** Suppress the card entirely — e.g. while a panel it would cover is open. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false });
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A click focuses the trigger, and focus would otherwise reopen the card on
  // top of whatever the click opened. Stay shut until the pointer leaves.
  const shut = useRef(false);

  const show = () => {
    const el = anchor.current;
    if (!el || shut.current || disabled) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    setPos({
      top: room < 240 && r.top > room ? r.top - 6 : r.bottom + 6,
      left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)),
      up: room < 240 && r.top > room,
    });
    setOpen(true);
  };

  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };
  const enter = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(show, 140);
  };
  const leave = () => { shut.current = false; close(); };
  const press = () => { shut.current = true; close(); };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // Going disabled while open — the panel just opened underneath — must close it.
  useEffect(() => { if (disabled) { if (timer.current) clearTimeout(timer.current); setOpen(false); } }, [disabled]);

  return (
    <div
      ref={anchor}
      style={fill ? { display: "flex", width: "100%" } : { display: "inline-flex" }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onMouseDown={press}
      onFocus={show}
      onBlur={close}
    >
      {children}
      {open
        ? createPortal(
            <div
              className="menu hover-card"
              style={{
                position: "fixed", top: pos.top, left: pos.left, width,
                transform: pos.up ? "translateY(-100%)" : undefined,
              }}
            >
              {card}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function Progress({ value, max, color: c = "--accent", over }: { value: number; max: number; color?: string; over?: boolean }) {
  const pctRaw = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="bar">
      <i style={{ width: `${Math.min(100, Math.max(0, pctRaw))}%`, background: over ? "var(--neg)" : color(c) }} />
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {body ? <p className="small" style={{ maxWidth: 380, margin: "4px auto 12px" }}>{body}</p> : null}
      {action}
    </div>
  );
}

export function Avatar({ emoji, tone, size = "md" }: { emoji: string; tone?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      className={cx("avatar", size === "sm" && "sm", size === "lg" && "lg")}
      style={tone ? { background: `color-mix(in srgb, ${color(tone)} 20%, transparent)` } : undefined}
    >
      {emoji}
    </span>
  );
}

export function Dot({ tone }: { tone: string }) {
  return <span className="dot" style={{ background: color(tone) }} />;
}

export function TagPill({ name, tone }: { name: string; tone: string }) {
  return (
    <span className="tag" style={{ background: `color-mix(in srgb, ${color(tone)} 18%, transparent)`, color: color(tone) }}>
      {name}
    </span>
  );
}

export function ConfirmButton({ label, confirmLabel, onConfirm, variant = "danger" }: {
  label: string; confirmLabel?: string; onConfirm: () => void; variant?: "danger" | "default";
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <Btn variant={armed ? "danger" : variant} onClick={() => (armed ? onConfirm() : setArmed(true))}>
      {armed ? confirmLabel ?? "Click again to confirm" : label}
    </Btn>
  );
}

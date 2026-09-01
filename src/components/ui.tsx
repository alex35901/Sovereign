import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
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

export function TextInput({ value, onChange, placeholder, type = "text", autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; autoFocus?: boolean;
}) {
  return (
    <input
      className="input" type={type} value={value} placeholder={placeholder} autoFocus={autoFocus}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
    />
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

export function SelectInput<T extends string>({ value, onChange, options, placeholder }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; placeholder?: string;
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
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
export function Popover({ trigger, children, align = "left", width = 220, className, fill }: {
  trigger: (open: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
  className?: string;
  /** Stretch the anchor to its container, so a full-width trigger can fill a column. */
  fill?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean }>({ top: 0, left: 0, up: false });
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
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
  }, [open, place]);

  return (
    <div ref={anchor} style={{ display: fill ? "flex" : "inline-flex" }}>
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
              {children(() => setOpen(false))}
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

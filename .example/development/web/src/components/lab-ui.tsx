import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import type { ActionResult, ActivityTone } from "../lib/lab-types";

export type RunLabAction = (
  actionId: string,
  operation: () => Promise<ActionResult>,
  fallbackNotice?: string,
) => Promise<boolean>;

export function cx(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------- containers */

interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "article" | "section" | "aside" | "div";
  children: ReactNode;
}

export function Card({
  as: Tag = "section",
  children,
  className,
  ...props
}: CardProps) {
  return (
    <Tag className={cx("card", className)} {...props}>
      {children}
    </Tag>
  );
}

/** One title line and at most one control. No eyebrow, no description. */
export function CardHead({
  action,
  title,
}: {
  action?: ReactNode;
  title: string;
}) {
  return (
    <header className="card__head">
      <h2 className="card__title">{title}</h2>
      {action ? <div className="card__action">{action}</div> : null}
    </header>
  );
}

/* ---------------------------------------------------------------- controls */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  size?: "default" | "lg";
  tone?: "default" | "outline" | "secondary" | "ghost" | "destructive";
}

export function Button({
  busy = false,
  children,
  className,
  disabled,
  size = "default",
  tone = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cx(
        "btn",
        `btn--${tone}`,
        size === "lg" && "btn--lg",
        className,
      )}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <span className="btn__spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: ReactNode;
  label: string;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...props} />;
}

export function TextArea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("textarea", className)} {...props} />;
}

export function Select({
  children,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="input-group input-group--select">
      <select className={cx("select", className)} {...props}>
        {children}
      </select>
    </span>
  );
}

export function PrefixedInput({
  className,
  prefix,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { prefix: string }) {
  return (
    <span className="input-group input-group--prefix">
      <span className="input-group__prefix mono" aria-hidden="true">
        {prefix}
      </span>
      <input className={cx("input", className)} {...props} />
    </span>
  );
}

/* -------------------------------------------------------------- indicators */

export function Badge({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: ActivityTone | "neutral";
}) {
  return <span className={cx("badge", `badge--${tone}`)}>{children}</span>;
}

export interface MetaEntry {
  key: string;
  value: ReactNode;
  mono?: boolean;
  title?: string;
}

export function MetaList({
  entries,
  label,
}: {
  entries: MetaEntry[];
  label?: string;
}) {
  return (
    <dl className="kv" aria-label={label}>
      {entries.map((entry) => (
        <div className="kv__item" key={entry.key}>
          <dt className="kv__key">{entry.key}</dt>
          <dd
            className={cx("kv__value", entry.mono && "kv__value--mono")}
            title={entry.title}
          >
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Only rendered mid-flow; a completed rail carries no information. */
export function Stepper({
  current,
  label,
  steps,
}: {
  current: number;
  label: string;
  steps: string[];
}) {
  return (
    <ol className="stepper" aria-label={label}>
      {steps.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? "current" : "todo";
        return (
          <li
            className="stepper__step"
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            key={step}
          >
            <span className="stepper__label">{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------- theme */

type ThemeMode = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "merchantid-lab-theme";

const THEME_OPTIONS: Array<{ mode: ThemeMode; label: string; title: string }> =
  [
    { mode: "system", label: "sys", title: "Ikuti preferensi sistem" },
    { mode: "light", label: "trg", title: "Mode terang" },
    { mode: "dark", label: "glp", title: "Mode gelap" },
  ];

/**
 * The blocking snippet that runs before first paint so the stored theme is
 * applied without a flash. Kept in sync with `applyTheme` below.
 */
export const themeBootScript = `try{var m=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(m==="light"||m==="dark"){document.documentElement.dataset.theme=m}}catch(e){}`;

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* Private-mode storage refusal must not break the control. */
  }
}

export function ThemeSwitch() {
  const [mode, setMode] = useState<ThemeMode>("system");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") setMode(stored);
    } catch {
      /* Ignore - the default already matches the rendered markup. */
    }
  }, []);

  return (
    <div className="theme-switch" role="group" aria-label="Tema tampilan">
      {THEME_OPTIONS.map((option) => (
        <button
          className="theme-switch__option"
          type="button"
          key={option.mode}
          title={option.title}
          aria-label={option.title}
          aria-pressed={mode === option.mode}
          onClick={() => {
            setMode(option.mode);
            applyTheme(option.mode);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- formatters */

const currencyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

export function formatDateTime(value: number | undefined): string {
  return value ? `${dateFormatter.format(value)} WIB` : "-";
}

export function shortId(value: string | undefined): string {
  if (!value) return "-";
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

export function paymentStatusTone(
  status: "pending" | "paid" | "expired" | "cancelled",
): ActivityTone | "neutral" {
  if (status === "paid") return "success";
  if (status === "pending") return "warning";
  if (status === "cancelled") return "danger";
  return "neutral";
}

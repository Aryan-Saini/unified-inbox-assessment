"use client";

/** Shared primitives: the modal shell, the mock badge, chips and toggles. */

import { useEffect, useRef } from "react";
import { CloseIcon } from "./icons";

/**
 * Every panel in this build is fake, and says so. The badge is deliberately
 * loud — a reviewer should never have to guess whether a control does anything.
 */
export function MockBadge({
  children = "Mock",
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase ${className}`}
    >
      {children}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  badge,
  width = "max-w-3xl",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  width?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close dialog"
        onClick={onClose}
        className="fade-in absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`pop-in relative flex max-h-[92vh] w-full ${width} flex-col overflow-hidden rounded-t-2xl border border-line bg-ink-900 shadow-[0_-8px_60px_rgba(0,0,0,0.6)] outline-none sm:rounded-2xl sm:shadow-[0_24px_80px_rgba(0,0,0,0.7)]`}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold text-white">{title}</h2>
              {badge}
            </div>
            {subtitle ? (
              <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-white/5 hover:text-white"
          >
            <CloseIcon className="h-4.5 w-4.5" />
          </button>
        </header>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line bg-ink-850/60 px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl px-1 py-2 transition-colors hover:bg-white/[0.02]">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${
          checked ? "bg-indigo-500" : "bg-neutral-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? "translate-x-4.5" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-neutral-200">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
}) {
  const styles = {
    primary:
      "bg-indigo-500 text-white hover:bg-indigo-400 disabled:bg-indigo-500/40 disabled:text-white/60",
    outline:
      "border border-line-strong text-neutral-200 hover:border-neutral-500 hover:text-white",
    ghost: "text-neutral-300 hover:bg-white/5 hover:text-white",
    danger:
      "border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200",
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
    />
  );
}

/** Connection / run status pill. Colour carries the same meaning everywhere. */
export function StatusPill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "idle" | "info";
  children: React.ReactNode;
}) {
  const tones = {
    ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    bad: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    info: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
    idle: "border-line-strong bg-white/5 text-neutral-400",
  }[tone];

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones}`}
    >
      {children}
    </span>
  );
}

"use client";

/** Shared primitives: the modal shell, chips and toggles. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

/**
 * A truncated label that shows the whole thing on hover.
 *
 * Every long name in this UI is clamped to a width — an address may be 254
 * characters and a workspace may be named without spaces — which leaves the
 * ellipsis as the only account of what was cut. This gives it back, and only
 * when there is something to give back: the tooltip is suppressed unless the
 * text is actually overflowing its box, so a name that fits does not sprout a
 * bubble for no reason.
 *
 * `title` was the cheap version and is deliberately not used: the OS tooltip
 * waits about a second, cannot be styled to match, and — the reason it had to
 * go — is drawn by the platform in a way that made it useless for a name you
 * are trying to *read*, wrapping badly and vanishing on the slightest move.
 *
 * Rendered through a portal because these labels sit inside `overflow-hidden`
 * lists and dialogs, which would clip a bubble positioned inside them.
 */
export function Truncated({
  text,
  className = "",
  children,
}: {
  /** The full value, shown on hover. */
  text: string;
  className?: string;
  /** Rendered in place of `text` when the visible form is richer than the
   *  string — "George at aryan-test", an address hung off a name. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const el = ref.current;
    if (el === null) return;
    // Nothing was cut, so there is nothing to reveal.
    if (el.scrollWidth <= el.clientWidth + 1) return;
    const r = el.getBoundingClientRect();
    setAt({ left: r.left, top: r.top });
  };

  const hide = () => setAt(null);

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        tabIndex={0}
        className={`truncate ${className}`}
      >
        {children ?? text}
      </span>

      {at === null || typeof document === "undefined"
        ? null
        : createPortal(
            <span
              role="tooltip"
              style={{
                // Clamped to the viewport on both axes: these labels sit at the
                // right-hand edge of cards and near the top of dialogs, and a
                // bubble that renders off-screen is the same as no bubble.
                left: Math.max(8, Math.min(at.left, window.innerWidth - 448)),
                top: Math.max(8, at.top - 10),
              }}
              className="pointer-events-none fixed z-[80] max-w-[27rem] -translate-y-full rounded-lg border border-line-strong bg-ink-900 px-2.5 py-1.5 text-[12px] leading-relaxed break-words text-neutral-100 shadow-[0_12px_40px_rgba(0,0,0,0.7)]"
            >
              {text}
            </span>,
            document.body,
          )}
    </>
  );
}

/**
 * Every open dialog, innermost last.
 *
 * Escape belongs to the top one alone. A settings dialog opened *over* a draft
 * is the case that makes this load-bearing: one keypress closing both would
 * throw the draft away as a side effect of leaving settings.
 */
const OPEN_MODALS: object[] = [];

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  badge,
  heading,
  width = "max-w-3xl",
  footer,
  mobileFullScreen = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  /** Replaces the title/subtitle block, for a dialog whose header is better
   *  stated by the thing it is about than by a sentence describing it. `title` is
   *  still required and still names the dialog to a screen reader. */
  heading?: React.ReactNode;
  width?: string;
  footer?: React.ReactNode;
  /** Take the whole viewport on a phone instead of sitting as a bottom sheet. */
  mobileFullScreen?: boolean;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Read through a ref so the effect below depends on `open` alone: callers pass
  // an inline arrow, and re-running on every render would keep re-stacking this
  // dialog over whatever was opened on top of it.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    OPEN_MODALS.push(panel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (OPEN_MODALS[OPEN_MODALS.length - 1] !== panel) return;
      close.current();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = OPEN_MODALS.indexOf(panel);
      if (at !== -1) OPEN_MODALS.splice(at, 1);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center sm:items-center ${
        mobileFullScreen ? "items-stretch" : "items-end"
      }`}
    >
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
        className={`pop-in relative flex w-full ${width} flex-col overflow-hidden border-line bg-ink-900 outline-none sm:max-h-[92vh] sm:rounded-2xl sm:border sm:shadow-[0_24px_80px_rgba(0,0,0,0.7)] ${
          mobileFullScreen
            ? // `sm:h-auto` is load-bearing: without it the phone's full-height
              // panel persists on desktop and the box towers over its content.
              "h-dvh rounded-none sm:h-auto"
            : "max-h-[92vh] rounded-t-2xl border shadow-[0_-8px_60px_rgba(0,0,0,0.6)]"
        }`}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            {heading ?? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[15px] font-semibold text-white">{title}</h2>
                  {badge}
                </div>
                {subtitle ? (
                  <p className="mt-1 text-[13px] leading-relaxed text-neutral-400">
                    {subtitle}
                  </p>
                ) : null}
              </>
            )}
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

/**
 * Confirmation for something destructive.
 *
 * A dialog rather than an inline "are you sure?" on the row it belongs to: a row
 * already carries a label, a status pill and its own action, so a question plus
 * two more buttons crowded in beside them wraps the label and leaves the
 * destructive button a few pixels from an unrelated one. A dialog also has room
 * to say what the action actually does, which an inline prompt never does.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  confirmLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  confirmLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-md">
      <div className="px-5 py-4 text-[13px] leading-relaxed text-neutral-400">
        {children}
      </div>
      <footer className="flex items-center justify-end gap-2.5 border-t border-line bg-ink-850/60 px-5 py-3.5">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            // Close first: the row this was opened for is about to disappear, and
            // a dialog outliving its subject reads as a hang.
            onClose();
            onConfirm();
          }}
          autoFocus
        >
          {confirmLabel}
        </Button>
      </footer>
    </Modal>
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
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? "translate-x-4" : "translate-x-0"
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
    // Filled, not just outlined: destructive actions should be recognisable as
    // destructive before the label is read, and an outline alone put it in the
    // same visual class as the neutral `outline` variant beside it.
    danger:
      "border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:border-rose-500/60 hover:bg-rose-500/20 hover:text-rose-200",
  }[variant];

  return (
    // Defaults to type="button": these render inside the search <form>, where an
    // unmarked button would submit it. Callers can still override.
    <button
      type="button"
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${tones}`}
    >
      {children}
    </span>
  );
}

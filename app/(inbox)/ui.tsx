"use client";

/** Shared primitives: the modal shell, chips and toggles. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useKeyboardInset } from "../useKeyboardInset";
import { CloseIcon } from "./icons";

/**
 * A truncated label that hands the whole value back — on hover with a mouse, in
 * a sheet on a tap.
 *
 * Every long name in this UI is clamped to a width — an address may be 254
 * characters and a workspace may be named without spaces — which leaves the
 * ellipsis as the only account of what was cut. This gives it back, and only
 * when there is something to give back: neither affordance appears unless the
 * text is actually overflowing its box, so a name that fits does not sprout a
 * bubble for no reason.
 *
 * The two routes exist because a phone has no hover. The tooltip below was the
 * *whole* recovery path for a clamped name, which meant that on the device where
 * the clamp bites hardest the full address was simply unreachable. A tap on a
 * clipped label opens a bottom sheet with the value in it, wrapped and
 * selectable — something you can read, rather than a bubble you cannot summon.
 * Whether the gesture was a tap is read from the pointer event rather than from
 * `(hover: none)`, for the same reason `ResultCard` does: the media query
 * describes the device, and a touchscreen laptop is both.
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
  label = "Full text",
  className = "",
  children,
}: {
  /** The full value, shown on hover and in the sheet. */
  text: string;
  /** Names the value in the sheet's header — "Sender", "Where this lives". */
  label?: string;
  className?: string;
  /** Rendered in place of `text` when the visible form is richer than the
   *  string — "George at aryan-test", an address hung off a name. */
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const bubble = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [sheet, setSheet] = useState(false);

  /**
   * Whether anything is actually cut, kept in state rather than measured at the
   * moment of the gesture.
   *
   * Hover could ask on demand; the tap route cannot, because the affordance has
   * to be *visible* — a label that opens a sheet says so with a dotted underline
   * before it is touched, and one that fits must not. Re-measured on resize, so
   * rotating a phone does not leave the hint lying.
   */
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, children]);

  /** Set on the gesture that precedes the click, before the click decides. */
  const fromTouch = useRef(false);

  const show = () => {
    const el = ref.current;
    if (el === null || fromTouch.current) return;
    // Nothing was cut, so there is nothing to reveal.
    if (el.scrollWidth <= el.clientWidth + 1) return;
    setAnchor(el.getBoundingClientRect());
  };

  const hide = () => {
    setAnchor(null);
    setAt(null);
  };

  const open = () => {
    if (!clipped) return;
    hide();
    setSheet(true);
  };

  /**
   * Above by preference, below when there is no room above.
   *
   * Preference rather than rule, because these labels are the *first* line of
   * a card and several of them sit within a bubble's height of the top of the
   * viewport — a tooltip that only ever renders upward is drawn off-screen
   * there, which is the same as not having one. The height is measured rather
   * than guessed: the text wraps, so a 254-character address is five lines and
   * a workspace name is two.
   *
   * `useLayoutEffect` so the measure-then-place happens before paint; the first
   * pass renders it hidden off-screen, and nothing flickers.
   */
  useLayoutEffect(() => {
    const el = bubble.current;
    if (anchor === null || el === null) return;

    const gap = 8;
    const { offsetWidth: w, offsetHeight: h } = el;
    const above = anchor.top - gap - h;

    setAt({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8)),
      top:
        above >= 8
          ? above
          : Math.min(anchor.bottom + gap, window.innerHeight - h - 8),
    });
  }, [anchor]);

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onPointerDown={(event) => {
          fromTouch.current = event.pointerType !== "mouse";
        }}
        onClick={(event) => {
          if (!fromTouch.current || !clipped) return;
          // The label sits inside links and cards that answer to a tap of their
          // own; reading what was cut is a different intent from following the
          // row, so the gesture stops here.
          event.preventDefault();
          event.stopPropagation();
          open();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (!clipped) return;
          event.preventDefault();
          open();
        }}
        role={clipped ? "button" : undefined}
        aria-label={clipped ? `${label}, truncated — open in full` : undefined}
        tabIndex={0}
        // The hint is drawn only when something was cut, and only where a tap is
        // the way in: on a mouse the underline would promise a click that hover
        // has already answered.
        className={`truncate ${
          clipped
            ? "cursor-pointer decoration-neutral-600 decoration-dotted underline-offset-4 [@media(hover:none)]:underline"
            : ""
        } ${className}`}
      >
        {children ?? text}
      </span>

      {/* The tap route. A sheet rather than a bubble: the value it exists to
          show can be 254 characters, which is four lines on a phone — a
          floating tooltip that size is a dialog wearing a disguise. */}
      <Modal
        open={sheet}
        onClose={() => setSheet(false)}
        title={label}
        width="max-w-md"
      >
        <p className="px-5 py-4 text-[14.5px] leading-relaxed wrap-anywhere text-neutral-200 select-all">
          {text}
        </p>
      </Modal>

      {anchor === null || typeof document === "undefined"
        ? null
        : createPortal(
            <span
              ref={bubble}
              role="tooltip"
              style={
                at === null
                  ? // First pass: laid out at full width, off-screen, so it can
                    // be measured before it is placed.
                    { left: -9999, top: 0, visibility: "hidden" }
                  : { left: at.left, top: at.top }
              }
              className="pointer-events-none fixed z-[80] max-w-[27rem] rounded-lg border border-line-strong bg-ink-900 px-2.5 py-1.5 text-[13px] leading-relaxed wrap-anywhere text-neutral-100 shadow-[0_12px_40px_rgba(0,0,0,0.7)]"
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

  // `fixed inset-0` is the *layout* viewport, which iOS does not shrink for the
  // keyboard — so a bottom sheet keeps its footer at the bottom of the window,
  // under the keys. The dialogs that take text are the ones whose footer holds
  // Send and Confirm, which is the worst button in the app to put out of reach.
  // Padding the overlay moves the sheet's floor up to the top of the keyboard.
  const keyboard = useKeyboardInset();

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

  if (!open || typeof document === "undefined") return null;

  /**
   * Through a portal, for the reason `Truncated`'s tooltip is: `fixed` is only
   * the viewport when no ancestor has a transform, and the result cards animate
   * in on one. A dialog opened from inside a card was laid out against the card
   * — the right size for a box a third of the screen wide, in the wrong place,
   * with a backdrop that covered the card and nothing else.
   */
  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center sm:items-center ${
        mobileFullScreen ? "items-stretch" : "items-end"
      }`}
      style={keyboard === 0 ? undefined : { paddingBottom: keyboard }}
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
        // `min-w-0` is load-bearing, not decoration: a flex item will not shrink
        // below the widest unbreakable thing inside it, so a dialog titled with
        // a 254-character address grew past `max-w-*` and past the viewport with
        // it — centred, so it bled off *both* edges. The title wraps anywhere
        // (below) and this lets the box believe it.
        className={`pop-in relative flex w-full min-w-0 ${width} flex-col overflow-hidden border-line bg-ink-900 outline-none sm:max-h-[92vh] sm:rounded-2xl sm:border sm:shadow-[0_24px_80px_rgba(0,0,0,0.7)] ${
          mobileFullScreen
            ? // `h-full` rather than `h-dvh`: it resolves against the overlay's
              // content box, which is the window *minus* the keyboard, where
              // `dvh` is the window regardless. `sm:h-auto` is load-bearing too —
              // without it the phone's full-height panel persists on desktop and
              // the box towers over its content.
              "h-full rounded-none sm:h-auto"
            : // Whichever is shorter: the sheet's usual 92% peek, or all of the
              // room the keyboard has left.
              "max-h-[min(92vh,100%)] rounded-t-2xl border shadow-[0_-8px_60px_rgba(0,0,0,0.6)]"
        }`}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            {heading ?? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {/* `wrap-anywhere`, not `break-words`: only the former also
                      shrinks the element's *min-content* width, which is what
                      the flex column above measures itself against. */}
                  <h2 className="min-w-0 text-[16px] font-semibold wrap-anywhere text-white">
                    {title}
                  </h2>
                  {badge}
                </div>
                {subtitle ? (
                  <p className="mt-1 text-[14.5px] leading-relaxed text-neutral-400">
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
    </div>,
    document.body,
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
      {/* The body names the thing being removed, which is the same address that
          made the title overflow — so it wraps on the same terms. */}
      <div className="px-5 py-4 text-[14.5px] leading-relaxed wrap-anywhere text-neutral-400">
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
        <span className="block text-[14.5px] font-medium text-neutral-200">
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
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[14.5px] font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] font-medium ${tones}`}
    >
      {children}
    </span>
  );
}

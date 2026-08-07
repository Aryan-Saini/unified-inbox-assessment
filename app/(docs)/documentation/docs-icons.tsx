/**
 * Icons the documentation chrome needs and the app's set does not have.
 *
 * Same construction as `app/(inbox)/icons.tsx` — hand-rolled, one stroke
 * weight, one 24 grid — so the two sets sit together without a seam. Kept
 * separate rather than added there because nothing in the inbox shell wants a
 * half-filled contrast circle or a section glyph.
 */

type Props = { className?: string };

function Svg({
  className,
  children,
  fill,
}: Props & { children: React.ReactNode; fill?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Theme switcher. A circle half-filled — light on one side, dark on the other. */
export const ContrastIcon = (p: Props) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <circle
      cx="12"
      cy="12"
      r="8.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    />
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17Z" fill="currentColor" />
  </svg>
);

export const SunIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
  </Svg>
);

export const MoonIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </Svg>
);

/** Terminal, for the header bar of a shell code block. */
export const TerminalIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" />
  </Svg>
);

/** Braces, for the header bar of a JSON block. */
export const BracesIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M9 4.5c-2 0-2.5 1-2.5 2.5v2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3v2c0 1.5.5 2.5 2.5 2.5" />
    <path d="M15 4.5c2 0 2.5 1 2.5 2.5v2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3v2c0 1.5-.5 2.5-2.5 2.5" />
  </Svg>
);

export const CopyIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15" />
  </Svg>
);

/** Section marker in the sidebar — a compass rose reduced to a dot and ring. */
export const RocketIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3c3 1.8 5 5 5 8.5L12 16l-5-4.5C7 8 9 4.8 12 3Z" />
    <circle cx="12" cy="9.5" r="1.6" />
    <path d="M9 16.5 7.5 21l3.2-1.6M15 16.5l1.5 4.5-3.2-1.6" />
  </Svg>
);

export const LockIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
    <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
  </Svg>
);

export const LayersIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
    <path d="m3.5 12 8.5 4.5L20.5 12M3.5 16.5 12 21l8.5-4.5" />
  </Svg>
);

export const SparkIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 3.5 13.8 9 19 10.8 13.8 12.6 12 18l-1.8-5.4L5 10.8 10.2 9 12 3.5Z" />
    <path d="M18.5 16.5l.6 1.8 1.9.6-1.9.7-.6 1.9-.7-1.9-1.8-.7 1.8-.6.7-1.8Z" />
  </Svg>
);

export const SearchGlyph = (p: Props) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Svg>
);

export const MenuGlyph = (p: Props) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const XGlyph = (p: Props) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const ChevronIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);

/** The two directions of the previous/next cards. */
export const ArrowLeftIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M19 12H5M10.5 6.5 5 12l5.5 5.5" />
  </Svg>
);

export const ArrowRightIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5" />
  </Svg>
);

/** "On this page" — a document with its lines showing. */
export const ContentsGlyph = (p: Props) => (
  <Svg {...p}>
    <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
    <path d="M8 8.5h8M8 12h8M8 15.5h5" />
  </Svg>
);

export const ArrowUpRightIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M7 17 17 7M8.5 7H17v8.5" />
  </Svg>
);

export const CheckGlyph = (p: Props) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const InfoGlyph = (p: Props) => (
  <Svg {...p} fill>
    <path d="M12 2.6A9.4 9.4 0 1 0 12 21.4 9.4 9.4 0 0 0 12 2.6Zm0 4a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Zm1.15 10.9h-2.3v-6.6h2.3v6.6Z" />
  </Svg>
);

export const WarnGlyph = (p: Props) => (
  <Svg {...p} fill>
    <path d="M12 2.8a1.3 1.3 0 0 1 1.13.66l8.5 15.1A1.3 1.3 0 0 1 20.5 20.5h-17a1.3 1.3 0 0 1-1.13-1.94l8.5-15.1A1.3 1.3 0 0 1 12 2.8Zm-1.15 5.9v5.4h2.3V8.7h-2.3Zm0 7.1v2.3h2.3v-2.3h-2.3Z" />
  </Svg>
);

/** The "Docs" chip beside the wordmark in the header. */
export const BookGlyph = (p: Props) => (
  <Svg {...p}>
    <path d="M12 6.5C10.5 5.2 8.6 4.5 6 4.5H4v13h2c2.6 0 4.5.7 6 2 1.5-1.3 3.4-2 6-2h2v-13h-2c-2.6 0-4.5.7-6 2Z" />
    <path d="M12 6.5v13" />
  </Svg>
);

export const PlugGlyph = (p: Props) => (
  <Svg {...p}>
    <path d="M9 3v5M15 3v5" />
    <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z" />
    <path d="M12 17v4" />
  </Svg>
);

export const InboxGlyph = (p: Props) => (
  <Svg {...p}>
    <path d="M3.5 13.5 6 5.5h12l2.5 8v5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-5Z" />
    <path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" />
  </Svg>
);

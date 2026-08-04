/**
 * Unified Inbox mark: three channels (Gmail, Slack, web) funnelling into one
 * point. Strokes use `currentColor` so it inherits the surrounding text color.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      role="img"
      aria-label="Unified Inbox"
    >
      <rect x="1" y="1" width="30" height="30" rx="9" />
      <path d="M7 10h6c4 0 3.5 6 7.5 6" />
      <path d="M7 16h13.5" />
      <path d="M7 22h6c4 0 3.5-6 7.5-6" />
      <circle cx="23.5" cy="16" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

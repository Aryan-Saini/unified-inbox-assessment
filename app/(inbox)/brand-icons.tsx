/**
 * Full-colour provider marks, inlined rather than fetched so the modal has no
 * network dependency and no flash of missing logo.
 *
 * Gmail and Slack are the official marks, taken from svgl.app
 * (https://svgl.app/library/gmail.svg, https://svgl.app/library/slack.svg).
 * They are trademarks of their respective owners and are used here only to
 * identify the connector.
 *
 * "Web" has no vendor, so it gets a drawn globe in the web accent instead.
 *
 * These are decorative — every place they appear is already labelled in text —
 * so they are hidden from assistive tech.
 */

type Props = { className?: string };

const base = (className = "") => ({
  className,
  "aria-hidden": true as const,
  focusable: "false" as const,
});

export const GmailLogo = ({ className }: Props) => (
  <svg {...base(className)} viewBox="0 49.4 512 399.42">
    <g fill="none" fillRule="evenodd">
      <g fillRule="nonzero">
        <path
          fill="#4285f4"
          d="M34.91 448.818h81.454V251L0 163.727V413.91c0 19.287 15.622 34.91 34.91 34.91z"
        />
        <path
          fill="#34a853"
          d="M395.636 448.818h81.455c19.287 0 34.909-15.622 34.909-34.909V163.727L395.636 251z"
        />
        <path
          fill="#fbbc04"
          d="M395.636 99.727V251L512 163.727v-46.545c0-43.142-49.25-67.782-83.782-41.891z"
        />
      </g>
      <path
        fill="#ea4335"
        d="M116.364 251V99.727L256 204.455 395.636 99.727V251L256 355.727z"
      />
      <path
        fill="#c5221f"
        fillRule="nonzero"
        d="M0 117.182v46.545L116.364 251V99.727L83.782 75.291C49.25 49.4 0 74.04 0 117.18z"
      />
    </g>
  </svg>
);

export const SlackLogo = ({ className }: Props) => (
  <svg {...base(className)} viewBox="0 0 2447.6 2452.5">
    <g clipRule="evenodd" fillRule="evenodd">
      <path
        fill="#36c5f0"
        d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z"
      />
      <path
        fill="#2eb67d"
        d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z"
      />
      <path
        fill="#ecb22e"
        d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z"
      />
      <path
        fill="#e01e5a"
        d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0"
      />
    </g>
  </svg>
);

export const WebLogo = ({ className }: Props) => (
  <svg
    {...base(className)}
    viewBox="0 0 24 24"
    fill="none"
    stroke="#38bdf8"
    strokeWidth="1.7"
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="9.25" />
    <path d="M2.9 9.4h18.2M2.9 14.6h18.2" />
    <path d="M12 2.75c-2.5 2.4-3.9 5.8-3.9 9.25s1.4 6.85 3.9 9.25c2.5-2.4 3.9-5.8 3.9-9.25S14.5 5.15 12 2.75z" />
  </svg>
);

/**
 * The same globe, struck through — web search switched off. The slash is drawn
 * twice: once thick in the surface colour to cut a gap through the globe
 * beneath it, then thin on top. Without that gap the diagonal just reads as one
 * more meridian.
 */
export const WebOffLogo = ({ className }: Props) => (
  <svg
    {...base(className)}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="9.25" />
    <path d="M2.9 9.4h18.2M2.9 14.6h18.2" />
    <path d="M12 2.75c-2.5 2.4-3.9 5.8-3.9 9.25s1.4 6.85 3.9 9.25c2.5-2.4 3.9-5.8 3.9-9.25S14.5 5.15 12 2.75z" />
    <path d="M4.2 19.8 19.8 4.2" stroke="var(--color-ink-850)" strokeWidth="3.4" />
    <path d="M4.2 19.8 19.8 4.2" />
  </svg>
);

export const BRAND_LOGO: Record<
  "gmail" | "slack" | "web",
  (p: Props) => React.ReactElement
> = {
  gmail: GmailLogo,
  slack: SlackLogo,
  web: WebLogo,
};

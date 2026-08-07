import Link from "next/link";
import { Fragment, type ReactNode } from "react";

/**
 * The three inline forms the documentation source uses, rendered.
 *
 * A deliberate three and not a markdown parser: the content in `spec.ts` and
 * `guide.ts` has to be emitted as markdown *and* as React, and the smallest
 * thing that satisfies both is a syntax small enough to render by hand. A real
 * parser would be a dependency, a bundle, and a set of behaviours nobody here
 * asked for — and the markdown emitter would still just be passing the string
 * through.
 *
 * Anything else in the text — an em dash, a quote, an arrow — is literal, which
 * is why the prose can be written naturally.
 */
const PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;

export function Inline({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  // `matchAll` rather than a `lastIndex` loop: the regex is module-scoped and
  // shared across every call, so mutating its state here would make two
  // concurrent renders interfere.
  for (const match of text.matchAll(PATTERN)) {
    const at = match.index;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    cursor = at + match[0].length;

    const [, code, bold, italic, linkText, href] = match;
    const key = `${at}`;

    if (code !== undefined) {
      nodes.push(
        <code
          key={key}
          className="rounded border border-line bg-ink-850 px-1 py-0.5 font-mono text-[0.9em] wrap-anywhere text-indigo-200"
        >
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-neutral-100">
          {bold}
        </strong>,
      );
    } else if (italic !== undefined) {
      nodes.push(
        <em key={key} className="text-neutral-300 italic">
          {italic}
        </em>,
      );
    } else {
      const external = href.startsWith("http");
      const className =
        "text-indigo-300 underline decoration-indigo-400/30 underline-offset-2 transition-colors hover:text-indigo-200 hover:decoration-indigo-300";
      // A cross-page link inside the documentation goes through the router, so
      // moving between pages swaps the content column instead of reloading the
      // shell and losing the sidebar's scroll position.
      nodes.push(
        external ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className={className}>
            {linkText}
          </a>
        ) : (
          <Link key={key} href={href} className={className}>
            {linkText}
          </Link>
        ),
      );
    }
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));

  return (
    <>
      {nodes.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </>
  );
}

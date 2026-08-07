/**
 * The React half of the two renderings — `markdown.ts` is the other.
 *
 * Every component here is a server component: the documentation is text, and
 * text that only exists after hydration is text an agent fetching the HTML, a
 * crawler, or a reader with JavaScript off does not have. The one client
 * component on the page is the copy button, and it decorates content that is
 * already in the markup.
 */

import type { Block } from "./guide";
import { Inline } from "./inline";
import { CopyButton } from "./Copy";
import type { Field } from "./spec";

/* --------------------------------------------------------------------- code */

export function CodeBlock({
  code,
  caption,
  copy = true,
}: {
  code: string;
  caption?: string;
  copy?: boolean;
}) {
  return (
    <figure className="my-4">
      {caption === undefined ? null : (
        <figcaption className="mb-1.5 text-[12px] text-neutral-500">
          <Inline text={caption} />
        </figcaption>
      )}
      <div className="group relative overflow-hidden rounded-xl border border-line bg-ink-900">
        {copy ? (
          // Revealed on hover with a mouse, but permanently visible where there
          // is no hover: on a phone the block scrolls sideways and selecting a
          // long curl by hand is the worst way to get it, so the one affordance
          // that replaces that must not be gated behind a gesture the device
          // cannot make.
          <div className="absolute top-2 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <CopyButton value={code} />
          </div>
        ) : null}
        {/* `overflow-x-auto` on the pre and `min-w-0` on every ancestor: a long
            curl line is unbreakable, and a flex or grid child will not shrink
            below its widest unbreakable content — so without this the whole
            page grows a horizontal scrollbar instead of the block doing it. */}
        <pre className="scrollbar-thin overflow-x-auto px-4 py-3.5 text-[12.5px] leading-relaxed">
          <code className="font-mono text-neutral-200">{code}</code>
        </pre>
      </div>
    </figure>
  );
}

/* -------------------------------------------------------------------- tables */

export function DocTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="scrollbar-thin my-4 overflow-x-auto rounded-xl border border-line">
      {/* `min-w` so the box scrolls rather than crushing itself: left to `w-full`
          alone, auto table layout gave the name column less room than the word
          in it and broke `order` across two lines. */}
      <table className="w-full min-w-[34rem] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-ink-900">
            {head.map((cell) => (
              <th
                key={cell}
                className="px-3.5 py-2.5 text-[11.5px] font-semibold tracking-wide text-neutral-400 uppercase"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, i) => (
            <tr key={i} className="align-top">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3.5 py-2.5 ${
                    // The first column is a name or a status code — one token,
                    // and the column the reader scans down, so it never breaks.
                    // Everything after it is prose and wraps anywhere.
                    j === 0
                      ? "whitespace-nowrap text-neutral-200"
                      : "wrap-anywhere text-neutral-400"
                  }`}
                >
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The field table shared by request bodies, query params and object shapes. */
export function FieldTable({ fields, nameHead = "Field" }: { fields: Field[]; nameHead?: string }) {
  return (
    <DocTable
      head={[nameHead, "Type", "Required", "Description"]}
      rows={fields.map((f) => [
        `\`${f.name}\``,
        `\`${f.type}\``,
        f.required === true ? "yes" : "—",
        f.description,
      ])}
    />
  );
}

/* --------------------------------------------------------------------- notes */

export function NoteBox({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "border-amber-500/30 bg-amber-500/[0.06]"
      : "border-indigo-500/30 bg-indigo-500/[0.06]";
  const titleColour = tone === "warn" ? "text-amber-200" : "text-indigo-200";

  return (
    <aside className={`my-4 rounded-xl border px-4 py-3.5 ${styles}`}>
      <p className={`text-[13px] font-semibold ${titleColour}`}>
        <Inline text={title} />
      </p>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-neutral-300">{children}</div>
    </aside>
  );
}

/* ------------------------------------------------------------------- prose */

export function Prose({ text }: { text: string }) {
  return (
    <p className="my-3 text-[13.5px] leading-[1.75] text-neutral-400">
      <Inline text={text} />
    </p>
  );
}

/* ------------------------------------------------------- the guide block tree */

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return <Prose text={block.text} />;

    case "code":
      return <CodeBlock code={block.code} caption={block.caption} />;

    case "note":
      return (
        <NoteBox tone={block.tone} title={block.title}>
          <Inline text={block.text} />
        </NoteBox>
      );

    case "table":
      return <DocTable head={block.head} rows={block.rows} />;

    case "list": {
      const List = block.ordered === true ? "ol" : "ul";
      return (
        <List
          className={`my-3 space-y-2 pl-5 text-[13.5px] leading-[1.75] text-neutral-400 ${
            block.ordered === true ? "list-decimal" : "list-disc"
          } marker:text-neutral-600`}
        >
          {block.items.map((item, i) => (
            <li key={i} className="pl-1">
              <Inline text={item} />
            </li>
          ))}
        </List>
      );
    }
  }
}

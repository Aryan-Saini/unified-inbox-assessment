/**
 * The React half of the two renderings — `markdown.ts` is the other.
 *
 * Every component here is a server component: the documentation is text, and
 * text that only exists after hydration is text an agent fetching the HTML, a
 * crawler, or a reader with JavaScript off does not have. The only client
 * components on the page are the chrome — the rail and the copy controls — and
 * they decorate content that is already in the markup.
 *
 * Styling is the app's own: `ink-*` surfaces, `line` borders, indigo for the
 * accent, emerald/amber/rose for status, and the radii the inbox shell uses
 * (`rounded-xl` for a bordered box, `rounded-lg` for a control, `rounded-md`
 * for a chip). There is no second palette to keep in step with `globals.css`.
 */

import type { Block } from "./guide";
import { Inline } from "./inline";
import { CopyButton } from "./Copy";
import { BracesIcon, InfoGlyph, TerminalIcon, WarnGlyph } from "./docs-icons";
import type { Field } from "./spec";

/* --------------------------------------------------------------------- code */

/**
 * A code block with a titled header bar.
 *
 * The bar is not decoration: it names what the block *is* — a shell you run, a
 * response you receive — which is the distinction a reader most needs on a page
 * where the two alternate, and which indentation alone does not carry. It also
 * gives the copy button somewhere to live that is not on top of the first line.
 */
export function CodeBlock({
  code,
  caption,
  label,
  lang = "bash",
  copy = true,
}: {
  code: string;
  /**
   * A sentence about the block, rendered above it. Distinct from `label`, which
   * is the bar's short name — the guide's captions are prose ("Set these once;
   * every example below uses them") and would be a poor thing to truncate into
   * an 11px header.
   */
  caption?: string;
  /** The header-bar name. Defaults to what the language implies. */
  label?: string;
  lang?: string;
  copy?: boolean;
}) {
  const isData = lang === "json";
  const Icon = isData ? BracesIcon : TerminalIcon;
  const title = label ?? (isData ? "Response" : lang === "http" ? "Header" : "Terminal");

  return (
    <>
      {caption === undefined ? null : (
        <p className="mt-4 mb-1.5 text-[12px] text-neutral-500">
          <Inline text={caption} />
        </p>
      )}
      <figure
        className={`overflow-hidden rounded-xl border border-line bg-ink-950 ${
          caption === undefined ? "my-4" : "mb-4"
        }`}
      >
        <figcaption className="flex items-center gap-2 border-b border-line bg-ink-900 px-3 py-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-neutral-500 uppercase">
            {title}
          </span>
          {copy ? <CopyButton value={code} /> : null}
        </figcaption>

        {/* `overflow-x-auto` here and `min-w-0` on every ancestor: a long curl
            line is unbreakable, and a flex or grid child will not shrink below
            its widest unbreakable content — without it the page grows a
            horizontal scrollbar instead of the block doing it. */}
        <pre className="scrollbar-thin overflow-x-auto px-4 py-3.5 text-[12.5px] leading-relaxed">
          <code className="font-mono text-neutral-300">{code}</code>
        </pre>
      </figure>
    </>
  );
}

/* -------------------------------------------------------------------- tables */

/**
 * Should this cell be allowed to break mid-word?
 *
 * Column position is the wrong test, and using it produced `strin`/`g` in a
 * Type column: which columns hold prose differs per table — the error table's
 * last *two* are sentences, a field table's last one is. What actually
 * distinguishes them is the content. A lone `code` span or a short token is one
 * indivisible thing and must never break; anything longer is prose and should.
 */
function isTight(cell: string): boolean {
  return /^`[^`]+`$/.test(cell) || cell.length <= 12;
}

export function DocTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="scrollbar-thin my-4 overflow-x-auto rounded-xl border border-line">
      {/* `min-w` so the box scrolls rather than crushing itself: left to
          `w-full` alone, auto table layout gave the name column less room than
          the word in it and broke `order` across two lines. */}
      <table className="w-full min-w-[34rem] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-ink-850/60">
            {head.map((cell) => (
              <th
                key={cell}
                className="px-3.5 py-2.5 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase"
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
                  className={`px-3.5 py-2.5 ${j === 0 ? "text-neutral-200" : "text-neutral-400"} ${
                    isTight(cell) ? "whitespace-nowrap" : "wrap-anywhere"
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
        f.required === true ? "yes" : "no",
        f.description,
      ])}
    />
  );
}

/* --------------------------------------------------------------------- notes */

/**
 * A callout, in the two tones the app already uses for the same meanings:
 * indigo for "worth knowing", amber for "this will bite you". Same tints as
 * `StatusPill`, so a warning here and a warning in the outbox read alike.
 */
export function NoteBox({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const warn = tone === "warn";
  const Icon = warn ? WarnGlyph : InfoGlyph;

  return (
    <aside
      className={`my-4 flex gap-3 rounded-xl border px-4 py-3.5 ${
        warn
          ? "border-amber-500/30 bg-amber-500/[0.07]"
          : "border-indigo-500/30 bg-indigo-500/[0.07]"
      }`}
    >
      {/* The icon carries the tone; the body stays at reading contrast rather
          than being tinted, which is what keeps a long callout readable. */}
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? "text-amber-300" : "text-indigo-300"}`}
      />
      <div className="min-w-0">
        <p className={`text-[13px] font-semibold ${warn ? "text-amber-200" : "text-indigo-200"}`}>
          <Inline text={title} />
        </p>
        <div className="mt-1 text-[13px] leading-relaxed text-neutral-300">{children}</div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------- prose */

export function Prose({ text }: { text: string }) {
  return (
    <p className="my-3.5 text-[13px] leading-relaxed text-neutral-400">
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
      return <CodeBlock code={block.code} caption={block.caption} lang={block.lang} />;

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
          className={`my-3.5 space-y-2 pl-5 text-[13px] leading-relaxed text-neutral-400 ${
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

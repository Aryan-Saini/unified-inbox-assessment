import Link from "next/link";
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpRightIcon } from "./docs-icons";
import type { DocPage } from "./pages";

/**
 * The bottom of every page: where to go next, and where the machine-readable
 * copies are.
 *
 * The pair of cards is the thing a split site owes its reader. Once the
 * documentation is no longer one scroll, "keep reading" stops being free — so
 * reading order is made explicit and walkable with one click, straight through
 * the guide, the reference and the appendix.
 */

function NavCard({ page, direction }: { page: DocPage; direction: "previous" | "next" }) {
  const next = direction === "next";
  const Arrow = next ? ArrowRightIcon : ArrowLeftIcon;

  return (
    <Link
      href={page.href}
      className={`group flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line bg-ink-900/40 px-4 py-3.5 transition-colors hover:border-line-strong hover:bg-ink-850 ${
        next ? "flex-row-reverse text-right" : ""
      }`}
    >
      <Arrow className="h-4 w-4 shrink-0 text-neutral-600 transition-colors group-hover:text-indigo-300" />
      <span className="min-w-0">
        <span className="block text-[11px] text-neutral-500">
          {next ? "Next" : "Previous"} ({page.section})
        </span>
        <span className="block truncate text-[14px] font-medium text-neutral-200 transition-colors group-hover:text-white">
          {page.title}
        </span>
      </span>
    </Link>
  );
}

export function PageNav({
  previous,
  next,
  origin,
}: {
  previous?: DocPage;
  next?: DocPage;
  origin: string;
}) {
  const machineFiles = [
    { name: "llms.txt", href: `${origin}/documentation/llms.txt` },
    { name: "llms-full.txt", href: `${origin}/documentation/llms-full.txt` },
    { name: "openapi.json", href: `${origin}/documentation/openapi.json` },
    { name: "AGENTS.md", href: `${origin}/documentation/AGENTS.md` },
  ];

  return (
    <footer className="mt-14">
      {previous === undefined && next === undefined ? null : (
        <div className="flex flex-col gap-3 sm:flex-row">
          {previous === undefined ? (
            // A spacer, so a page with only a next card keeps it on the right
            // rather than sliding it under the title column.
            <span className="hidden flex-1 sm:block" />
          ) : (
            <NavCard page={previous} direction="previous" />
          )}
          {next === undefined ? (
            <span className="hidden flex-1 sm:block" />
          ) : (
            <NavCard page={next} direction="next" />
          )}
        </div>
      )}

      <div className="mt-10 border-t border-line pt-5">
        <p className="mb-2.5 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
          Read this as plain text
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {machineFiles.map((file) => (
            <a
              key={file.name}
              href={file.href}
              className="inline-flex items-center gap-1 font-mono text-[12px] text-indigo-300 transition-colors hover:text-indigo-200"
            >
              {file.name}
              <ArrowUpRightIcon className="h-3 w-3" />
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}

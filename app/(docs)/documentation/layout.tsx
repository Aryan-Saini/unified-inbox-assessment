import Link from "next/link";
import { Logo } from "../../Logo";
import { KeyIcon } from "../../(inbox)/icons";
import { BookGlyph } from "./docs-icons";
import { DocsSidebar, MobileNav } from "./DocsNav";
import { docSections } from "./pages";
import { docsOrigin } from "./origin";

/**
 * The documentation shell: a full-width header and a fixed sidebar, with the
 * page rendered beside it.
 *
 * It lives in a layout rather than in each page so that moving between pages
 * replaces only the content column — the sidebar keeps its scroll position and
 * the header never repaints, which is the difference between a documentation
 * site and a set of pages that happen to look alike.
 *
 * Route handlers are not wrapped by layouts, so `/documentation/llms.txt` and
 * its siblings still serve bare text through this directory.
 */

export const dynamic = "force-dynamic";

export default async function DocumentationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const sections = docSections(await docsOrigin());

  return (
    <div className="min-h-dvh">
      {/* 56px, sticky, the full width of the window. */}
      <header className="sticky top-0 z-40 h-14 border-b border-line bg-ink-950/85 backdrop-blur">
        <div className="flex h-full items-center gap-3 px-4 sm:px-5">
          <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
            <Logo className="h-6 w-6 shrink-0 text-white" />
            <span className="truncate text-[14px] font-semibold tracking-tight text-white">
              Unified Inbox
            </span>
          </Link>
          <Link
            href="/documentation"
            className="hidden items-center gap-1.5 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[11px] font-medium text-indigo-300 transition-colors hover:border-indigo-500/50 sm:flex"
          >
            <BookGlyph className="h-3.5 w-3.5" />
            Docs
          </Link>

          <div className="ml-auto flex items-center gap-2">
            <MobileNav sections={sections} />
            <Link
              href="/dashboard"
              className="flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium text-neutral-300 transition-colors hover:border-neutral-600 hover:text-white"
            >
              <KeyIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Get a key</span>
            </Link>
          </div>
        </div>
      </header>

      <div className="flex">
        <DocsSidebar sections={sections} />
        {children}
      </div>
    </div>
  );
}

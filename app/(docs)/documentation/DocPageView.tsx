import { CopyPageMenu } from "./CopyPageMenu";
import type { DocPage, DocSection } from "./pages";
import { neighbours } from "./pages";
import { PageNav } from "./PageNav";
import { PageBodyView } from "./render";
import { Inline } from "./inline";
import { Toc } from "./Toc";

/**
 * One documentation page: title, body, contents rail, and where to go next.
 *
 * The three-column arrangement is what every reference site converges on, for
 * the same reason each time — the reader is looking something up, so *where
 * they are* (the sidebar, in the layout), *what is on this page* (the rail on
 * the right) and the content itself all have to be on screen together.
 *
 * The right column keeps its width even when a page has nothing to put in it,
 * because a measure that changes between pages makes the whole site feel like
 * it is shifting under the reader.
 */
export function DocPageView({
  page,
  sections,
  origin,
}: {
  page: DocPage;
  sections: DocSection[];
  origin: string;
}) {
  const { previous, next } = neighbours(sections, page.slug);

  return (
    // `min-w-0`: the code blocks inside are unbreakable, and a flex child will
    // not shrink below its widest content without it.
    <div className="min-w-0 flex-1">
      <div className="mx-auto flex w-full max-w-[74rem] gap-10 px-5 sm:px-8">
        <main className="min-w-0 max-w-[50rem] flex-1 pb-20">
          <div className="pt-9">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="min-w-0 text-[30px] leading-tight font-semibold tracking-tight text-white">
                {page.title}
              </h1>
              {/* The page's own actions sit level with its title, which puts
                  "take the markdown instead" within reach before any prose is
                  read — the cheapest correct action for an agent that landed
                  on the HTML is also the most obvious one. */}
              <div className="shrink-0 pt-1">
                <CopyPageMenu origin={origin} />
              </div>
            </div>
            {page.blurb === "" ? null : (
              <p className="mt-2 max-w-[46rem] text-[15px] leading-relaxed text-neutral-400">
                <Inline text={page.blurb} />
              </p>
            )}
          </div>

          <hr className="mt-6 mb-2 border-t border-line" />

          <PageBodyView body={page.body} origin={origin} />

          <PageNav previous={previous} next={next} origin={origin} />
        </main>

        <aside className="hidden w-[236px] shrink-0 xl:block">
          <div className="sticky top-14 max-h-[calc(100dvh-3.5rem)] overflow-y-auto">
            <Toc entries={page.toc} />
          </div>
        </aside>
      </div>
    </div>
  );
}

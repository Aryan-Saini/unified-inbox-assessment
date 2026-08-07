import { notFound } from "next/navigation";
import { Stress } from "./Stress";

/**
 * `/ui-stress?scene=…` — the screenshot harness, development only.
 *
 * 404s outside `next dev` so it cannot ship: it renders internal components
 * against fixtures and has no auth gate of its own.
 */
export default async function UiStressPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { scene } = await searchParams;
  return <Stress scene={typeof scene === "string" ? scene : "results"} />;
}

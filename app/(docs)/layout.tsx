import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "../globals.css";

/**
 * A fourth root layout, for the public API documentation.
 *
 * Deliberately has neither Clerk nor Convex. The documentation describes a
 * public interface and carries no user data, so requiring a session to read it
 * would put the instructions for getting a credential behind the credential —
 * and would stop an agent, a crawler or a reviewer with a `curl` from reading
 * them at all.
 *
 * It shares `globals.css` with the app rather than carrying a palette of its
 * own: the docs are part of this product, so `ink-*`, `line`, the indigo accent
 * and the Inter/JetBrains pair are the same tokens the inbox shell uses. The one thing
 * it does differently is scroll the document — the shell owns its viewport and
 * manages its own panes, which is right for an app and wrong for a long page of
 * prose.
 */

const interSans = Inter({ variable: "--font-inter", subsets: ["latin"] });
const monoFace = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "API documentation — Unified Inbox",
  description:
    "Search Gmail, Slack and the web from one place, and send replies only after an explicit confirmation step. REST reference, with machine-readable copies for agents.",
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  width: "device-width",
  initialScale: 1,
};

export default function DocsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // No `scroll-behavior: smooth`. Anchors here are jumps to a heading on a
    // page the reader is already on, and animating them costs real time on the
    // longer reference pages for nothing. Jumping is what a contents rail is for.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${interSans.variable} ${monoFace.variable} antialiased`}
    >
      {/* `overflow-y-auto` undoes the shell's rule that the page never scrolls:
          `globals.css` sets that for the app, and this is the one route where
          the document itself is the scroll container. */}
      <body suppressHydrationWarning className="bg-ink-950 text-white">
        {children}
      </body>
    </html>
  );
}

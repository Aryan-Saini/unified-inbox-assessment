import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "../globals.css";
import "./docs.css";

/**
 * A fourth root layout, for the public API documentation.
 *
 * Deliberately has neither Clerk nor Convex. The documentation describes a
 * public interface and carries no user data, so requiring a session to read it
 * would put the instructions for getting a credential behind the credential —
 * and would stop an agent, a crawler or a reviewer with a `curl` from reading
 * them at all.
 *
 * It is also the one part of this app that is not dark-only, and the one that
 * scrolls the document rather than an inner pane: the inbox shell owns the
 * viewport and manages its own scrolling, which is right for an app and wrong
 * for a long page of prose.
 */

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "API documentation — Unified Inbox",
  description:
    "Search Gmail, Slack and the web from one place, and send replies only after an explicit confirmation step. REST reference, with machine-readable copies for agents.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * Resolve the theme before first paint.
 *
 * It has to be a blocking inline script: the choice lives in `localStorage`,
 * which the server cannot see, so a React effect would necessarily paint the
 * wrong theme first. On a docs page that is a full-screen white flash for
 * someone who chose dark — the exact reason every documentation site that
 * offers a toggle does this.
 *
 * `auto` is the default and writes nothing, so the CSS media query decides.
 */
const THEME_SCRIPT = `(function(){try{
var s=localStorage.getItem("docs-theme");
var m=window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.setAttribute("data-docs-theme",
  s==="light"||s==="dark"?s:(m?"dark":"light"));
}catch(e){}})();`;

export default function DocsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      // The server renders `light` and the script above corrects it before
      // paint. `suppressHydrationWarning` covers exactly that one attribute.
      data-docs-theme="light"
      suppressHydrationWarning
      // No `scroll-behavior: smooth`. The reference page is ~31,000px tall, so
      // a rail click near the bottom animates through twenty screens of content
      // — seconds of motion, and a blur for anyone who is sensitive to it.
      // Jumping is what a table of contents is *for*.
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body suppressHydrationWarning className="d-screen">
        {children}
      </body>
    </html>
  );
}

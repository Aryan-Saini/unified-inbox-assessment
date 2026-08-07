import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
 * It is also the one part of this app that scrolls the document rather than an
 * inner pane: the inbox shell owns the viewport and manages its own scrolling,
 * which is right for an app and wrong for a long page of prose.
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
  themeColor: "#08090a",
  width: "device-width",
  initialScale: 1,
};

export default function DocsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} antialiased [scroll-behavior:smooth]`}
    >
      <body suppressHydrationWarning className="bg-ink-950 text-white">
        {children}
      </body>
    </html>
  );
}

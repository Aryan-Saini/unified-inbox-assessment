import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "../globals.css";

/**
 * A second root layout (Next.js allows one per route group).
 *
 * The inbox shell owns the full viewport and has no chrome of its own, so it
 * deliberately skips the auth header — and, being UI-only, skips the Clerk and
 * Convex providers too. `/sign-in` keeps those in `app/(auth)/layout.tsx`.
 */

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Unified Inbox — one search, every inbox",
  description: "Search Gmail, Slack and the web from one place.",
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  // The shell manages its own scrolling; letting the page zoom-scroll would
  // fight the fixed layout on mobile.
  width: "device-width",
  initialScale: 1,
};

export default function InboxLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden bg-ink-950 text-white">
        {children}
      </body>
    </html>
  );
}

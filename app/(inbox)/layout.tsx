import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "../ConvexClientProvider";
import { StoreUser } from "../StoreUser";
import "../globals.css";

/**
 * A second root layout (Next.js allows one per route group).
 *
 * The inbox shell owns the full viewport and has no chrome of its own, so it
 * deliberately skips the auth header that `app/(auth)/layout.tsx` renders — but
 * it needs the same Clerk and Convex providers, because the shell reads its
 * searches, connections and sends from live Convex subscriptions.
 */

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Unified Inbox: one search, every inbox",
  description: "Search Gmail, Slack and The Web from one place.",
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
    // See the note in `app/(auth)/layout.tsx` — same two suppressions, same
    // reason: these attributes are constants, so the only mismatch they can
    // absorb is one the browser introduced.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        suppressHydrationWarning
        className="h-full overflow-hidden bg-ink-950 text-white"
      >
        {/* Clerk v7 places ClerkProvider inside <body>, not around <html>. */}
        <ClerkProvider>
          <ConvexClientProvider>
            <StoreUser />
            {children}
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

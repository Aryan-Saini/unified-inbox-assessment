import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ClerkSetActiveGuard } from "../ClerkSetActiveGuard";
import { ConvexClientProvider } from "../ConvexClientProvider";
import "../globals.css";

/**
 * A second root layout (Next.js allows one per route group).
 *
 * The inbox shell owns the full viewport and has no chrome of its own, so it
 * deliberately skips the auth header that `app/(auth)/layout.tsx` renders — but
 * it needs the same Clerk and Convex providers, because the shell reads its
 * searches, connections and sends from live Convex subscriptions.
 */

const interSans = Inter({ variable: "--font-inter", subsets: ["latin"] });
const monoFace = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
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
      className={`${interSans.variable} ${monoFace.variable} h-full antialiased`}
    >
      <body
        suppressHydrationWarning
        className="h-full overflow-hidden bg-ink-950 text-white"
      >
        {/* Clerk v7 places ClerkProvider inside <body>, not around <html>. */}
        <ClerkProvider>
          {/* Has to sit inside the provider: it wraps a hook the provider
              installs. See `app/ClerkSetActiveGuard.tsx`. */}
          <ClerkSetActiveGuard />
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "../globals.css";

/**
 * A third root layout, for the screenshot harness under `/ui-stress`.
 *
 * Deliberately has neither Clerk nor the real Convex provider: the harness
 * renders components against fixed props so a layout regression can be captured
 * on a machine with no deployment, no OAuth grant and no session. Everything it
 * shows is a pure function of the fixtures in `stress-fixtures.ts`.
 */

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "UI stress harness",
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  width: "device-width",
  initialScale: 1,
};

export default function DevLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        suppressHydrationWarning
        className="h-full overflow-hidden bg-ink-950 text-white"
      >
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "../ConvexClientProvider";
import { Logo } from "../Logo";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Unified Inbox",
  description: "Search Gmail, Slack and The Web from one place.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Both suppressions are one level deep — this element's own attributes, not
    // the tree under it — and every attribute here is a compile-time constant,
    // so there is nothing of ours they can hide. What they cover is the other
    // party to hydration: a phone browser or an extension that writes onto
    // `<html>` or `<body>` before React runs, which is the whole of "a tree
    // hydrated but some attributes of the server rendered HTML didn't match".
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body
        suppressHydrationWarning
        className="flex min-h-full flex-col bg-black text-white"
      >
        {/* Clerk v7 places ClerkProvider inside <body>, not around <html>. */}
        <ClerkProvider>
          <ConvexClientProvider>
            {/* The user row is not upserted here: `/auth` reads nothing from
                the backend, and a signed-in visitor is redirected to the
                dashboard, where `AuthGate` issues the row before anything
                mounts. */}
            {/* No sign-out here any more: this group only serves `/auth`, and a
                signed-in visitor is redirected off it before anything renders.
                Signing out lives in the shell's sidebar instead. */}
            <header className="flex items-center px-6 py-5">
              <Logo className="h-8 w-8 text-white" />
            </header>
            {children}
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

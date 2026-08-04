import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider, Show, SignOutButton } from "@clerk/nextjs";
import { ConvexClientProvider } from "../ConvexClientProvider";
import { Logo } from "../Logo";
import { StoreUser } from "../StoreUser";
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
  description: "Search Gmail, Slack and the web from one place.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-black text-white">
        {/* Clerk v7 places ClerkProvider inside <body>, not around <html>. */}
        <ClerkProvider>
          <ConvexClientProvider>
            <StoreUser />
            <header className="flex items-center justify-between px-6 py-5">
              <Logo className="h-8 w-8 text-white" />
              <Show when="signed-in">
                <SignOutButton>
                  <button className="rounded-md border border-neutral-800 px-3.5 py-2 text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-600 hover:text-white">
                    Sign Out
                  </button>
                </SignOutButton>
              </Show>
            </header>
            {children}
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}

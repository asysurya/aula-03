import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { AppProviders } from "@/components/providers/app-providers";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/constants";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${APP_NAME} — Forum Diskusi Kelas`,
  description: APP_DESCRIPTION,
  keywords: ["forum", "kelas", "diskusi", "tugas", "cloud", "chat"],
  authors: [{ name: APP_NAME }],
  icons: { icon: "/logo.svg" },
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: APP_NAME,
    description: APP_DESCRIPTION,
    type: "website",
  },
};

// PWA: warna tema chrome (terang/gelap) — selaras globals.css
// (light oklch(0.99 0.004 160) ≈ #f9fdfb, dark oklch(0.235 0.006 170) ≈ #1b1f1e).
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9fdfb" },
    { media: "(prefers-color-scheme: dark)", color: "#1b1f1e" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen`}
      >
        <AppProviders>
          {children}
          <Toaster />
          <SonnerToaster richColors position="top-center" />
        </AppProviders>
      </body>
    </html>
  );
}

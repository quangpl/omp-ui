import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: "AgentMan", template: "%s · AgentMan" },
  description: "Self-hosted kanban board for running and steering omp coding agents.",
  applicationName: "AgentMan",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: "AgentMan", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0e" },
  ],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Persisted by the sidebar itself (components/ui/sidebar.tsx); expanded unless collapsed before.
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return (
    <html lang="en" className={cn("font-sans", geist.variable, geistMono.variable)} suppressHydrationWarning>
      <body>
        <Providers>
          <AppShell defaultOpen={sidebarOpen}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}

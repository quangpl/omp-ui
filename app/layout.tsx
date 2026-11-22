import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { getRepo } from "@/lib/db";
import { DEFAULT_PRIMARY_COLOR, PRIMARY_COLOR_CSS, type PrimaryColorId } from "@/lib/primary-colors";
import { getAppSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: "OMP-UI", template: "%s · OMP-UI" },
  description:
    "Self-hosted web UI for the omp AI coding agent: a kanban board where cards become live agent runs in your repos, with pull requests, schedulers and stats.",
  keywords: ["omp", "oh-my-pi", "AI coding agent", "kanban", "self-hosted", "agent UI", "pull requests"],
  authors: [{ name: "quang" }],
  openGraph: {
    type: "website",
    siteName: "OMP-UI",
    title: "OMP-UI",
    description: "Self-hosted web UI for the omp AI coding agent: kanban board, live agent runs, PRs.",
    images: ["/icon.png"],
  },
  twitter: {
    card: "summary",
    title: "OMP-UI",
    description: "Self-hosted web UI for the omp AI coding agent: kanban board, live agent runs, PRs.",
    images: ["/icon.png"],
  },
  applicationName: "OMP-UI",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: "OMP-UI", statusBarStyle: "default" },
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

/** The saved primary color preset; the default when settings cannot be read (never breaks rendering). */
async function readPrimaryColor(): Promise<PrimaryColorId> {
  try {
    return (await getAppSettings(await getRepo())).primaryColor;
  } catch {
    return DEFAULT_PRIMARY_COLOR;
  }
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const [cookieStore, primaryColor] = await Promise.all([cookies(), readPrimaryColor()]);
  // Persisted by the sidebar itself (components/ui/sidebar.tsx); expanded unless collapsed before.
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";
  return (
    <html
      lang="en"
      className={cn("font-sans", geist.variable, geistMono.variable)}
      data-primary={primaryColor}
      suppressHydrationWarning
    >
      <head>
        <style dangerouslySetInnerHTML={{ __html: PRIMARY_COLOR_CSS }} />
      </head>
      <body>
        <Providers>
          <AppShell defaultOpen={sidebarOpen}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}

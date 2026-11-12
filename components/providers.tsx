"use client";

import { ThemeProvider } from "next-themes";
import { NewCardProvider } from "@/components/new-card";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        <NewCardProvider>{children}</NewCardProvider>
        <Toaster
          position="top-center"
          offset={{ top: "calc(16px + env(safe-area-inset-top))" }}
          mobileOffset={{ top: "calc(12px + env(safe-area-inset-top))" }}
        />
      </TooltipProvider>
    </ThemeProvider>
  );
}

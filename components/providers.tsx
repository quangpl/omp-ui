"use client";

import { ThemeProvider } from "next-themes";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardHelpDialog } from "@/components/keyboard-help";
import { NewCardProvider } from "@/components/new-card";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        <NewCardProvider>
          {children}
          <CommandPalette />
          <KeyboardHelpDialog />
        </NewCardProvider>
        <Toaster
          position="top-center"
          offset={{ top: "calc(16px + env(safe-area-inset-top))" }}
          mobileOffset={{ top: "calc(12px + env(safe-area-inset-top))" }}
        />
      </TooltipProvider>
    </ThemeProvider>
  );
}

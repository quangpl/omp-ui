"use client";

import { ThemeProvider } from "next-themes";
import { usePathname } from "next/navigation";
import { AttachmentViewer } from "@/components/attachment-viewer";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardHelpDialog } from "@/components/keyboard-help";
import { NewCardProvider } from "@/components/new-card";
import { RestartServerDialog } from "@/components/restart-server";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGoHotkeys } from "@/hooks/use-go-hotkeys";

/** `G` then … navigation everywhere except the login page. */
function GoHotkeys() {
  useGoHotkeys(usePathname() !== "/login");
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        <NewCardProvider>
          {children}
          <CommandPalette />
          <KeyboardHelpDialog />
          <GoHotkeys />
          <RestartServerDialog />
          <AttachmentViewer />
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

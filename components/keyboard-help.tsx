"use client";

import { type ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { isPlainKey } from "@/lib/hotkeys";

const KEYBOARD_HELP_EVENT = "omp-ui:keyboard-help";

/** Ask the global help dialog (mounted in `Providers`) to open. */
export function openKeyboardHelp(): void {
  window.dispatchEvent(new Event(KEYBOARD_HELP_EVENT));
}

function Row({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="text-sm text-muted-foreground">{children}</span>
      <KbdGroup className="shrink-0">
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Global "?" cheat sheet of every keyboard shortcut. */
export function KeyboardHelpDialog() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const signedOut = pathname === "/login";

  useEffect(() => {
    if (signedOut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainKey(event, "?")) return;
      event.preventDefault();
      setOpen(true);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(KEYBOARD_HELP_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(KEYBOARD_HELP_EVENT, onOpen);
    };
  }, [signedOut]);

  const mod = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌘" : "Ctrl";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Drive the whole board without the mouse.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          <Group title="Everywhere">
            <Row keys={[mod, "K"]}>Command palette</Row>
            <Row keys={["/"]}>Command palette</Row>
            <Row keys={["N"]}>New card</Row>
            <Row keys={["⇧", "N"]}>New card, start agent now</Row>
            <Row keys={["?"]}>This cheat sheet</Row>
          </Group>
          <Group title="Board">
            <Row keys={["↑", "↓", "J", "K"]}>Previous / next card</Row>
            <Row keys={["←", "→", "H", "L"]}>Column left / right</Row>
            <Row keys={["↵"]}>Open focused card</Row>
            <Row keys={["Space"]}>Pick up / drop card (↑ ↓ reorder in the column)</Row>
            <Row keys={["⇧", "F10"]}>Card actions menu</Row>
          </Group>
          <Group title="Focused card">
            <Row keys={["R"]}>Start / resume / retry agent</Row>
            <Row keys={["S"]}>Stop agent</Row>
            <Row keys={["Z"]}>Revert card to To do</Row>
            <Row keys={["D"]}>Duplicate</Row>
            <Row keys={["⌫"]}>Delete…</Row>
          </Group>
          <Group title="Card panel">
            <Row keys={["J", "K"]}>Next / previous card</Row>
            <Row keys={[mod, "↵"]}>Send feedback / save text</Row>
            <Row keys={["Esc"]}>Close panel (or leave the field)</Row>
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  );
}

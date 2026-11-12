"use client";

/**
 * Shared guards for app-wide keyboard shortcuts.
 *
 * Single-letter hotkeys (N, R, J/K…) must never fire while the user types or
 * drives a menu/list with the keyboard; `isTypingTarget` is that gate.
 */

/** True while the user types in a field or drives a menu/list with the keyboard. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="listbox"], [role="combobox"]',
    ),
  );
}

/** True while a modal (dialog, sheet, drawer, alert) is open; board hotkeys stay quiet then. */
export function isModalOpen(): boolean {
  return document.querySelector('[data-state="open"][role="dialog"], [role="alertdialog"]') !== null;
}

/** True for a plain (no Ctrl/Meta/Alt) non-repeated press of `key`, outside text fields. */
export function isPlainKey(event: KeyboardEvent, key: string): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key !== key) return false;
  return !isTypingTarget(event.target);
}

/** True on Apple platforms, where the primary shortcut modifier is ⌘ rather than Ctrl. */
export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

/** Label of the primary shortcut modifier: "⌘" on Apple platforms, "Ctrl" elsewhere. */
export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

export interface KeySequenceOptions {
  /** Plain key that starts the sequence (e.g. "g"). */
  leader: string;
  /** Second key (lowercase) → action. Any other key cancels the sequence and passes through. */
  bindings: Readonly<Record<string, () => void>>;
  /** How long the sequence waits for its second key. */
  timeoutMs?: number;
  /** The leader was pressed; the sequence now waits for its second key. */
  onPending?: () => void;
  /** The sequence ended: completed, cancelled by another key, Esc, or the timeout. */
  onEnd?: () => void;
}

export interface KeySequence {
  /** Feed every keydown here; register it in the capture phase so a consumed key reaches no one else. */
  handleKeyDown: (event: KeyboardEvent) => void;
  /** Drop a pending sequence (e.g. on unmount or navigation). */
  cancel: () => void;
}

/**
 * Two-key sequence such as `G` then `P`. The leader starts it only as a plain press outside text
 * fields and modals; the next plain key runs its binding within `timeoutMs`. A consumed second key
 * (or Esc while pending) is `preventDefault`ed and stopped, so single-key board hotkeys never see it.
 */
export function createKeySequence({
  leader,
  bindings,
  timeoutMs = 1200,
  onPending,
  onEnd,
}: KeySequenceOptions): KeySequence {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    onEnd?.();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (timer === null) {
      if (!isPlainKey(event, leader) || isModalOpen()) return;
      event.preventDefault();
      timer = setTimeout(cancel, timeoutMs);
      onPending?.();
      return;
    }
    if (event.isComposing || MODIFIER_KEYS.has(event.key)) return;
    cancel();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target) || isModalOpen()) return;
    const action = bindings[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    action();
  };

  return { handleKeyDown, cancel };
}

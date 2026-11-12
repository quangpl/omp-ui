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

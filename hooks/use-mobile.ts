import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches
}

/**
 * True below 768px. Hydration-safe: hydrating components start from the server value and are
 * corrected before paint, while components mounted later (dialogs, client navigations) read the
 * real viewport on their first render instead of flipping after an effect.
 */
export function useIsMobile() {
  // The server never knows the viewport; hydration starts from "desktop", like the server markup.
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}

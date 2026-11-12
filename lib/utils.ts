export { cn } from "cn"

/** Copy to the clipboard; throws when the browser refuses. */
export async function copyText(text: string): Promise<void> {
  // navigator.clipboard needs a secure context; self-hosted servers are often plain http on a LAN.
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand("copy")
  area.remove()
  if (!ok) throw new Error("Copy failed")
}

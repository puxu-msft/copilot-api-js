/** True when focus is in a text input / textarea / contenteditable — used to
 *  suppress global keyboard shortcuts while the user is typing. */
export function isTyping(): boolean {
  const el = document.activeElement
  if (!el) return false
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable
}

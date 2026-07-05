/**
 * Copy `text` to the clipboard, returning whether it succeeded.
 *
 * Prefers the async Clipboard API (secure contexts, incl. `http://localhost`); when it is
 * unavailable — e.g. the tool opened over a plain-HTTP LAN address where `navigator.clipboard`
 * is `undefined` — it falls back to a hidden-`<textarea>` + `execCommand("copy")`. Any failure
 * resolves to `false` so callers surface a neutral "copy failed" state rather than throwing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    // navigator/clipboard are typed non-nullable but absent at runtime outside a
    // secure context — widen to optional so the guards are honest (and lint-clean).
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard
    if (clip) {
      await clip.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy fallback
  }
  return legacyCopy(text)
}

/** Deprecated `execCommand("copy")` path for non-secure contexts; best-effort, never throws. */
function legacyCopy(text: string): boolean {
  try {
    const doc = globalThis.document as Document | undefined
    if (!doc?.body) return false
    const ta = doc.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    doc.body.append(ta)
    ta.select()
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional legacy path for non-secure contexts where navigator.clipboard is undefined
    const ok = doc.execCommand("copy")
    ta.remove()
    return ok
  } catch {
    return false
  }
}

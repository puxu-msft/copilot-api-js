/**
 * Copy `text` to the clipboard, returning whether it succeeded.
 *
 * Uses the async Clipboard API (available in secure contexts, incl. `http://localhost`).
 * Any failure — missing API, rejected permission — resolves to `false` so callers can
 * surface a neutral "copy failed" state rather than throwing.
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
    // fall through to failure
  }
  return false
}

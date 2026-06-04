import { useClipboard } from "@vueuse/core"

import { useToast } from "./useToast"

export function useCopyToClipboard() {
  const { show } = useToast()
  const { copy: clipboardCopy, isSupported } = useClipboard()

  async function copy(text: string, label = "Copied!") {
    if (!isSupported.value) {
      show("Clipboard not supported", "error")
      return
    }
    try {
      await clipboardCopy(text)
      show(label, "success")
    } catch {
      show("Copy failed", "error")
    }
  }

  return { copy }
}
